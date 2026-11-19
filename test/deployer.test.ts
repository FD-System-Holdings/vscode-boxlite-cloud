import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  BoxLiteDeployer,
  buildHealthProbeCommand,
  buildRestartCommand,
  matchesIgnorePattern,
  stageAppDirectory
} from '../src/deploy/deployer';
import { BoxLiteBridgeClient } from '../src/bridge/client';
import { CredentialsManager } from '../src/auth/credentials';
import { LogStreamManager } from '../src/logs/logStream';
import { CreateBoxArgs } from '../src/bridge/protocol';

function createMockOutputChannel(): vscode.OutputChannel & { lines: string[] } {
  const lines: string[] = [];
  return {
    name: 'Test Deploy',
    lines,
    append: (v: string) => { lines.push(v); },
    appendLine: (v: string) => { lines.push(v); },
    replace: () => {},
    clear: () => { lines.length = 0; },
    show: () => {},
    hide: () => {},
    dispose: () => {}
  };
}

describe('BoxLiteDeployer', () => {
  let tmpDir: string;
  let origWorkspaceFolders: readonly vscode.WorkspaceFolder[] | undefined;
  let origShowInfo: typeof vscode.window.showInformationMessage;
  let origShowError: typeof vscode.window.showErrorMessage;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'boxlite-deployer-test-'));
    origWorkspaceFolders = vscode.workspace.workspaceFolders;
    origShowInfo = vscode.window.showInformationMessage;
    origShowError = vscode.window.showErrorMessage;
    (vscode.workspace as any).workspaceFolders = [{ uri: vscode.Uri.file(tmpDir), name: 'ws', index: 0 }];
    (vscode.window as any).showInformationMessage = async () => undefined;
    (vscode.window as any).showErrorMessage = async () => undefined;
  });

  afterEach(() => {
    (vscode.workspace as any).workspaceFolders = origWorkspaceFolders;
    (vscode.window as any).showInformationMessage = origShowInfo;
    (vscode.window as any).showErrorMessage = origShowError;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('helper utilities', () => {
    it('matchesIgnorePattern matches exact names, subpaths, and suffix globs', () => {
      const patterns = ['.env', '.git', 'node_modules', '*.pyc', 'build/tmp'];
      assert.strictEqual(matchesIgnorePattern('.env', '.env', patterns), true);
      assert.strictEqual(matchesIgnorePattern('node_modules', 'sub/node_modules', patterns), true);
      assert.strictEqual(matchesIgnorePattern('foo.pyc', 'pkg/foo.pyc', patterns), true);
      assert.strictEqual(matchesIgnorePattern('a.txt', 'build/tmp/a.txt', patterns), true);
      assert.strictEqual(matchesIgnorePattern('server.js', 'server.js', patterns), false);
    });

    it('stageAppDirectory copies only non-ignored files', () => {
      const appDir = path.join(tmpDir, 'app');
      fs.mkdirSync(path.join(appDir, 'node_modules', 'pkg'), { recursive: true });
      fs.mkdirSync(path.join(appDir, '.git'), { recursive: true });
      fs.mkdirSync(path.join(appDir, 'src'), { recursive: true });
      fs.writeFileSync(path.join(appDir, '.env'), 'SECRET=123');
      fs.writeFileSync(path.join(appDir, '.git', 'HEAD'), 'ref: refs/heads/main');
      fs.writeFileSync(path.join(appDir, 'node_modules', 'pkg', 'index.js'), '');
      fs.writeFileSync(path.join(appDir, 'src', 'index.js'), 'console.log("ok")');
      fs.writeFileSync(path.join(appDir, 'mod.pyc'), 'bytecode');

      const staged = stageAppDirectory(appDir, ['.env', '.git', 'node_modules', '*.pyc']);
      try {
        assert.strictEqual(fs.existsSync(path.join(staged, 'src', 'index.js')), true);
        assert.strictEqual(fs.existsSync(path.join(staged, '.env')), false);
        assert.strictEqual(fs.existsSync(path.join(staged, '.git')), false);
        assert.strictEqual(fs.existsSync(path.join(staged, 'node_modules')), false);
        assert.strictEqual(fs.existsSync(path.join(staged, 'mod.pyc')), false);
      } finally {
        fs.rmSync(staged, { recursive: true, force: true });
      }
    });

    it('buildRestartCommand is runtime-agnostic and protects PID 1 and supervisor', () => {
      const cmd = buildRestartCommand('node server.js');
      assert.ok(cmd.includes('node server.js'));
      assert.ok(!cmd.includes('pkill -f python3'));
      assert.ok(cmd.includes('[ "$pid" = "1" ]'));
      assert.ok(cmd.includes('while true;'));
    });

    it('buildHealthProbeCommand supports curl, wget, python3, and node', () => {
      const cmd = buildHealthProbeCommand(3000, '/healthz');
      assert.ok(cmd.includes('http://127.0.0.1:3000/healthz'));
      assert.ok(cmd.includes('curl'));
      assert.ok(cmd.includes('wget'));
      assert.ok(cmd.includes('python3'));
      assert.ok(cmd.includes('node'));
    });
  });

  describe('deployWorkspace', () => {
    it('forwards cpus, memoryMib, diskSizeGb, autoDelete, autoResume, stages without ignored files, and uses runtime-agnostic restart & health probe', async () => {
      const appDir = path.join(tmpDir, 'app');
      fs.mkdirSync(path.join(appDir, 'node_modules', 'dep'), { recursive: true });
      fs.writeFileSync(path.join(appDir, 'server.js'), 'console.log("hi")');
      fs.writeFileSync(path.join(appDir, '.env'), 'API_SECRET=do-not-upload');
      fs.writeFileSync(path.join(appDir, 'node_modules', 'dep', 'a.js'), '');

      fs.writeFileSync(
        path.join(tmpDir, 'boxlite.json'),
        JSON.stringify({
          name: 'node-api',
          image: 'node:20-alpine',
          appDir: './app',
          port: 3000,
          healthPath: '/ready',
          start: 'node server.js',
          access: 'public',
          cpus: 4,
          memoryMib: 8192,
          diskSizeGb: 40,
          autoStop: 300,
          autoDelete: 86400,
          autoResume: false,
          network: {
            inbound: 'enabled',
            outbound: { mode: 'enabled', allow_net: ['api.example.com'] }
          }
        })
      );

      let capturedCreateArgs: CreateBoxArgs | undefined;
      const execCalls: Array<{ cmd: string; args: string[] }> = [];
      let stagedFilesAtCopyIn: string[] = [];
      let stagedDirUsed = '';
      let inboundUpdated: string | undefined;
      let tunnelCalled = false;

      const mockBridge = {
        createBox: async (args: CreateBoxArgs) => {
          capturedCreateArgs = args;
          return { boxId: 'box-node-1', name: args.name || 'node-api', status: 'running' };
        },
        exec: async (_boxId: string, cmd: string, args: string[]) => {
          execCalls.push({ cmd, args });
          return { exitCode: 0, stdout: '', stderr: '' };
        },
        copyIn: async (_boxId: string, src: string, _dst: string) => {
          stagedDirUsed = src.replace(/[/\\]\.$/, '');
          stagedFilesAtCopyIn = fs.readdirSync(stagedDirUsed);
          return { copied: true };
        },
        updateInbound: async (_boxId: string, mode: string) => {
          inboundUpdated = mode;
          return { mode };
        },
        tunnel: async (_boxId: string, port: number, isPublic: boolean) => {
          tunnelCalled = true;
          assert.strictEqual(port, 3000);
          assert.strictEqual(isPublic, true);
          return { url: 'https://node-api.boxlite.ai' };
        }
      } as unknown as BoxLiteBridgeClient;

      const mockCreds = {
        getApiKey: async () => 'bl_test_key'
      } as unknown as CredentialsManager;

      const mockLogs = {
        openOrStreamLogs: async () => {}
      } as unknown as LogStreamManager;

      let deploySuccessFired = false;
      const deployer = new BoxLiteDeployer(
        mockBridge,
        mockCreds,
        mockLogs,
        createMockOutputChannel(),
        () => { deploySuccessFired = true; },
        undefined,
        0,
        async () => 200
      );

      await deployer.deployWorkspace();

      // Verify all boxlite.json compute & lifecycle fields were forwarded
      assert.ok(capturedCreateArgs);
      assert.strictEqual(capturedCreateArgs!.image, 'node:20-alpine');
      assert.strictEqual(capturedCreateArgs!.cpus, 4);
      assert.strictEqual(capturedCreateArgs!.memoryMib, 8192);
      assert.strictEqual(capturedCreateArgs!.diskSizeGb, 40);
      assert.strictEqual(capturedCreateArgs!.autoStop, 300);
      assert.strictEqual(capturedCreateArgs!.autoDelete, 86400);
      assert.strictEqual(capturedCreateArgs!.autoResume, false);

      // Verify staging excluded .env and node_modules, and temp dir was cleaned up
      assert.deepStrictEqual(stagedFilesAtCopyIn, ['server.js']);
      assert.strictEqual(fs.existsSync(stagedDirUsed), false, 'Temporary staging directory should be cleaned up');

      // Verify no sequential rm -rf RPCs were sent
      assert.strictEqual(execCalls.some((c) => c.cmd === 'rm'), false);

      // Verify runtime-agnostic restart & health probe (no python3 -c or pkill -f python3)
      const restartCall = execCalls.find((c) => c.cmd === 'sh' && c.args[1]?.includes('node server.js'));
      assert.ok(restartCall, 'Expected runtime-agnostic restart exec for node server.js');
      assert.strictEqual(execCalls.some((c) => c.cmd === 'python3'), false, 'Health probe must not hardcode python3');
      const probeCall = execCalls.find((c) => c.cmd === 'sh' && c.args[1]?.includes('http://127.0.0.1:3000/ready'));
      assert.ok(probeCall, 'Expected shell health probe targeting /ready');

      assert.strictEqual(inboundUpdated, 'enabled');
      assert.strictEqual(tunnelCalled, true);
      assert.strictEqual(deploySuccessFired, true);
    });

    it('respects network.inbound = disabled and skips tunnel creation', async () => {
      const appDir = path.join(tmpDir, 'app');
      fs.mkdirSync(appDir, { recursive: true });
      fs.writeFileSync(path.join(appDir, 'server.py'), 'print("ok")');

      fs.writeFileSync(
        path.join(tmpDir, 'boxlite.json'),
        JSON.stringify({
          name: 'private-worker',
          image: 'python:alpine',
          appDir: './app',
          port: 8080,
          healthPath: '/healthz',
          start: 'python3 -u server.py',
          access: 'private',
          network: {
            inbound: 'disabled',
            outbound: { mode: 'enabled', allow_net: [] }
          }
        })
      );

      let inboundUpdated: string | undefined;
      let tunnelCalled = false;

      const mockBridge = {
        createBox: async () => ({ boxId: 'box-priv-1', name: 'private-worker', status: 'running' }),
        exec: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
        copyIn: async () => ({ copied: true }),
        updateInbound: async (_boxId: string, mode: string) => {
          inboundUpdated = mode;
          return { mode };
        },
        tunnel: async () => {
          tunnelCalled = true;
          return { url: 'https://should-not-happen' };
        }
      } as unknown as BoxLiteBridgeClient;

      const deployer = new BoxLiteDeployer(
        mockBridge,
        { getApiKey: async () => 'bl_test_key' } as unknown as CredentialsManager,
        { openOrStreamLogs: async () => {} } as unknown as LogStreamManager,
        createMockOutputChannel(),
        undefined,
        undefined,
        0,
        async () => 200
      );

      await deployer.deployWorkspace();

      assert.strictEqual(inboundUpdated, 'disabled');
      assert.strictEqual(tunnelCalled, false, 'Tunnel must not be created when network.inbound is disabled');
    });
  });
});
