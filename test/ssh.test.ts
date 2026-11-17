import * as assert from 'assert';
import { execFileSync, spawn } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { registerCommands } from '../src/commands';
import {
  BoxliteRestSshClient,
  BoxliteSshCli,
  buildCliContextName,
  classifyCliOutputError,
  CliRunner,
  ensureBoxKeyBundle,
  ExecResult,
  generateEd25519KeyPair,
  LocalForwarderManager,
  LocalTunnelBroker,
  parseCapabilitiesFromHelp,
  parseSetupOutput,
  parseStatusOutput,
  publicKeysMatch,
  redactSensitiveText,
  removeAllManagedBlocks,
  removeBlock,
  sanitizeAlias,
  SshCliError,
  SshConfigFileManager,
  SshService,
  SshStore,
  tokenizeCommand,
  upsertBlock,
  validateBoxId,
  validateParsedSetup,
  writePinnedKnownHosts
} from '../src/ssh';
import { BoxTreeItem } from '../src/tree/nodes';

describe('Cloud SSH Access', () => {
  const repoRoot = path.resolve(__dirname, '../..');
  const fixturesDir = path.join(repoRoot, 'test', 'fixtures', 'ssh');

  describe('parse.ts', () => {
    it('tokenizes commands with quoted ProxyCommand and Windows paths', () => {
      const cmd =
        'ssh -i "C:\\Users\\Alice Smith\\.boxlite\\key" -o ProxyCommand="boxlite --context vscode-1 tunnel box_1" boxlite@0.0.0.0';
      const tokens = tokenizeCommand(cmd);
      assert.deepStrictEqual(tokens, [
        'ssh',
        '-i',
        'C:\\Users\\Alice Smith\\.boxlite\\key',
        '-o',
        'ProxyCommand=boxlite --context vscode-1 tunnel box_1',
        'boxlite@0.0.0.0'
      ]);
    });

    it('parses POSIX setup output fixture accurately', () => {
      const fixture = fs.readFileSync(path.join(fixturesDir, 'setup-posix.txt'), 'utf-8');
      const parsed = parseSetupOutput(fixture);
      assert.strictEqual(parsed.keyPath, '/home/alice/.boxlite/ssh/box_01JXYZ1234567890/id_ed25519');
      assert.strictEqual(parsed.fingerprint, 'SHA256:AbCdEfGhIjKlMnOpQrStUvWxYz0123456789+/ABCD');
      assert.strictEqual(parsed.sshBin, 'ssh');
      assert.strictEqual(
        parsed.proxyCommand,
        'boxlite --context vscode-key1 network tunnel --stdio box_01JXYZ1234567890 22'
      );
      assert.strictEqual(parsed.user, 'boxlite');
      assert.strictEqual(parsed.host, '0.0.0.0');

      const valid = validateParsedSetup(parsed, () => true);
      assert.strictEqual(valid.valid, true);
    });

    it('parses Windows setup output fixture with spaces in key path', () => {
      const fixture = fs.readFileSync(path.join(fixturesDir, 'setup-windows.txt'), 'utf-8');
      const parsed = parseSetupOutput(fixture);
      assert.strictEqual(parsed.keyPath, 'C:\\Users\\Alice Smith\\.boxlite\\ssh\\box_01JXYZ1234567890\\id_ed25519');
      assert.strictEqual(parsed.fingerprint, 'SHA256:WinKeyFingerprint1234567890ABCDEF');
      assert.ok(parsed.proxyCommand?.includes('boxlite --context vscode-key1'));
      assert.strictEqual(validateParsedSetup(parsed, () => true).valid, true);
    });

    it('parses JSON setup output fast path when available', () => {
      const fixture = fs.readFileSync(path.join(fixturesDir, 'setup-json.json'), 'utf-8');
      const parsed = parseSetupOutput(fixture);
      assert.strictEqual(parsed.keyPath, '/home/alice/.boxlite/ssh/box_01JXYZ1234567890/id_ed25519');
      assert.strictEqual(parsed.fingerprint, 'SHA256:JsonFingerprint9876543210');
      assert.ok(parsed.proxyCommand?.includes('box_01JXYZ1234567890'));
    });

    it('rejects validation when key file is missing or ProxyCommand absent', () => {
      const parsed = parseSetupOutput('ssh boxlite@0.0.0.0');
      const res = validateParsedSetup(parsed, () => false);
      assert.strictEqual(res.valid, false);
      assert.ok(res.errors.some((e) => e.includes('ProxyCommand')));
    });

    it('parses ssh --status output across disabled, enabled, not configured, and JSON', () => {
      const disabledFixture = fs.readFileSync(path.join(fixturesDir, 'status-disabled.txt'), 'utf-8');
      const disabled = parseStatusOutput(disabledFixture);
      assert.strictEqual(disabled.enabled, false);
      assert.strictEqual(disabled.configured, true);
      assert.strictEqual(disabled.fingerprint, 'SHA256:AbCdEfGhIjKlMnOpQrStUvWxYz0123456789+/ABCD');

      const enabled = parseStatusOutput('SSH is enabled\nFingerprint: SHA256:XYZ');
      assert.strictEqual(enabled.enabled, true);
      assert.strictEqual(enabled.fingerprint, 'SHA256:XYZ');

      const unconfigured = parseStatusOutput('SSH is not configured for this box.');
      assert.strictEqual(unconfigured.configured, false);
      assert.strictEqual(unconfigured.enabled, false);

      const jsonStatus = parseStatusOutput('{"enabled":true,"fingerprint":"SHA256:JSON1"}');
      assert.strictEqual(jsonStatus.enabled, true);
      assert.strictEqual(jsonStatus.fingerprint, 'SHA256:JSON1');
    });

    it('probes --json flag from help output', () => {
      assert.deepStrictEqual(parseCapabilitiesFromHelp('Usage: boxlite ssh [OPTIONS] <BOX>\n  --json  Output JSON'), {
        hasJsonFlag: true,
        jsonFlag: '--json'
      });
      assert.deepStrictEqual(parseCapabilitiesFromHelp('Usage: boxlite ssh <BOX>'), {
        hasJsonFlag: false
      });
    });

    it('validates box IDs safely and redacts secrets/paths', () => {
      assert.strictEqual(validateBoxId('box_01JXYZ-123.abc'), 'box_01JXYZ-123.abc');
      assert.throws(() => validateBoxId(''));
      assert.throws(() => validateBoxId('--help'));
      assert.throws(() => validateBoxId('box 1; rm -rf /'));

      const redacted = redactSensitiveText(
        'auth blk_live_secret12345 with Bearer mytok123 key=/tmp/id_ed25519',
        ['/tmp/id_ed25519']
      );
      assert.strictEqual(redacted.includes('blk_live_secret12345'), false);
      assert.strictEqual(redacted.includes('mytok123'), false);
      assert.strictEqual(redacted.includes('/tmp/id_ed25519'), false);
      assert.ok(redacted.includes('<key-path>'));
    });
  });

  describe('sshStore.ts', () => {
    function createMockGlobalState() {
      const map = new Map<string, unknown>();
      return {
        get: <T>(k: string) => map.get(k) as T | undefined,
        update: async (k: string, v: unknown) => {
          map.set(k, v);
        }
      };
    }

    it('keys entries by orgContext:boxId and checks key file existence', async () => {
      const existingFiles = new Set<string>(['/keys/box1']);
      const store = new SshStore(
        { globalState: createMockGlobalState() } as any,
        (p) => existingFiles.has(p)
      );

      await store.set('vscode-k1', {
        boxId: 'box1',
        contextName: 'vscode-k1',
        keyPath: '/keys/box1',
        fingerprint: 'SHA256:AAA',
        sshBin: 'ssh',
        sshArgs: ['-i', '/keys/box1', 'boxlite@0.0.0.0'],
        sshCommand: 'ssh -i /keys/box1 boxlite@0.0.0.0',
        configuredAt: '2026-11-15T00:00:00.000Z'
      });

      assert.strictEqual(store.hasReadyConfig('vscode-k1', 'box1'), true);
      assert.strictEqual(store.hasReadyConfig('vscode-k2', 'box1'), false);
      assert.strictEqual(store.isBoxSshReadySync('box1', 'vscode-k1'), true);

      // Missing key file treats box as not ready
      existingFiles.delete('/keys/box1');
      assert.strictEqual(store.hasReadyConfig('vscode-k1', 'box1'), false);
    });

    it('tracks logged-in contexts without storing raw API keys', async () => {
      const gs = createMockGlobalState();
      const store = new SshStore({ globalState: gs } as any, () => true);
      await store.markContextLoggedIn('vscode-k1', 'https://api.boxlite.ai', 'blk_live_supersecret');
      assert.strictEqual(store.isContextLoggedIn('vscode-k1', 'https://api.boxlite.ai', 'blk_live_supersecret'), true);
      assert.strictEqual(store.isContextLoggedIn('vscode-k1', 'https://api.boxlite.ai', 'blk_live_other'), false);
      const serialized = JSON.stringify(gs.get('boxlite.ssh.loggedContexts'));
      assert.strictEqual(serialized.includes('blk_live_supersecret'), false);
    });
  });

  describe('sshConfig.ts', () => {
    it('sanitizes aliases and handles collisions', () => {
      assert.strictEqual(sanitizeAlias('My Web App!', '01ABCDEF9999'), 'boxlite-my-web-app');
      assert.strictEqual(
        sanitizeAlias('My Web App!', '01ABCDEF9999', new Set(['boxlite-my-web-app'])),
        'boxlite-my-web-app-01abcd'
      );
      assert.strictEqual(sanitizeAlias('', '01ABCDEF9999'), 'boxlite-01abcd');
    });

    it('upserts and removes managed blocks without altering unrelated config', () => {
      const userConfig = [
        '# Personal config',
        'Host github.com',
        '  User git',
        '  IdentityFile ~/.ssh/id_github',
        ''
      ].join('\n');

      const first = upsertBlock(userConfig, {
        boxId: 'box_1',
        alias: 'boxlite-api',
        hostName: 'box_1',
        user: 'boxlite',
        identityFile: '/home/alice/.boxlite/id_ed25519',
        proxyCommand: 'boxlite --context vscode-k1 network tunnel --stdio box_1 22'
      });
      assert.strictEqual(first.changed, true);
      assert.ok(first.content.includes('Host github.com'));
      assert.ok(first.content.includes('# >>> boxlite-cloud:box_1 (managed by BoxLite extension) >>>'));
      assert.strictEqual(first.content.includes('StrictHostKeyChecking'), false);

      // Update existing block in-place
      const second = upsertBlock(first.content, {
        boxId: 'box_1',
        alias: 'boxlite-api-v2',
        hostName: 'box_1',
        user: 'boxlite',
        identityFile: '/home/alice/.boxlite/id_ed25519_new',
        proxyCommand: 'boxlite --context vscode-k1 network tunnel --stdio box_1 22'
      });
      assert.ok(second.content.includes('Host boxlite-api-v2'));
      assert.strictEqual(second.content.includes('Host boxlite-api\n'), false);

      // Remove block cleanly
      const removed = removeBlock(second.content, 'box_1');
      assert.strictEqual(removed.removed, true);
      assert.ok(removed.content.includes('Host github.com'));
      assert.strictEqual(removed.content.includes('boxlite-cloud:box_1'), false);

      // Remove all blocks
      const withTwo = upsertBlock(second.content, {
        boxId: 'box_2',
        alias: 'boxlite-two',
        hostName: 'box_2',
        user: 'boxlite',
        identityFile: '/tmp/k2',
        proxyCommand: 'boxlite proxy box_2'
      }).content;
      const cleared = removeAllManagedBlocks(withTwo);
      assert.strictEqual(cleared.removedCount, 2);
      assert.ok(cleared.content.includes('Host github.com'));
      assert.strictEqual(cleared.content.includes('boxlite-cloud:'), false);
    });

    it('creates backup and writes config atomically', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'boxlite-ssh-cfg-'));
      try {
        const cfgPath = path.join(tmpDir, 'ssh', 'config');
        fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
        fs.writeFileSync(cfgPath, 'Host existing\n  HostName example.com\n', 'utf-8');

        const mgr = new SshConfigFileManager(cfgPath);
        mgr.upsertHost({
          boxId: 'box_atomic',
          boxName: 'worker',
          hostName: 'box_atomic',
          user: 'boxlite',
          identityFile: '/tmp/k',
          proxyCommand: 'boxlite proxy box_atomic'
        });

        assert.strictEqual(fs.existsSync(path.join(tmpDir, 'ssh', 'config.boxlite.bak')), true);
        const content = fs.readFileSync(cfgPath, 'utf-8');
        assert.ok(content.includes('Host existing'));
        assert.ok(content.includes('Host boxlite-worker'));
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe('cli.ts', () => {
    it('constructs CLI args safely and passes API key only via stdin', async () => {
      const calls: Array<{ bin: string; args: string[]; stdin?: string }> = [];
      const runner: CliRunner = {
        execFile: async (bin, args, opts): Promise<ExecResult> => {
          calls.push({ bin, args, stdin: opts?.stdin });
          if (args.includes('--version')) {
            return { stdout: 'boxlite 0.11.0', stderr: '', exitCode: 0 };
          }
          if (args.includes('ssh') && args.includes('--help')) {
            return { stdout: 'Usage: boxlite ssh [OPTIONS] <BOX>\n  --json', stderr: '', exitCode: 0 };
          }
          return { stdout: 'ok', stderr: '', exitCode: 0 };
        }
      };

      const cli = new BoxliteSshCli(runner);
      const info = await cli.findBoxliteCli('boxlite');
      assert.strictEqual(info.capabilities.hasJsonFlag, true);
      assert.strictEqual(info.version, '0.11.0');

      const ctx = buildCliContextName('vscode', 'key_1');
      assert.strictEqual(ctx, 'vscode-key_1');

      await cli.cliLogin(info, ctx, 'https://api.boxlite.ai', 'blk_live_secret');
      const loginCall = calls.find((c) => c.args.includes('login'));
      assert.ok(loginCall);
      assert.deepStrictEqual(loginCall.args, [
        '--context',
        'vscode-key_1',
        'auth',
        'login',
        '--url',
        'https://api.boxlite.ai',
        '--api-key-stdin'
      ]);
      assert.strictEqual(loginCall.stdin, 'blk_live_secret');
      assert.strictEqual(loginCall.args.join(' ').includes('blk_live_secret'), false);

      await cli.ensureInbound(info, ctx, 'box_1');
      await cli.revokeTunnel(info, ctx, 'box_1', 22);
      await cli.sshDisable(info, ctx, 'box_1');
      assert.deepStrictEqual(calls[calls.length - 2].args, [
        '--context',
        'vscode-key_1',
        'network',
        'tunnel',
        '--revoke',
        'box_1',
        '22'
      ]);
      assert.deepStrictEqual(calls[calls.length - 1].args, [
        '--context',
        'vscode-key_1',
        'ssh',
        '--disable',
        'box_1'
      ]);
    });

    it('maps preflight and CLI output errors accurately', async () => {
      const enoentRunner: CliRunner = {
        execFile: async () => {
          const e: NodeJS.ErrnoException = new Error('not found');
          e.code = 'ENOENT';
          throw e;
        }
      };
      const cliMissing = new BoxliteSshCli(enoentRunner);
      await assert.rejects(() => cliMissing.findBoxliteCli(), (err: SshCliError) => err.code === 'CLI_NOT_FOUND');

      const unsupportedRunner: CliRunner = {
        execFile: async (_bin, args) => {
          if (args.includes('--version')) {
            return { stdout: 'boxlite 0.9.0', stderr: '', exitCode: 0 };
          }
          return { stdout: '', stderr: "error: unrecognized subcommand 'ssh'", exitCode: 2 };
        }
      };
      const cliOld = new BoxliteSshCli(unsupportedRunner);
      await assert.rejects(
        () => cliOld.findBoxliteCli(),
        (err: SshCliError) => err.code === 'SSH_SUBCOMMAND_UNSUPPORTED'
      );

      assert.strictEqual(classifyCliOutputError({ stdout: '', stderr: '401 Unauthorized', exitCode: 1 }).code, 'AUTH_FAILED');
      assert.strictEqual(classifyCliOutputError({ stdout: '', stderr: 'Box not found', exitCode: 1 }).code, 'BOX_NOT_FOUND');
      assert.strictEqual(classifyCliOutputError({ stdout: '', stderr: 'SSH is disabled', exitCode: 1 }).code, 'SSH_DISABLED');
      assert.strictEqual(
        classifyCliOutputError({ stdout: '', stderr: 'WARNING: UNPROTECTED PRIVATE KEY FILE!', exitCode: 255 }).code,
        'PERMISSION_DENIED_KEY'
      );
      assert.strictEqual(
        classifyCliOutputError({ stdout: '', stderr: 'Permission denied (publickey).', exitCode: 255 }).code,
        'PUBLICKEY_AUTH_FAILED'
      );
    });
  });

  describe('Manifest, Tree & SshService flows', () => {
    it('contributes all SSH commands, settings, and running-only box menus in package.json', () => {
      const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf-8'));
      const cmdIds = new Set((pkg.contributes.commands as Array<{ command: string }>).map((c) => c.command));
      for (const cmd of [
        'boxlite.sshConnect',
        'boxlite.sshSetup',
        'boxlite.sshCopyCommand',
        'boxlite.sshDisable',
        'boxlite.sshOpenRemote',
        'boxlite.sshRemoveConfigEntries'
      ]) {
        assert.ok(cmdIds.has(cmd), `Expected command ${cmd} in package.json`);
      }

      const menus: Array<{ command: string; when?: string }> = pkg.contributes.menus['view/item/context'] || [];
      for (const cmd of ['boxlite.sshConnect', 'boxlite.sshSetup', 'boxlite.sshDisable', 'boxlite.sshOpenRemote']) {
        const entry = menus.find((m) => m.command === cmd);
        assert.ok(entry, `Expected menu entry for ${cmd}`);
        assert.ok(entry.when?.includes('isRunning'), `Expected ${cmd} to be gated on isRunning`);
      }

      const copyEntry = menus.find((m) => m.command === 'boxlite.sshCopyCommand');
      assert.ok(copyEntry?.when?.includes('sshReady'));

      const props = pkg.contributes.configuration.properties;
      assert.ok(props['boxlite.ssh.mode']);
      assert.strictEqual(props['boxlite.ssh.mode'].default, 'sdk');
      assert.ok(props['boxlite.ssh.transport']);
      assert.ok(props['boxlite.ssh.cliPath']);
      assert.ok(props['boxlite.ssh.sshPath']);
      assert.ok(props['boxlite.ssh.contextPrefix']);
      assert.ok(props['boxlite.ssh.manageConfig']);
    });

    it('adds -sshReady suffix to BoxTreeItem contextValue only when configured', () => {
      const notReady = new BoxTreeItem({ id: 'b1', name: 'box-1', status: 'running' }, false);
      const ready = new BoxTreeItem({ id: 'b1', name: 'box-1', status: 'running' }, true);
      assert.strictEqual(notReady.contextValue?.includes('-sshReady'), false);
      assert.strictEqual(ready.contextValue?.includes('-sshReady'), true);
    });

    it('runs connect setup once in CLI mode, opens terminal with array args, reuses terminal, and auto-enables when disabled', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'boxlite-ssh-svc-'));
      const keyFile = path.join(tmpDir, 'id_ed25519');
      fs.writeFileSync(keyFile, 'dummy-key-file', { mode: 0o600 });

      const origShowInfo = vscode.window.showInformationMessage;
      const origShowWarning = vscode.window.showWarningMessage;
      const origCreateTerminal = vscode.window.createTerminal;
      const origGetConfig = vscode.workspace.getConfiguration;

      try {
        (vscode.workspace as any).getConfiguration = () => ({
          get: (key: string, def: any) => (key === 'ssh.mode' ? 'cli' : def),
          update: async () => {}
        });
        const createdTerminals: any[] = [];
        (vscode.window as any).terminals = createdTerminals;
        (vscode.window as any).createTerminal = (opts: any) => {
          const term = {
            name: opts.name,
            creationOptions: opts,
            shown: false,
            show: () => {
              term.shown = true;
            },
            sendText: () => {},
            dispose: () => {
              const idx = createdTerminals.indexOf(term);
              if (idx >= 0) createdTerminals.splice(idx, 1);
            }
          };
          createdTerminals.push(term);
          return term;
        };
        (vscode.window as any).showInformationMessage = async (_msg: string, ...items: any[]) => {
          const labels = items.filter((i) => typeof i === 'string');
          return labels[0];
        };
        (vscode.window as any).showWarningMessage = async (_msg: string, ...items: any[]) => {
          const labels = items.filter((i) => typeof i === 'string');
          return labels[0];
        };

        const cliCalls: string[][] = [];
        let statusCalls = 0;
        const runner: CliRunner = {
          execFile: async (_bin, args) => {
            cliCalls.push(args);
            if (args.includes('--version')) {
              return { stdout: 'boxlite 0.11.0', stderr: '', exitCode: 0 };
            }
            if (args.includes('ssh') && args.includes('--help')) {
              return { stdout: 'Usage: boxlite ssh <BOX>', stderr: '', exitCode: 0 };
            }
            if (args.includes('-V')) {
              return { stdout: '', stderr: 'OpenSSH_9.5p2', exitCode: 0 };
            }
            if (args.includes('-?')) {
              return { stdout: '', stderr: 'usage: ssh-keygen', exitCode: 1 };
            }
            if (args.includes('--status')) {
              statusCalls++;
              return {
                stdout: 'Status: disabled\nFingerprint: SHA256:TESTFP',
                stderr: '',
                exitCode: 0
              };
            }
            if (args.includes('ssh') && !args.includes('--enable') && !args.includes('--disable')) {
              return {
                stdout: [
                  `Private key: ${keyFile}`,
                  'Fingerprint: SHA256:TESTFP',
                  'Copy and run the following command to enter the box:',
                  `ssh -i "${keyFile}" -o ProxyCommand="boxlite --context vscode-k1 network tunnel --stdio box_123 22" boxlite@0.0.0.0`
                ].join('\n'),
                stderr: '',
                exitCode: 0
              };
            }
            return { stdout: 'ok', stderr: '', exitCode: 0 };
          }
        };

        const gsMap = new Map<string, unknown>();
        const mockCtx = {
          subscriptions: [],
          globalState: {
            get: (k: string) => gsMap.get(k),
            update: async (k: string, v: unknown) => {
              gsMap.set(k, v);
            }
          },
          globalStorageUri: { fsPath: tmpDir }
        } as unknown as vscode.ExtensionContext;

        const mockBridge = {
          listBoxes: async () => [{ id: 'box_123', name: 'my-box', status: 'running' }]
        } as any;
        const mockCreds = {
          getApiKey: async () => 'blk_live_abc',
          getActiveKey: async () => ({ id: 'k1', name: 'Default' }),
          getRestUrl: () => 'https://api.boxlite.ai'
        } as any;
        const mockChannel = { appendLine: () => {}, show: () => {} } as any;

        const svc = new SshService(
          mockCtx,
          mockBridge,
          mockCreds,
          mockChannel,
          undefined,
          new BoxliteSshCli(runner),
          new SshStore(mockCtx, (p) => fs.existsSync(p)),
          new SshConfigFileManager(path.join(tmpDir, 'ssh_config')),
          runner
        );

        await svc.connect('box_123', 'my-box');
        assert.strictEqual(createdTerminals.length, 1);
        assert.strictEqual(createdTerminals[0].creationOptions.shellPath, 'ssh');
        assert.deepStrictEqual(createdTerminals[0].creationOptions.shellArgs, [
          '-i',
          keyFile,
          '-o',
          'ProxyCommand=boxlite --context vscode-k1 network tunnel --stdio box_123 22',
          'boxlite@0.0.0.0'
        ]);

        // Reconnect while terminal alive reuses terminal
        await svc.connect('box_123', 'my-box');
        assert.strictEqual(createdTerminals.length, 1);

        // Close terminal and reconnect: should check --status and auto-enable without re-running setup
        createdTerminals[0].dispose();
        (svc as any).activeTerminals.clear();
        const setupCallsBefore = cliCalls.filter(
          (a) => a.includes('ssh') && !a.includes('--help') && !a.includes('--status') && !a.includes('--enable')
        ).length;

        await svc.connect('box_123', 'my-box');
        assert.strictEqual(statusCalls, 1);
        assert.ok(cliCalls.some((a) => a.includes('--enable')));
        const setupCallsAfter = cliCalls.filter(
          (a) => a.includes('ssh') && !a.includes('--help') && !a.includes('--status') && !a.includes('--enable')
        ).length;
        assert.strictEqual(setupCallsAfter, setupCallsBefore);

        // Disable flow: must call revokeTunnel before ssh --disable
        const revokeIdx = cliCalls.length;
        await svc.disable('box_123', 'my-box');
        const disableSlice = cliCalls.slice(revokeIdx);
        const revokeCallIdx = disableSlice.findIndex((a) => a.includes('tunnel') && a.includes('--revoke'));
        const disableCallIdx = disableSlice.findIndex((a) => a.includes('ssh') && a.includes('--disable'));
        assert.ok(revokeCallIdx >= 0 && disableCallIdx > revokeCallIdx, 'Expected revoke before disable');
      } finally {
        (vscode.workspace as any).getConfiguration = origGetConfig;
        (vscode.window as any).showInformationMessage = origShowInfo;
        (vscode.window as any).showWarningMessage = origShowWarning;
        (vscode.window as any).createTerminal = origCreateTerminal;
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('prompts to install Remote-SSH when missing and opens remote window when installed (CLI mode)', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'boxlite-remote-ssh-'));
      const keyFile = path.join(tmpDir, 'id_ed25519');
      fs.writeFileSync(keyFile, 'dummy', { mode: 0o600 });

      const origGetExt = vscode.extensions.getExtension;
      const origExecCmd = vscode.commands.executeCommand;
      const origShowInfo = vscode.window.showInformationMessage;
      const origShowWarn = vscode.window.showWarningMessage;
      const origGetConfig = vscode.workspace.getConfiguration;

      try {
        (vscode.workspace as any).getConfiguration = () => ({
          get: (key: string, def: any) => (key === 'ssh.mode' ? 'cli' : def),
          update: async () => {}
        });
        const executed: Array<{ id: string; args: any[] }> = [];
        (vscode.commands as any).executeCommand = async (id: string, ...args: any[]) => {
          executed.push({ id, args });
        };
        (vscode.window as any).showWarningMessage = async (_msg: string, ...items: any[]) =>
          items.find((i) => typeof i === 'string');
        (vscode.window as any).showInformationMessage = async (_msg: string, ...items: any[]) =>
          items.find((i) => typeof i === 'string');

        const gsMap = new Map<string, unknown>();
        const mockCtx = {
          subscriptions: [],
          globalState: {
            get: (k: string) => gsMap.get(k),
            update: async (k: string, v: unknown) => {
              gsMap.set(k, v);
            }
          },
          globalStorageUri: { fsPath: tmpDir }
        } as unknown as vscode.ExtensionContext;

        const runner: CliRunner = {
          execFile: async (_bin, args) => {
            if (args.includes('--version')) return { stdout: 'boxlite 0.11.0', stderr: '', exitCode: 0 };
            if (args.includes('--help')) return { stdout: 'Usage: boxlite ssh <BOX>', stderr: '', exitCode: 0 };
            if (args.includes('-V')) return { stdout: '', stderr: 'OpenSSH_9.5p2', exitCode: 0 };
            if (args.includes('-?')) return { stdout: '', stderr: 'usage: ssh-keygen', exitCode: 1 };
            if (args.includes('ssh')) {
              return {
                stdout: `Private key: ${keyFile}\nFingerprint: SHA256:FP\nCopy and run the following command to enter the box:\nssh -i "${keyFile}" -o ProxyCommand="boxlite --context vscode-k1 network tunnel --stdio box_9 22" boxlite@0.0.0.0`,
                stderr: '',
                exitCode: 0
              };
            }
            return { stdout: 'ok', stderr: '', exitCode: 0 };
          }
        };

        const cfgPath = path.join(tmpDir, 'user_ssh_config');
        const svc = new SshService(
          mockCtx,
          { listBoxes: async () => [{ id: 'box_9', name: 'remote-dev', status: 'running' }] } as any,
          {
            getApiKey: async () => 'blk_live_abc',
            getActiveKey: async () => ({ id: 'k1', name: 'Default' }),
            getRestUrl: () => 'https://api.boxlite.ai'
          } as any,
          { appendLine: () => {}, show: () => {} } as any,
          undefined,
          new BoxliteSshCli(runner),
          new SshStore(mockCtx, (p) => fs.existsSync(p)),
          new SshConfigFileManager(cfgPath),
          runner
        );

        // 1. Missing Remote-SSH offers installation
        (vscode.extensions as any).getExtension = () => undefined;
        await svc.openRemote('box_9', 'remote-dev');
        assert.ok(
          executed.some(
            (c) => c.id === 'workbench.extensions.installExtension' && c.args[0] === 'ms-vscode-remote.remote-ssh'
          )
        );

        // 2. Installed Remote-SSH writes managed config and opens remote window
        executed.length = 0;
        (vscode.extensions as any).getExtension = (id: string) =>
          id === 'ms-vscode-remote.remote-ssh' ? ({ id } as any) : undefined;

        registerCommands(
          mockCtx,
          {} as any,
          {} as any,
          {} as any,
          { refresh: () => {} } as any,
          {} as any,
          {} as any,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          svc
        );

        await svc.openRemote('box_9', 'remote-dev');
        const cfgText = fs.readFileSync(cfgPath, 'utf-8');
        assert.ok(cfgText.includes('Host boxlite-remote-dev'));
        assert.ok(
          executed.some((c) => c.id === 'opensshremotes.openEmptyWindow' && c.args[0]?.host === 'boxlite-remote-dev')
        );
      } finally {
        (vscode.workspace as any).getConfiguration = origGetConfig;
        (vscode.extensions as any).getExtension = origGetExt;
        (vscode.commands as any).executeCommand = origExecCmd;
        (vscode.window as any).showInformationMessage = origShowInfo;
        (vscode.window as any).showWarningMessage = origShowWarn;
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe('CLI-Free SDK / REST SSH & Raw Tunnel Forwarding', () => {
    it('generates OpenSSH-compatible Ed25519 keys in pure Node.js and reuses stored bundles', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'boxlite-ed25519-'));
      try {
        const kp = generateEd25519KeyPair('boxlite-test');
        assert.ok(kp.privateKeyPem.startsWith('-----BEGIN OPENSSH PRIVATE KEY-----'));
        assert.ok(kp.publicKeyLine.startsWith('ssh-ed25519 '));
        assert.ok(kp.fingerprint.startsWith('SHA256:'));

        const keyFile = path.join(tmpDir, 'test_ed25519');
        fs.writeFileSync(keyFile, kp.privateKeyPem, { mode: 0o600 });

        // Verify against OpenSSH ssh-keygen if available on the host
        try {
          const derived = execFileSync('ssh-keygen', ['-y', '-f', keyFile], { encoding: 'utf-8' }).trim();
          assert.strictEqual(publicKeysMatch(derived, kp.publicKeyLine), true);
          const fpOut = execFileSync('ssh-keygen', ['-l', '-f', keyFile], { encoding: 'utf-8' }).trim();
          assert.ok(fpOut.includes(kp.fingerprint), `Expected ${kp.fingerprint} in "${fpOut}"`);
        } catch (err: any) {
          if (err?.code !== 'ENOENT') {
            throw err;
          }
        }

        const first = ensureBoxKeyBundle(tmpDir, 'https://api.boxlite.ai|vscode-k1', 'box_abc');
        assert.strictEqual(first.existed, false);
        const second = ensureBoxKeyBundle(tmpDir, 'https://api.boxlite.ai|vscode-k1', 'box_abc');
        assert.strictEqual(second.existed, true);
        assert.strictEqual(second.clientPublicKey, first.clientPublicKey);
        assert.strictEqual(second.hostPublicKey, first.hostPublicKey);

        const rotated = ensureBoxKeyBundle(tmpDir, 'https://api.boxlite.ai|vscode-k1', 'box_abc', true);
        assert.strictEqual(rotated.existed, false);
        assert.notStrictEqual(rotated.clientPublicKey, first.clientPublicKey);

        writePinnedKnownHosts(rotated.knownHostsPath, 'boxlite-box_abc', rotated.hostPublicKey);
        const kh = fs.readFileSync(rotated.knownHostsPath, 'utf-8');
        assert.ok(kh.startsWith('boxlite-box_abc ssh-ed25519 '));
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('executes REST SSH endpoints, HTTP CONNECT raw streams, loopback forwarder, and tunnel broker end-to-end', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'boxlite-rest-ssh-'));
      let serverPort = 0;
      let tunnelCount = 0;
      let connectCount = 0;
      let configuredPayload: any;
      let sshEnabled = false;
      let revokeCalls = 0;
      let disableCalls = 0;
      const callOrder: string[] = [];

      const serverSockets = new Set<net.Socket>();
      const apiServer = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
          const bodyStr = Buffer.concat(chunks).toString('utf-8');
          const urlPath = req.url || '';

          if (req.headers.authorization !== 'Bearer blk_live_sdktest') {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ message: 'Unauthorized' }));
            return;
          }

          if (req.method === 'PUT' && urlPath === '/v1/boxes/box_sdk/network/inbound') {
            callOrder.push('inbound');
            res.writeHead(204);
            res.end();
            return;
          }

          if (req.method === 'POST' && urlPath === '/v1/boxes/box_sdk/ssh') {
            callOrder.push('configureSsh');
            configuredPayload = JSON.parse(bodyStr);
            sshEnabled = true;
            const hostPub = configuredPayload.accounts[0].authorized_keys[0];
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                enabled: true,
                generation: 1,
                listen_address: configuredPayload.listen_address,
                host_public_key: '', // filled below by specific test when needed
                host_key_fingerprint: 'SHA256:MockFP',
                _debug_client_pub: hostPub
              })
            );
            return;
          }

          if (req.method === 'GET' && urlPath === '/v1/boxes/box_sdk/ssh') {
            callOrder.push('getSshStatus');
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                enabled: sshEnabled,
                generation: configuredPayload ? 1 : 0,
                listen_address: '0.0.0.0:22',
                host_public_key: '',
                host_key_fingerprint: 'SHA256:MockFP'
              })
            );
            return;
          }

          if (req.method === 'POST' && urlPath === '/v1/boxes/box_sdk/ssh/enable') {
            callOrder.push('enableSsh');
            sshEnabled = true;
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                enabled: true,
                generation: 1,
                listen_address: '0.0.0.0:22',
                host_public_key: '',
                host_key_fingerprint: 'SHA256:MockFP'
              })
            );
            return;
          }

          if (req.method === 'DELETE' && urlPath === '/v1/boxes/box_sdk/ssh') {
            disableCalls++;
            callOrder.push('disableSsh');
            sshEnabled = false;
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                enabled: false,
                generation: 1,
                listen_address: '',
                host_public_key: '',
                host_key_fingerprint: ''
              })
            );
            return;
          }

          if (req.method === 'POST' && urlPath === '/v1/boxes/box_sdk/network/tunnel?port=22') {
            tunnelCount++;
            callOrder.push(`prepareTunnel#${tunnelCount}`);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                uri: `http://127.0.0.1:${serverPort}`,
                isPublic: true,
                token: null
              })
            );
            return;
          }

          if (req.method === 'DELETE' && urlPath === '/v1/boxes/box_sdk/network/tunnel?port=22') {
            revokeCalls++;
            callOrder.push('revokeTunnel');
            res.writeHead(204);
            res.end();
            return;
          }

          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ message: 'Not found' }));
        });
      });

      apiServer.on('connection', (sock) => {
        serverSockets.add(sock);
        sock.once('close', () => serverSockets.delete(sock));
      });

      apiServer.on('connect', (req, clientSocket, head) => {
        serverSockets.add(clientSocket as net.Socket);
        clientSocket.once('close', () => serverSockets.delete(clientSocket as net.Socket));
        connectCount++;
        if (req.headers['x-boxlite-authorization'] !== 'Bearer blk_live_sdktest') {
          clientSocket.end('HTTP/1.1 403 Forbidden\r\n\r\nunauthorized');
          return;
        }
        // Send 200 + coalesced SSH-like banner in one write to verify unshift preservation!
        clientSocket.write(`HTTP/1.1 200 Connection Established\r\n\r\nSSH-2.0-BoxLite#${connectCount}\r\n`);
        if (head && head.length > 0) {
          clientSocket.write(head);
        }
        clientSocket.on('data', (d) => {
          clientSocket.write(d);
        });
      });

      await new Promise<void>((resolve) => {
        apiServer.listen(0, '127.0.0.1', () => {
          const addr = apiServer.address() as net.AddressInfo;
          serverPort = addr.port;
          resolve();
        });
      });

      const restUrl = `http://127.0.0.1:${serverPort}`;
      const restClient = new BoxliteRestSshClient();

      try {
        // 1. Direct REST + one-shot CONNECT stream preserves coalesced banner + echoes
        const desc = await restClient.prepareTunnel(restUrl, 'blk_live_sdktest', 'box_sdk', 22, true);
        const stream = await restClient.openTunnelStream(desc.uri, 'blk_live_sdktest');
        const received = await new Promise<string>((resolve) => {
          let out = '';
          stream.on('data', (chunk) => {
            out += chunk.toString('utf-8');
            if (out.includes('HELLO\n')) {
              resolve(out);
            }
          });
          stream.resume();
          stream.write('HELLO\n');
        });
        assert.ok(received.includes('SSH-2.0-BoxLite#1\r\n'));
        assert.ok(received.includes('HELLO\n'));
        stream.destroy();

        // 2. LocalForwarder creates a fresh one-shot tunnel per accepted TCP connection
        const forwarderMgr = new LocalForwarderManager(restClient, async () => ({
          restUrl,
          apiKey: 'blk_live_sdktest'
        }));
        const tunnelsBefore = tunnelCount;
        const { port: fwdPort } = await forwarderMgr.ensureForwarder('box_sdk', 22);

        for (let i = 0; i < 2; i++) {
          const client = net.connect(fwdPort, '127.0.0.1');
          const msg = await new Promise<string>((resolve, reject) => {
            let acc = '';
            client.on('error', reject);
            client.on('data', (c) => {
              acc += c.toString('utf-8');
              if (acc.includes(`PING-${i}\n`)) {
                resolve(acc);
              }
            });
            client.write(`PING-${i}\n`);
          });
          assert.ok(msg.includes(`PING-${i}\n`));
          client.destroy();
        }
        assert.strictEqual(tunnelCount - tunnelsBefore, 2, 'Each connection must prepare a fresh one-shot tunnel');
        await forwarderMgr.dispose();

        // 3. LocalTunnelBroker + ssh-proxy.js handles brokered ProxyCommand stdio relay
        const brokerPath = path.join(tmpDir, 'ssh-broker.json');
        const broker = new LocalTunnelBroker(brokerPath, restClient, async () => ({
          restUrl,
          apiKey: 'blk_live_sdktest'
        }));
        await broker.ensureStarted();
        const brokerInfo = JSON.parse(fs.readFileSync(brokerPath, 'utf-8'));
        assert.ok(brokerInfo.port > 0 && brokerInfo.secret);

        const brokerSocket = net.connect(brokerInfo.port, '127.0.0.1');
        const brokerReply = await new Promise<string>((resolve, reject) => {
          let out = '';
          brokerSocket.on('error', reject);
          brokerSocket.on('connect', () => {
            brokerSocket.write(`${JSON.stringify({ secret: brokerInfo.secret, boxId: 'box_sdk', port: 22 })}\n`);
          });
          brokerSocket.on('data', (c) => {
            out += c.toString('utf-8');
            if (out.includes('OK\n') && !out.includes('BROKER-ECHO\n')) {
              brokerSocket.write('BROKER-ECHO\n');
            }
            if (out.includes('BROKER-ECHO\n')) {
              resolve(out);
            }
          });
        });
        assert.ok(brokerReply.startsWith('OK\n'));
        assert.ok(brokerReply.includes('BROKER-ECHO\n'));
        brokerSocket.destroy();

        // 3b. Spawn the actual bundled dist/ssh-proxy.js child process (stdio ProxyCommand relay)
        const proxyBundlePath = path.join(repoRoot, 'dist', 'ssh-proxy.js');
        assert.strictEqual(fs.existsSync(proxyBundlePath), true, 'Expected dist/ssh-proxy.js to be built');
        const proxyChild = spawn(process.execPath, [proxyBundlePath, '--box', 'box_sdk', '--port', '22', '--broker', brokerPath], {
          stdio: ['pipe', 'pipe', 'pipe']
        });
        const proxyOutput = await new Promise<string>((resolve, reject) => {
          let stdout = '';
          let stderr = '';
          const timer = setTimeout(() => {
            proxyChild.kill();
            reject(new Error(`ssh-proxy.js timed out. stdout=${stdout} stderr=${stderr}`));
          }, 5000);
          proxyChild.stderr.on('data', (d) => {
            stderr += d.toString('utf-8');
          });
          proxyChild.stdout.on('data', (d) => {
            stdout += d.toString('utf-8');
            if (stdout.includes('PROXY-STDIO-OK\n')) {
              clearTimeout(timer);
              proxyChild.kill();
              resolve(stdout);
            }
          });
          proxyChild.on('error', (e) => {
            clearTimeout(timer);
            reject(e);
          });
          proxyChild.stdin.write('PROXY-STDIO-OK\n');
        });
        assert.ok(proxyOutput.includes('SSH-2.0-BoxLite#'));
        assert.ok(proxyOutput.includes('PROXY-STDIO-OK\n'));

        await broker.dispose();
        assert.strictEqual(fs.existsSync(brokerPath), false);

        // 4. SshService in default 'sdk' mode (zero boxlite CLI!)
        const origShowInfo = vscode.window.showInformationMessage;
        const origShowWarn = vscode.window.showWarningMessage;
        const origCreateTerminal = vscode.window.createTerminal;
        const origGetExt = vscode.extensions.getExtension;
        const origExecCmd = vscode.commands.executeCommand;
        try {
          const createdTerminals: any[] = [];
          const executedCmds: Array<{ id: string; args: any[] }> = [];
          (vscode.window as any).terminals = createdTerminals;
          (vscode.window as any).createTerminal = (opts: any) => {
            const term = {
              name: opts.name,
              creationOptions: opts,
              shown: false,
              show: () => {
                term.shown = true;
              },
              sendText: () => {},
              dispose: () => {
                const idx = createdTerminals.indexOf(term);
                if (idx >= 0) createdTerminals.splice(idx, 1);
              }
            };
            createdTerminals.push(term);
            return term;
          };
          (vscode.window as any).showInformationMessage = async (_msg: string, ...items: any[]) =>
            items.find((i) => typeof i === 'string');
          (vscode.window as any).showWarningMessage = async (_msg: string, ...items: any[]) =>
            items.find((i) => typeof i === 'string');
          (vscode.extensions as any).getExtension = (id: string) =>
            id === 'ms-vscode-remote.remote-ssh' ? ({ id } as any) : undefined;
          (vscode.commands as any).executeCommand = async (id: string, ...args: any[]) => {
            executedCmds.push({ id, args });
          };

          const gsMap = new Map<string, unknown>();
          const mockCtx = {
            subscriptions: [],
            extensionPath: repoRoot,
            globalState: {
              get: (k: string) => gsMap.get(k),
              update: async (k: string, v: unknown) => {
                gsMap.set(k, v);
              }
            },
            globalStorageUri: { fsPath: tmpDir }
          } as unknown as vscode.ExtensionContext;

          // Runner deliberately fails ENOENT on 'boxlite' to prove zero boxlite CLI dependency!
          const noBoxliteCliRunner: CliRunner = {
            execFile: async (bin, args) => {
              if (bin.toLowerCase().includes('boxlite')) {
                const err: NodeJS.ErrnoException = new Error('boxlite not installed');
                err.code = 'ENOENT';
                throw err;
              }
              if (args.includes('-V')) {
                return { stdout: '', stderr: 'OpenSSH_9.5p2', exitCode: 0 };
              }
              if (bin.toLowerCase().includes('node') && args.includes('--version')) {
                return { stdout: 'v20.0.0', stderr: '', exitCode: 0 };
              }
              return { stdout: '', stderr: '', exitCode: 0 };
            }
          };

          const cfgPath = path.join(tmpDir, 'sdk_ssh_config');
          const svc = new SshService(
            mockCtx,
            { listBoxes: async () => [{ id: 'box_sdk', name: 'sdk-box', status: 'running' }] } as any,
            {
              getApiKey: async () => 'blk_live_sdktest',
              getActiveKey: async () => ({ id: 'k1', name: 'Default' }),
              getRestUrl: () => restUrl
            } as any,
            { appendLine: () => {}, show: () => {} } as any,
            undefined,
            new BoxliteSshCli(noBoxliteCliRunner),
            new SshStore(mockCtx, (p) => fs.existsSync(p)),
            new SshConfigFileManager(cfgPath),
            noBoxliteCliRunner,
            restClient
          );

          await svc.connect('box_sdk', 'sdk-box');
          assert.strictEqual(createdTerminals.length, 1);
          assert.ok(configuredPayload);
          assert.strictEqual(configuredPayload.listen_address, '0.0.0.0:22');
          assert.ok(configuredPayload.host_private_key.includes('BEGIN OPENSSH PRIVATE KEY'));
          assert.strictEqual(configuredPayload.accounts[0].login, 'box');

          const termArgs: string[] = createdTerminals[0].creationOptions.shellArgs;
          assert.ok(termArgs.includes('StrictHostKeyChecking=yes'));
          assert.ok(termArgs.some((a) => a.startsWith('HostKeyAlias=boxlite-box_sdk')));
          assert.strictEqual(termArgs[termArgs.length - 1], 'box@127.0.0.1');

          // Reconnect after terminal close & server-side disable -> calls enableSsh without reconfiguring
          createdTerminals[0].dispose();
          (svc as any).activeTerminals.clear();
          sshEnabled = false;
          const configureCountBefore = callOrder.filter((c) => c === 'configureSsh').length;

          await svc.connect('box_sdk', 'sdk-box');
          assert.ok(callOrder.includes('enableSsh'));
          assert.strictEqual(callOrder.filter((c) => c === 'configureSsh').length, configureCountBefore);

          // Remote-SSH in SDK mode writes managed block & opens Remote-SSH window
          await svc.openRemote('box_sdk', 'sdk-box');
          const cfgText = fs.readFileSync(cfgPath, 'utf-8');
          assert.ok(cfgText.includes('Host boxlite-sdk-box'));
          assert.ok(cfgText.includes('StrictHostKeyChecking yes'));
          assert.ok(
            executedCmds.some((c) => c.id === 'opensshremotes.openEmptyWindow' && c.args[0]?.host === 'boxlite-sdk-box')
          );

          // Disable revokes tunnel before disabling guest SSH and cleans up
          await svc.disable('box_sdk', 'sdk-box');
          assert.strictEqual(revokeCalls, 1);
          assert.strictEqual(disableCalls, 1);
          const revokeIdx = callOrder.indexOf('revokeTunnel');
          const disableIdx = callOrder.indexOf('disableSsh');
          assert.ok(revokeIdx >= 0 && disableIdx > revokeIdx);

          await svc.tunnelBroker.dispose();
          await svc.forwarderManager.dispose();
          svc.dispose();
        } finally {
          (vscode.window as any).showInformationMessage = origShowInfo;
          (vscode.window as any).showWarningMessage = origShowWarn;
          (vscode.window as any).createTerminal = origCreateTerminal;
          (vscode.extensions as any).getExtension = origGetExt;
          (vscode.commands as any).executeCommand = origExecCmd;
        }
      } finally {
        for (const s of serverSockets) {
          try {
            s.destroy();
          } catch {}
        }
        serverSockets.clear();
        apiServer.closeAllConnections?.();
        await new Promise<void>((r) => apiServer.close(() => r()));
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });
});
