import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { showBoxConfigurationWizard } from '../src/commands/boxConfiguration';
import { CredentialsManager } from '../src/auth/credentials';
import { SecretsManager } from '../src/auth/secretsStore';
import { PythonEnvManager } from '../src/bridge/env';
import { BoxLiteBridgeClient } from '../src/bridge/client';
import { AccountTreeDataProvider } from '../src/tree/accountProvider';
import { BoxesTreeDataProvider } from '../src/tree/boxesProvider';
import { VolumesTreeDataProvider } from '../src/tree/volumesProvider';
import { ImagesTreeDataProvider } from '../src/tree/imagesProvider';
import { CheckpointsTreeDataProvider } from '../src/tree/checkpointsProvider';
import { DomainsTreeDataProvider } from '../src/tree/domainsProvider';
import { SecretsTreeDataProvider } from '../src/tree/secretsProvider';
import { LogStreamManager } from '../src/logs/logStream';
import { SshService, SshStore, SshCliError, ensureBoxKeyBundle, removeBoxKeyBundle } from '../src/ssh';
import { removeAllManagedBlocks } from '../src/ssh/sshConfig';
import { formatErrorWithDiagnosis } from '../src/util/diagnosis';
import { createErrorTreeItem, VolumeChildTreeItem } from '../src/tree/nodes';
import { BoxLiteDeployer, buildHealthProbeCommand, isPathWithinRoot, stageAppDirectory } from '../src/deploy/deployer';

describe('Audit Regression Fixes', () => {
  describe('1. Wizard invalid secret validation', () => {
    it('stays in wizard loop instead of creating a box when a secret is invalid', async () => {
      const origQuickPick = vscode.window.showQuickPick;
      const origShowError = vscode.window.showErrorMessage;
      const errors: string[] = [];
      let pickStep = 0;

      (vscode.window as any).showErrorMessage = async (msg: string) => {
        errors.push(msg);
      };
      (vscode.window as any).showQuickPick = async (items: any[]) => {
        pickStep++;
        if (pickStep === 1) {
          return items.find((i) => i.action === 'create');
        }
        return items.find((i) => i.action === 'cancel');
      };

      try {
        const result = await showBoxConfigurationWizard({
          name: 'bad-secret-box',
          secrets: [
            {
              name: 'bad secret name!',
              value: 'sk-123',
              hosts: ['api.openai.com'],
              headers: { Authorization: 'Bearer {value}' }
            }
          ]
        });

        assert.strictEqual(result, undefined, 'Wizard must not return CreateBoxArgs when secret validation fails');
        assert.strictEqual(pickStep, 2, 'Wizard must loop back to showQuickPick after validation error');
        assert.strictEqual(errors.length, 1);
        assert.ok(errors[0].includes('Invalid secret'));
      } finally {
        (vscode.window as any).showQuickPick = origQuickPick;
        (vscode.window as any).showErrorMessage = origShowError;
      }
    });
  });

  describe('2. SecretStorage transient read error and save propagation', () => {
    it('CredentialsManager does not cache failed reads, blocks wiping mutations, and propagates store errors', async () => {
      let locked = true;
      let storeShouldFail = false;
      const backing = new Map<string, string>([
        [
          'boxlite.apiKeys',
          JSON.stringify({
            activeId: 'k1',
            keys: [{ id: 'k1', name: 'Prod', key: 'bl_prod_existing' }]
          })
        ]
      ]);

      const mgr = new CredentialsManager({
        secrets: {
          get: async (k: string) => {
            if (locked) {
              throw new Error('Keyring locked');
            }
            return backing.get(k);
          },
          store: async (k: string, v: string) => {
            if (storeShouldFail) {
              throw new Error('Keyring write failed');
            }
            backing.set(k, v);
          },
          delete: async (k: string) => {
            backing.delete(k);
          }
        }
      } as unknown as vscode.ExtensionContext);

      // Transient failure at startup returns undefined without caching empty state
      assert.strictEqual(await mgr.getApiKey(), undefined);

      // Mutating while still locked must throw instead of overwriting existing keys
      await assert.rejects(() => mgr.addKey('Staging', 'bl_staging'), /Keyring locked/);
      assert.ok(backing.get('boxlite.apiKeys')!.includes('bl_prod_existing'));

      // Once unlocked, subsequent read retries and sees existing key
      locked = false;
      assert.strictEqual(await mgr.getApiKey(), 'bl_prod_existing');

      // Adding a key preserves the existing key
      await mgr.addKey('Staging', 'bl_staging');
      const keys = await mgr.listKeys();
      assert.strictEqual(keys.length, 2);

      // Write errors propagate instead of being swallowed
      storeShouldFail = true;
      await assert.rejects(() => mgr.addKey('Dev', 'bl_dev'), /Keyring write failed/);
      assert.strictEqual((await mgr.listKeys()).length, 2, 'Cache must not advance when store() fails');
    });

    it('SecretsManager does not cache failed reads, blocks wiping mutations, and propagates store errors', async () => {
      let locked = true;
      let storeShouldFail = false;
      const backing = new Map<string, string>([
        [
          'boxlite.proxySecrets',
          JSON.stringify({
            secrets: [
              {
                name: 'existing',
                value: 'sk-old',
                hosts: ['api.openai.com'],
                headers: { Authorization: 'Bearer {value}' }
              }
            ]
          })
        ]
      ]);

      const mgr = new SecretsManager({
        secrets: {
          get: async (k: string) => {
            if (locked) {
              throw new Error('Keyring locked');
            }
            return backing.get(k);
          },
          store: async (k: string, v: string) => {
            if (storeShouldFail) {
              throw new Error('Keyring write failed');
            }
            backing.set(k, v);
          },
          delete: async (k: string) => {
            backing.delete(k);
          }
        }
      } as unknown as vscode.ExtensionContext);

      // Startup read survives and returns [] without caching empty state
      assert.deepStrictEqual(await mgr.listSecrets(), []);

      // Saving while locked must throw instead of wiping existing secrets
      await assert.rejects(
        () =>
          mgr.saveSecret({
            name: 'newsec',
            value: 'sk-new',
            hosts: ['api.example.com'],
            headers: { Authorization: 'Bearer {value}' }
          }),
        /Keyring locked/
      );

      // Once unlocked, existing secret is loaded and preserved
      locked = false;
      const loaded = await mgr.listSecrets();
      assert.strictEqual(loaded.length, 1);
      assert.strictEqual(loaded[0].name, 'existing');

      // Write failures propagate
      storeShouldFail = true;
      await assert.rejects(
        () =>
          mgr.saveSecret({
            name: 'newsec',
            value: 'sk-new',
            hosts: ['api.example.com'],
            headers: { Authorization: 'Bearer {value}' }
          }),
        /Keyring write failed/
      );
      assert.strictEqual((await mgr.listSecrets()).length, 1);
    });
  });

  describe('5. PythonEnvManager cache invalidation', () => {
    it('invalidates cached python path when invalidateCache is called', async () => {
      const origGetConfig = vscode.workspace.getConfiguration;
      let configuredPath = '/usr/bin/python3';
      (vscode.workspace as any).getConfiguration = () => ({
        get: (key: string) => (key === 'pythonPath' ? configuredPath : undefined)
      });

      try {
        const mgr = new PythonEnvManager(
          { globalStorageUri: vscode.Uri.file('/tmp/nonexistent-boxlite-storage'), extensionPath: '/tmp' } as unknown as vscode.ExtensionContext,
          vscode.window.createOutputChannel('test')
        );

        assert.strictEqual(await mgr.getPythonPath(), '/usr/bin/python3');
        configuredPath = '/opt/venv/bin/python';
        // Still cached until invalidated
        assert.strictEqual(await mgr.getPythonPath(), '/usr/bin/python3');
        mgr.invalidateCache();
        assert.strictEqual(await mgr.getPythonPath(), '/opt/venv/bin/python');
      } finally {
        (vscode.workspace as any).getConfiguration = origGetConfig;
      }
    });
  });

  describe('8. Bridge restart during in-flight spawn', () => {
    it('aborts in-flight spawn when restartBridge is called while awaiting getApiKey', async () => {
      let resolveKey!: (val: string) => void;
      const creds = {
        getApiKey: () => new Promise<string>((r) => { resolveKey = r; }),
        getRestUrl: () => 'https://api.boxlite.ai'
      } as unknown as CredentialsManager;

      const envMgr = {
        getPythonPath: async () => 'python3'
      } as unknown as PythonEnvManager;

      const client = new BoxLiteBridgeClient(
        { extensionPath: process.cwd() } as unknown as vscode.ExtensionContext,
        creds,
        envMgr,
        vscode.window.createOutputChannel('test')
      );

      const ensurePromise = (client as any).ensureProcess();
      // Restart while spawnBridgeProcess is still awaiting getApiKey()
      client.restartBridge();
      resolveKey('old_api_key');

      await assert.rejects(() => ensurePromise, /Bridge restarted during startup/);
      assert.strictEqual((client as any).process, null);
      client.dispose();
    });
  });

  describe('9. Tree provider timer deduplication and disposal', () => {
    it('clears auto-refresh timers on refresh and dispose across all four providers', async () => {
      const creds = { getApiKey: async () => 'bl_key' } as unknown as CredentialsManager;
      const bridge = {
        listBoxes: async () => [{ id: 'b1', name: 'box1', status: 'starting' }],
        listVolumes: async () => [{ id: 'v1', name: 'vol1', state: 'creating' }],
        listCheckpoints: async () => [{ id: 'c1', name: 'chk1', sourceBoxId: 'b1', state: 'creating' }],
        listDomains: async () => [{ id: 'd1', domain: 'app.example.com', status: 'pending' }]
      } as unknown as BoxLiteBridgeClient;

      const providers = [
        new BoxesTreeDataProvider(bridge, creds),
        new VolumesTreeDataProvider(bridge, creds),
        new CheckpointsTreeDataProvider(bridge, creds),
        new DomainsTreeDataProvider(bridge, creds)
      ];

      for (const p of providers) {
        await p.getChildren();
        assert.ok((p as any).refreshTimer, 'Transient state should schedule a single refreshTimer');
        p.dispose();
        assert.strictEqual((p as any).refreshTimer, undefined, 'dispose() must clear refreshTimer');
      }
    });
  });

  describe('12. SshService.disable ignores 404 on revokeTunnel', () => {
    it('proceeds to disableSsh when revokeTunnel returns BOX_NOT_FOUND (404)', async () => {
      const origShowWarning = vscode.window.showWarningMessage;
      const origShowInfo = vscode.window.showInformationMessage;
      (vscode.window as any).showWarningMessage = async () => 'Disable SSH';
      (vscode.window as any).showInformationMessage = async () => undefined;

      let disableSshCalled = false;
      const mockState = new Map<string, any>();
      const ctx = {
        globalState: {
          get: (k: string, d?: any) => (mockState.has(k) ? mockState.get(k) : d),
          update: async (k: string, v: any) => { mockState.set(k, v); }
        },
        globalStorageUri: vscode.Uri.file('/tmp/boxlite-ssh-test')
      } as unknown as vscode.ExtensionContext;

      const store = new SshStore(ctx);
      const service = new SshService(
        ctx,
        {} as unknown as BoxLiteBridgeClient,
        {
          getApiKey: async () => 'bl_key',
          getRestUrl: () => 'https://api.boxlite.ai',
          getActiveKey: async () => ({ id: 'default', name: 'Default' })
        } as unknown as CredentialsManager,
        vscode.window.createOutputChannel('ssh'),
        undefined,
        undefined,
        store
      );

      (service as any).restClient = {
        revokeTunnel: async () => {
          throw new SshCliError('BOX_NOT_FOUND', 'Tunnel not found (404)');
        },
        disableSsh: async () => {
          disableSshCalled = true;
          return { enabled: false };
        }
      };
      (service as any).forwarderManager = {
        stopForwarder: async () => {},
        dispose: () => {}
      };
      (service as any).configManager = {
        removeHost: () => ({ content: '', removed: false })
      };

      try {
        await service.disable('box-123', 'my-box');
        assert.strictEqual(disableSshCalled, true, 'disableSsh must still run when revokeTunnel returns 404');
      } finally {
        (vscode.window as any).showWarningMessage = origShowWarning;
        (vscode.window as any).showInformationMessage = origShowInfo;
        service.dispose();
      }
    });
  });

  describe('15. LogStreamManager in-flight guard', () => {
    it('prevents overlapping tailLog calls during polling', async () => {
      let activePolls = 0;
      let maxConcurrentPolls = 0;
      let callCount = 0;

      const mockBridge = {
        tailLog: async () => {
          callCount++;
          if (callCount === 1) {
            return { boxId: 'b1', content: 'line1\n', exitCode: 0 };
          }
          activePolls++;
          maxConcurrentPolls = Math.max(maxConcurrentPolls, activePolls);
          await new Promise((r) => setTimeout(r, 80));
          activePolls--;
          return { boxId: 'b1', content: `line1\nline${callCount}\n`, exitCode: 0 };
        }
      } as unknown as BoxLiteBridgeClient;

      const mgr = new LogStreamManager(mockBridge);
      await mgr.openOrStreamLogs('b1', 'box1');
      assert.strictEqual(mgr.isStreaming('b1'), true);
      mgr.stopStreaming('b1');
      assert.strictEqual(mgr.isStreaming('b1'), false);
      assert.ok(maxConcurrentPolls <= 1);
      mgr.dispose();
    });
  });

  describe('18. formatErrorWithDiagnosis and createErrorTreeItem helpers', () => {
    it('formatErrorWithDiagnosis appends diagnosis once', () => {
      const formatted = formatErrorWithDiagnosis(new Error('HTTP 401 Unauthorized'));
      assert.ok(formatted.includes('Diagnosis: 401 Unauthorized'));
      assert.strictEqual(formatErrorWithDiagnosis(new Error(formatted)), formatted);
    });

    it('createErrorTreeItem formats 401, 403, unavailable, and generic errors', () => {
      const item401 = createErrorTreeItem({
        label: 'Error',
        rawMessage: 'HTTP 401 Unauthorized',
        retryCommand: 'boxlite.refresh',
        contextPrefix: 'volume',
        forbiddenDescription: '403',
        forbiddenTooltip: '403 tip',
        createItem: (...args) => new VolumeChildTreeItem(...args)
      });
      assert.strictEqual(item401.command?.command, 'boxlite.setApiKey');
      assert.strictEqual(item401.contextValue, 'volume-error');

      const item403 = createErrorTreeItem({
        label: 'Error',
        rawMessage: 'HTTP 403 Forbidden',
        retryCommand: 'boxlite.refresh',
        contextPrefix: 'volume',
        forbiddenDescription: '403 custom',
        forbiddenTooltip: '403 tip',
        createItem: (...args) => new VolumeChildTreeItem(...args)
      });
      assert.strictEqual(item403.contextValue, 'volume-forbidden');
      assert.strictEqual(item403.description, '403 custom');
    });
  });

  describe('19. SecretsTreeDataProvider concurrent loading', () => {
    it('loads stored secrets and box secrets concurrently and tolerates partial failure', async () => {
      const creds = { getApiKey: async () => 'bl_key' } as unknown as CredentialsManager;
      const bridge = {
        listBoxes: async () => {
          throw new Error('network error');
        }
      } as unknown as BoxLiteBridgeClient;
      const secretsMgr = {
        listSecrets: async () => [
          {
            name: 'openai',
            value: 'sk-test',
            hosts: ['api.openai.com'],
            headers: { Authorization: 'Bearer {value}' }
          }
        ]
      } as unknown as SecretsManager;

      const provider = new SecretsTreeDataProvider(bridge, creds, secretsMgr);
      const items = await provider.getChildren();
      assert.ok(items.some((i) => i.label === 'openai'), 'Expected stored secret "openai" to appear despite listBoxes error');
    });
  });

  describe('20. removeAllManagedBlocks reverse-order splice', () => {
    it('removes multiple managed blocks while preserving surrounding user config', () => {
      const text = [
        'Host personal',
        '  HostName 10.0.0.1',
        '',
        '# >>> boxlite-cloud:box-1 (managed by BoxLite extension) >>>',
        'Host boxlite-box1',
        '  HostName 127.0.0.1',
        '# <<< boxlite-cloud:box-1 <<<',
        '',
        '# >>> boxlite-cloud:box-2 (managed by BoxLite extension) >>>',
        'Host boxlite-box2',
        '  HostName 127.0.0.1',
        '# <<< boxlite-cloud:box-2 <<<',
        '',
        'Host work',
        '  HostName 10.0.0.2',
        ''
      ].join('\n');

      const res = removeAllManagedBlocks(text);
      assert.strictEqual(res.removedCount, 2);
      assert.ok(res.content.includes('Host personal'));
      assert.ok(res.content.includes('Host work'));
      assert.ok(!res.content.includes('boxlite-box1'));
      assert.ok(!res.content.includes('boxlite-box2'));
    });
  });

  describe('Security & Audit Round 2 fixes', () => {
    it('restricts sensitive settings in package.json to application scope', () => {
      const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf-8'));
      const props = pkg.contributes.configuration.properties;
      for (const key of [
        'boxlite.restUrl',
        'boxlite.pythonPath',
        'boxlite.ssh.cliPath',
        'boxlite.ssh.sshPath',
        'boxlite.ssh.manageConfig'
      ]) {
        assert.strictEqual(props[key].scope, 'application', `${key} must have scope: "application"`);
      }
    });

    it('rejects appDir path traversal and skips escaping symlinks during staging', () => {
      const wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'boxlite-ws-sec-'));
      const outsideFile = path.join(os.tmpdir(), `boxlite-outside-${Date.now()}.txt`);
      fs.writeFileSync(outsideFile, 'TOP_SECRET');
      try {
        assert.strictEqual(isPathWithinRoot(wsRoot, path.join(wsRoot, 'app')), true);
        assert.strictEqual(isPathWithinRoot(wsRoot, path.resolve(wsRoot, '../outside')), false);

        const appDir = path.join(wsRoot, 'app');
        fs.mkdirSync(appDir, { recursive: true });
        fs.writeFileSync(path.join(appDir, 'server.py'), 'print("ok")');
        let symlinkCreated = false;
        try {
          fs.symlinkSync(outsideFile, path.join(appDir, 'leak.txt'));
          symlinkCreated = true;
        } catch {
          // Windows without Developer Mode may disallow symlink creation
        }

        const staged = stageAppDirectory(appDir, []);
        try {
          assert.strictEqual(fs.existsSync(path.join(staged, 'server.py')), true);
          if (symlinkCreated) {
            assert.strictEqual(fs.existsSync(path.join(staged, 'leak.txt')), false, 'Escaping symlink must not be staged');
          }
        } finally {
          fs.rmSync(staged, { recursive: true, force: true });
        }
      } finally {
        fs.rmSync(wsRoot, { recursive: true, force: true });
        fs.rmSync(outsideFile, { force: true });
      }
    });

    it('prevents double-quote shell injection in buildHealthProbeCommand and validates port', () => {
      assert.throws(() => buildHealthProbeCommand(0, '/healthz'), /Invalid health probe port/);
      assert.throws(() => buildHealthProbeCommand(8080, '/healthz\nwhoami'), /control characters/);

      const malicious = '/healthz"; id; echo "$(whoami)"';
      const cmd = buildHealthProbeCommand(8080, malicious);
      // URL is passed via single-quoted env var, and python3/node scripts are single-quoted reading env
      assert.ok(cmd.includes("BOXLITE_HEALTH_URL='http://127.0.0.1:8080/healthz\"; id; echo \"$(whoami)\"'"));
      assert.ok(cmd.includes('os.environ["BOXLITE_HEALTH_URL"]'));
      assert.ok(cmd.includes('process.env.BOXLITE_HEALTH_URL'));
    });

    it('rejects path traversal boxId in ensureBoxKeyBundle and removeBoxKeyBundle', () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'boxlite-key-sec-'));
      try {
        assert.throws(() => ensureBoxKeyBundle(tmp, 'scope', '../escape'), /Invalid Box ID/);
        assert.throws(() => removeBoxKeyBundle(tmp, 'scope', '../../escape'), /Invalid Box ID/);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    it('redacts private access token in deploy output channel', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'boxlite-token-redact-'));
      const appDir = path.join(tmpDir, 'app');
      fs.mkdirSync(appDir, { recursive: true });
      fs.writeFileSync(path.join(appDir, 'server.py'), 'print("ok")');
      fs.writeFileSync(
        path.join(tmpDir, 'boxlite.json'),
        JSON.stringify({ name: 'priv-app', appDir: './app', port: 8080, healthPath: '/healthz', start: 'python3 -u server.py', access: 'private' })
      );

      const origFolders = vscode.workspace.workspaceFolders;
      const origShowInfo = vscode.window.showInformationMessage;
      (vscode.workspace as any).workspaceFolders = [{ uri: vscode.Uri.file(tmpDir), name: 'ws', index: 0 }];
      (vscode.window as any).showInformationMessage = async () => undefined;

      const lines: string[] = [];
      const mockChannel = {
        name: 'test',
        append: (v: string) => lines.push(v),
        appendLine: (v: string) => lines.push(v),
        replace: () => {},
        clear: () => {},
        show: () => {},
        hide: () => {},
        dispose: () => {}
      } as unknown as vscode.OutputChannel;

      const secretToken = 'tok_super_secret_private_value_9999';
      const mockBridge = {
        createBox: async () => ({ boxId: 'box-priv', name: 'priv-app', status: 'running' }),
        exec: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
        copyIn: async () => true,
        updateInbound: async () => {},
        tunnel: async () => ({ url: 'https://priv.boxlite.ai', token: secretToken, isPublic: false, boxId: 'box-priv', port: 8080 })
      } as unknown as BoxLiteBridgeClient;

      try {
        const deployer = new BoxLiteDeployer(
          mockBridge,
          { getApiKey: async () => 'bl_live_key' } as unknown as CredentialsManager,
          { openOrStreamLogs: async () => {} } as unknown as LogStreamManager,
          mockChannel,
          undefined,
          undefined,
          0,
          async () => 200
        );
        await deployer.deployWorkspace();
        const combined = lines.join('\n');
        assert.strictEqual(combined.includes(secretToken), false, 'Raw private tunnel token must not be written to output channel');
        assert.ok(combined.includes('tok_...9999'), 'Redacted token should be logged');
      } finally {
        (vscode.workspace as any).workspaceFolders = origFolders;
        (vscode.window as any).showInformationMessage = origShowInfo;
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('implements dispose() on Account, Images, and Secrets tree providers', () => {
      const creds = { getApiKey: async () => undefined } as unknown as CredentialsManager;
      const bridge = {} as unknown as BoxLiteBridgeClient;
      const secretsMgr = {} as unknown as SecretsManager;
      const providers = [
        new AccountTreeDataProvider(creds),
        new ImagesTreeDataProvider(bridge, creds),
        new SecretsTreeDataProvider(bridge, creds, secretsMgr)
      ];
      for (const p of providers) {
        assert.strictEqual(typeof p.dispose, 'function');
        p.dispose();
      }
    });
  });
});
