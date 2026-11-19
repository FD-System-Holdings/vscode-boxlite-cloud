import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { CredentialsManager } from '../auth/credentials';
import { BoxLiteBridgeClient } from '../bridge/client';
import { BoxListItem } from '../bridge/protocol';
import {
  BoxliteCliInfo,
  BoxliteSshCli,
  buildCliContextName,
  CliRunner,
  NodeCliRunner,
  OpenSshInfo,
  SshCliError
} from './cli';
import {
  ensureBoxKeyBundle,
  publicKeysMatch,
  removeBoxKeyBundle,
  writePinnedKnownHosts
} from './keygen';
import { LocalForwarderManager } from './localForwarder';
import {
  extractUserAndHost,
  formatShellCommand,
  ParsedSshSetup,
  parseSetupOutput,
  parseStatusOutput,
  redactSensitiveText,
  shellEscapeArg,
  validateBoxId,
  validateParsedSetup
} from './parse';
import { BoxliteRestSshClient, parseListenPort } from './restClient';
import { SshConfigFileManager, SshHostBlockSpec } from './sshConfig';
import { SshStore, StoredSshConfig } from './sshStore';
import { LocalTunnelBroker } from './tunnelBroker';

const BOXLITE_SSH_DOCS_URL = 'https://docs.boxlite.ai/cloud/ssh';
const BOXLITE_CLI_INSTALL_CMD = 'curl -fsSL https://sh.boxlite.ai | sh';
const REMOTE_SSH_EXTENSION_ID = 'ms-vscode-remote.remote-ssh';
const OPEN_REMOTE_SSH_EXTENSION_ID = 'jeanp413.open-remote-ssh';

export type SshMode = 'sdk' | 'cli';
export type SshTransport = 'auto' | 'forwarder' | 'proxy-command';

export interface SshSettings {
  mode: SshMode;
  transport: SshTransport;
  cliPath: string;
  sshPath: string;
  contextPrefix: string;
  manageConfig: boolean;
}

export class SshService implements vscode.Disposable {
  private activeTerminals = new Map<string, vscode.Terminal>();
  private disposables: vscode.Disposable[] = [];
  private cachedNodeBin: string | null | undefined;
  public readonly restClient: BoxliteRestSshClient;
  public readonly forwarderManager: LocalForwarderManager;
  public readonly tunnelBroker: LocalTunnelBroker;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly bridge: BoxLiteBridgeClient,
    private readonly credentials: CredentialsManager,
    private readonly outputChannel: vscode.OutputChannel,
    private readonly refreshTree?: () => void,
    private readonly cli: BoxliteSshCli = new BoxliteSshCli(),
    public readonly store: SshStore = new SshStore(context),
    private readonly configManager: SshConfigFileManager = new SshConfigFileManager(),
    private readonly runner: CliRunner = new NodeCliRunner(),
    restClient?: BoxliteRestSshClient,
    forwarderManager?: LocalForwarderManager,
    tunnelBroker?: LocalTunnelBroker
  ) {
    this.restClient = restClient ?? new BoxliteRestSshClient();

    const supplyCredentials = async () => {
      const apiKey = await this.credentials.getApiKey();
      if (!apiKey) {
        throw new SshCliError('AUTH_FAILED', 'No BoxLite Cloud API key is configured.');
      }
      return {
        restUrl: this.credentials.getRestUrl(),
        apiKey
      };
    };

    this.forwarderManager =
      forwarderManager ??
      new LocalForwarderManager(
        this.restClient,
        supplyCredentials,
        (msg) => this.log(msg),
        (boxId, err) => {
          this.outputChannel.show(true);
          const detail = err instanceof Error ? err.message : String(err);
          if (
            (err instanceof SshCliError && err.code === 'NETWORK_DISABLED') ||
            detail.includes('created with Outbound Network disabled')
          ) {
            void this.showNetworkDisabledError(detail);
            return;
          }
          void vscode.window
            .showErrorMessage(`SSH tunnel for "${boxId}" failed: ${detail}`, 'Show SSH Output')
            .then((choice) => {
              if (choice === 'Show SSH Output') {
                this.outputChannel.show(true);
              }
            });
        }
      );

    this.tunnelBroker =
      tunnelBroker ??
      new LocalTunnelBroker(
        path.join(this.getStorageRoot(), 'ssh-broker.json'),
        this.restClient,
        supplyCredentials,
        (msg) => this.log(msg)
      );

    if (typeof vscode.window.onDidCloseTerminal === 'function') {
      this.disposables.push(
        vscode.window.onDidCloseTerminal((closed) => {
          for (const [boxId, terminal] of this.activeTerminals.entries()) {
            if (terminal === closed) {
              this.activeTerminals.delete(boxId);
            }
          }
        })
      );
    }
  }

  public dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables = [];
    this.activeTerminals.clear();
    void this.forwarderManager.dispose();
    void this.tunnelBroker.dispose();
  }

  public getSettings(): SshSettings {
    const cfg = vscode.workspace.getConfiguration('boxlite');
    const rawMode = cfg.get<string>('ssh.mode', 'sdk');
    const mode: SshMode = rawMode === 'cli' ? 'cli' : 'sdk';
    const rawTransport = cfg.get<string>('ssh.transport', 'auto');
    const transport: SshTransport =
      rawTransport === 'forwarder' || rawTransport === 'proxy-command' ? rawTransport : 'auto';
    return {
      mode,
      transport,
      cliPath: (cfg.get<string>('ssh.cliPath', 'boxlite') || 'boxlite').trim() || 'boxlite',
      sshPath: (cfg.get<string>('ssh.sshPath', 'ssh') || 'ssh').trim() || 'ssh',
      contextPrefix: (cfg.get<string>('ssh.contextPrefix', 'vscode') || 'vscode').trim() || 'vscode',
      manageConfig: Boolean(cfg.get<boolean>('ssh.manageConfig', false))
    };
  }

  private getStorageRoot(): string {
    if (this.context.globalStorageUri?.fsPath) {
      return this.context.globalStorageUri.fsPath;
    }
    const fallbackDir = path.join(os.tmpdir(), 'boxlite-cloud-ssh');
    fs.mkdirSync(fallbackDir, { recursive: true, mode: 0o700 });
    return fallbackDir;
  }

  private getProxyScriptPath(): string {
    return path.join(this.context.extensionPath || process.cwd(), 'dist', 'ssh-proxy.js');
  }

  private async findNodeExecutable(): Promise<string | undefined> {
    if (this.cachedNodeBin !== undefined) {
      return this.cachedNodeBin ?? undefined;
    }
    const candidate = process.platform === 'win32' ? 'node.exe' : 'node';
    try {
      const res = await this.runner.execFile(candidate, ['--version'], { timeoutMs: 5_000 });
      if (res.exitCode === 0) {
        this.cachedNodeBin = candidate;
        return candidate;
      }
    } catch {
      // Ignore missing node binary
    }
    this.cachedNodeBin = null;
    return undefined;
  }

  private async resolveProxyCommandBin(): Promise<{ bin: string; proxyScript: string } | undefined> {
    const proxyScript = this.getProxyScriptPath();
    if (!fs.existsSync(proxyScript)) {
      return undefined;
    }
    const nodeBin = await this.findNodeExecutable();
    if (!nodeBin) {
      return undefined;
    }
    return { bin: nodeBin, proxyScript };
  }

  private async buildSdkProxyCommand(
    boxId: string,
    restUrl: string,
    targetPort = 22
  ): Promise<string | undefined> {
    const resolved = await this.resolveProxyCommandBin();
    if (!resolved) {
      return undefined;
    }
    const brokerPath = await this.tunnelBroker.ensureStarted();
    const args = [
      resolved.proxyScript,
      '--box',
      boxId,
      '--port',
      String(targetPort),
      '--broker',
      brokerPath,
      '--url',
      restUrl
    ];
    // OpenSSH expands % tokens inside ProxyCommand; double literal % to prevent token substitution.
    const escapeOpenSshPercent = (s: string) => s.replace(/%/g, '%%');
    return `${shellEscapeArg(escapeOpenSshPercent(resolved.bin))} ${args
      .map((a) => shellEscapeArg(escapeOpenSshPercent(a)))
      .join(' ')}`;
  }

  public async getActiveContextName(): Promise<string> {
    const settings = this.getSettings();
    const activeKey = await this.credentials.getActiveKey();
    return buildCliContextName(settings.contextPrefix, activeKey?.id || 'default');
  }

  private log(message: string, extraPaths: string[] = []): void {
    const safe = redactSensitiveText(message, extraPaths);
    try {
      this.outputChannel.appendLine(`[ssh] ${safe}`);
    } catch {
      // Ignore closed channel errors
    }
  }

  private getExtensionFallbackConfigPath(): string {
    return path.join(this.getStorageRoot(), 'boxlite_ssh_config');
  }

  private async runCliPreflight(): Promise<{ cliInfo: BoxliteCliInfo; openSsh: OpenSshInfo; contextName: string }> {
    const settings = this.getSettings();
    const cliInfo = await this.cli.findBoxliteCli(settings.cliPath);
    const openSsh = await this.cli.findOpenSsh(settings.sshPath, true);
    const contextName = await this.getActiveContextName();
    return { cliInfo, openSsh, contextName };
  }

  private async runSdkPreflight(): Promise<{ openSsh: OpenSshInfo; contextName: string }> {
    const settings = this.getSettings();
    const openSsh = await this.cli.findOpenSsh(settings.sshPath, false);
    const contextName = await this.getActiveContextName();
    return { openSsh, contextName };
  }

  private async ensureSdkCredentials(): Promise<{ restUrl: string; apiKey: string } | undefined> {
    let apiKey = await this.credentials.getApiKey();
    if (!apiKey) {
      const choice = await vscode.window.showWarningMessage(
        'Sign in to BoxLite Cloud before connecting via SSH.',
        'Sign In / Set API Key'
      );
      if (choice === 'Sign In / Set API Key') {
        await vscode.commands.executeCommand('boxlite.setApiKey');
        apiKey = await this.credentials.getApiKey();
      }
      if (!apiKey) {
        return undefined;
      }
    }
    return {
      restUrl: this.credentials.getRestUrl(),
      apiKey
    };
  }

  private async ensureCliLoggedIn(cliInfo: BoxliteCliInfo, contextName: string): Promise<boolean> {
    const creds = await this.ensureSdkCredentials();
    if (!creds) {
      return false;
    }

    if (this.store.isContextLoggedIn(contextName, creds.restUrl, creds.apiKey)) {
      return true;
    }

    this.log(`Logging BoxLite CLI context "${contextName}" into ${creds.restUrl}...`);
    await this.cli.cliLogin(cliInfo, contextName, creds.restUrl, creds.apiKey);
    await this.store.markContextLoggedIn(contextName, creds.restUrl, creds.apiKey);
    return true;
  }

  private static isStatusRunning(status: string): boolean {
    const s = (status || '').toLowerCase().trim();
    return s === 'running' || s === 'ready' || s === 'active';
  }

  private static isStatusStopped(status: string): boolean {
    const s = (status || '').toLowerCase().trim();
    return (
      s === 'stopped' ||
      s === 'terminated' ||
      s === 'exited' ||
      s === 'configured' ||
      s === 'paused' ||
      s === 'inactive' ||
      s === 'shutdown'
    );
  }

  private async findBox(boxId: string): Promise<BoxListItem | undefined> {
    const boxes = await this.bridge.listBoxes();
    return boxes.find((b) => b.id === boxId || b.name === boxId);
  }

  private async waitForBoxRunning(boxId: string, timeoutMs = 45_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const box = await this.findBox(boxId);
      if (box && SshService.isStatusRunning(box.status)) {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    return false;
  }

  private async ensureBoxRunning(boxId: string, boxName?: string): Promise<{ ok: boolean; boxName?: string }> {
    const box = await this.findBox(boxId);
    const resolvedName = box?.name || boxName || boxId.slice(0, 8);
    if (!box) {
      return { ok: true, boxName: resolvedName };
    }

    if (SshService.isStatusRunning(box.status)) {
      return { ok: true, boxName: resolvedName };
    }

    if (SshService.isStatusStopped(box.status)) {
      const choice = await vscode.window.showWarningMessage(
        `Box "${resolvedName}" is ${box.status}. Start it before connecting via SSH?`,
        { modal: true },
        'Start Box'
      );
      if (choice !== 'Start Box') {
        return { ok: false, boxName: resolvedName };
      }

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Starting Box "${resolvedName}" for SSH...`,
          cancellable: false
        },
        async () => {
          await this.bridge.startBox(box.id);
          const started = await this.waitForBoxRunning(box.id);
          this.refreshTree?.();
          if (!started) {
            throw new Error(`Timed out waiting for Box "${resolvedName}" to reach running status.`);
          }
        }
      );
      return { ok: true, boxName: resolvedName };
    }

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Waiting for Box "${resolvedName}" (${box.status}) to finish starting...`,
        cancellable: false
      },
      async () => {
        const started = await this.waitForBoxRunning(box.id, 30_000);
        this.refreshTree?.();
        if (!started) {
          throw new Error(`Box "${resolvedName}" is currently "${box.status}" and not ready for SSH.`);
        }
      }
    );
    return { ok: true, boxName: resolvedName };
  }

  private async ensureSdkConfigured(
    openSsh: OpenSshInfo,
    contextName: string,
    boxId: string,
    boxName: string,
    options: { forceSetup?: boolean } = {}
  ): Promise<StoredSshConfig | undefined> {
    const creds = await this.ensureSdkCredentials();
    if (!creds) {
      return undefined;
    }

    const { restUrl, apiKey } = creds;
    this.log(`Ensuring inbound network enabled for box ${boxId} via REST API...`);
    await this.restClient.enableInbound(restUrl, apiKey, boxId);
    await this.restClient.ensureTunnelReachable(restUrl, apiKey, boxId, (msg) => this.log(msg));

    const scopeIdentity = `${restUrl.replace(/\/+$/, '')}|${contextName}`;
    const bundle = ensureBoxKeyBundle(
      this.getStorageRoot(),
      scopeIdentity,
      boxId,
      Boolean(options.forceSetup)
    );
    const hostKeyAlias = `boxlite-${boxId.toLowerCase()}`;
    const existingStored = this.store.get(contextName, boxId);
    const ready = !options.forceSetup && bundle.existed && this.store.hasReadyConfig(contextName, boxId);

    let status;
    let freshlyConfigured = Boolean(options.forceSetup) || !bundle.existed || !ready;

    if (ready) {
      status = await this.restClient.getSshStatus(restUrl, apiKey, boxId);
      if (status.generation === 0) {
        this.log(`Box ${boxId} has generation=0 SSH state; configuring guest SSH via REST API...`, [
          bundle.clientKeyPath,
          bundle.hostKeyPath
        ]);
        status = await this.restClient.configureSsh(restUrl, apiKey, boxId, {
          listen_address: '0.0.0.0:22',
          host_private_key: bundle.hostPrivateKey,
          accounts: [
            { login: 'box', authorized_keys: [bundle.clientPublicKey] },
            { login: 'boxlite', authorized_keys: [bundle.clientPublicKey] }
          ]
        });
        freshlyConfigured = true;
      } else if (!status.enabled) {
        this.log(`Guest SSH disabled on box ${boxId}; enabling saved configuration via REST API...`);
        status = await this.restClient.enableSsh(restUrl, apiKey, boxId);
      }
    } else {
      this.log(`Configuring guest SSH on box ${boxId} via REST API (CLI-free)...`, [
        bundle.clientKeyPath,
        bundle.hostKeyPath
      ]);
      status = await this.restClient.configureSsh(restUrl, apiKey, boxId, {
        listen_address: '0.0.0.0:22',
        host_private_key: bundle.hostPrivateKey,
        accounts: [
          { login: 'box', authorized_keys: [bundle.clientPublicKey] },
          { login: 'boxlite', authorized_keys: [bundle.clientPublicKey] }
        ]
      });
    }

    if (status.host_public_key && !publicKeysMatch(status.host_public_key, bundle.hostPublicKey)) {
      if (options.forceSetup) {
        throw new SshCliError(
          'UNKNOWN',
          `The SSH host key reported for "${boxName}" still does not match the newly generated extension-managed host key.`
        );
      }
      const choice = await vscode.window.showWarningMessage(
        `The SSH host key reported for "${boxName}" does not match the extension-managed host key.\n\nExpected: ${bundle.hostFingerprint}\nReported: ${status.host_key_fingerprint || '(unknown)'}\n\nReset SSH to install a fresh matching host keypair?`,
        { modal: true },
        'Reset SSH...'
      );
      if (choice === 'Reset SSH...') {
        return this.ensureSdkConfigured(openSsh, contextName, boxId, boxName, { forceSetup: true });
      }
      return undefined;
    }

    if (!status.enabled) {
      throw new SshCliError('SSH_DISABLED', `Guest SSH remained disabled on box "${boxName}".`);
    }

    writePinnedKnownHosts(bundle.knownHostsPath, hostKeyAlias, bundle.hostPublicKey);

    const fingerprint = status.host_key_fingerprint || bundle.hostFingerprint;
    const targetPort = parseListenPort(status.listen_address, 22);
    const sshArgs = this.buildSdkLoopbackArgs(
      bundle.clientKeyPath,
      bundle.knownHostsPath,
      hostKeyAlias,
      0,
      'box'
    );

    const stored: StoredSshConfig = {
      boxId,
      boxName,
      contextName,
      mode: 'sdk',
      keyPath: bundle.clientKeyPath,
      knownHostsPath: bundle.knownHostsPath,
      hostKeyAlias,
      hostPublicKey: bundle.hostPublicKey,
      loginUser: 'box',
      targetPort,
      fingerprint,
      sshBin: openSsh.sshBin,
      sshArgs,
      sshCommand: existingStored?.sshCommand || formatShellCommand(openSsh.sshBin, sshArgs),
      configuredAt: existingStored?.configuredAt && !freshlyConfigured
        ? existingStored.configuredAt
        : new Date().toISOString(),
      trustedAt: freshlyConfigured ? undefined : existingStored?.trustedAt
    };

    await this.store.set(contextName, stored);
    await this.fixKeyPermissionsQuietly(stored.keyPath);
    this.refreshTree?.();

    if (freshlyConfigured || !stored.trustedAt) {
      const proceed = await vscode.window.showInformationMessage(
        `SSH configured for "${boxName}" (CLI-free REST & tunnel mode).\n\nHost key fingerprint (pinned to known_hosts):\n${fingerprint}`,
        { modal: true },
        'Continue'
      );
      if (proceed !== 'Continue') {
        return undefined;
      }
      await this.store.markTrusted(contextName, boxId);
      stored.trustedAt = new Date().toISOString();
      const stillRunning = await this.ensureBoxRunning(boxId, boxName);
      if (!stillRunning.ok) {
        return undefined;
      }
      try {
        const postStatus = await this.restClient.getSshStatus(restUrl, apiKey, boxId);
        if (!postStatus.enabled && postStatus.generation > 0) {
          this.log(`Guest SSH became disabled on box ${boxId}; enabling saved configuration via REST API...`);
          const enabledPost = await this.restClient.enableSsh(restUrl, apiKey, boxId);
          const refreshedPort = parseListenPort(enabledPost.listen_address, stored.targetPort ?? 22);
          if (refreshedPort !== stored.targetPort) {
            stored.targetPort = refreshedPort;
            await this.store.set(contextName, stored);
          }
        }
      } catch (err) {
        if (!(err instanceof SshCliError && err.code === 'BOX_NOT_FOUND')) {
          throw err;
        }
      }
    }

    return stored;
  }

  private buildSdkLoopbackArgs(
    clientKeyPath: string,
    knownHostsPath: string,
    hostKeyAlias: string,
    localPort: number,
    loginUser = 'box'
  ): string[] {
    return [
      '-p',
      String(localPort),
      '-i',
      clientKeyPath,
      '-o',
      'IdentitiesOnly=yes',
      '-o',
      'StrictHostKeyChecking=yes',
      '-o',
      `UserKnownHostsFile=${knownHostsPath}`,
      '-o',
      `HostKeyAlias=${hostKeyAlias}`,
      `${loginUser}@127.0.0.1`
    ];
  }

  private async runCliSetupAndPersist(
    cliInfo: BoxliteCliInfo,
    openSsh: OpenSshInfo,
    contextName: string,
    boxId: string,
    boxName: string,
    showTrustModal: boolean
  ): Promise<StoredSshConfig | undefined> {
    this.log(`Running CLI SSH setup for box ${boxId} in context ${contextName}...`);
    const res = await this.cli.sshSetup(cliInfo, contextName, boxId);
    const parsed: ParsedSshSetup = parseSetupOutput(res.stdout, res.stderr);
    const validation = validateParsedSetup(parsed, (p) => fs.existsSync(p));

    if (!validation.valid) {
      this.log(`Setup output validation failed: ${validation.errors.join('; ')}`, parsed.keyPath ? [parsed.keyPath] : []);
      this.log(`Raw setup output:\n${parsed.raw}`, parsed.keyPath ? [parsed.keyPath] : []);
      this.outputChannel.show(true);
      const action = await vscode.window.showErrorMessage(
        `Could not parse "boxlite ssh" output: ${validation.errors[0]}`,
        'Copy Raw Output',
        'Show Output'
      );
      if (action === 'Copy Raw Output') {
        await vscode.env.clipboard.writeText(parsed.raw);
        vscode.window.showInformationMessage('Raw SSH setup output copied to clipboard.');
      } else if (action === 'Show Output') {
        this.outputChannel.show(true);
      }
      return undefined;
    }

    const sshBin =
      parsed.sshBin && path.basename(parsed.sshBin).toLowerCase().startsWith('ssh')
        ? (parsed.sshBin === 'ssh' || parsed.sshBin === 'ssh.exe' ? openSsh.sshBin : parsed.sshBin)
        : openSsh.sshBin;

    const stored: StoredSshConfig = {
      boxId,
      boxName,
      contextName,
      mode: 'cli',
      keyPath: parsed.keyPath!,
      fingerprint: parsed.fingerprint || '',
      sshBin,
      sshArgs: parsed.sshArgs,
      sshCommand: parsed.sshCommand,
      proxyCommand: parsed.proxyCommand,
      configuredAt: new Date().toISOString()
    };

    await this.store.set(contextName, stored);
    await this.fixKeyPermissionsQuietly(stored.keyPath);

    if (this.getSettings().manageConfig && stored.proxyCommand) {
      try {
        const upsert = this.configManager.upsertHost({
          boxId,
          boxName,
          hostName: parsed.host || boxId,
          user: parsed.user || 'boxlite',
          identityFile: stored.keyPath,
          proxyCommand: stored.proxyCommand,
          port: parsed.port
        });
        stored.hostAlias = upsert.alias;
        await this.store.set(contextName, stored);
      } catch (err: any) {
        this.log(`Failed to update managed SSH config: ${err?.message || err}`, [stored.keyPath]);
      }
    }

    this.refreshTree?.();

    if (showTrustModal) {
      const fpLine = stored.fingerprint
        ? `Host key fingerprint:\n${stored.fingerprint}`
        : 'Host key fingerprint was not reported by the CLI.';
      const proceed = await vscode.window.showInformationMessage(
        `SSH configured for "${boxName}".\n\n${fpLine}\n\nCompare this fingerprint when OpenSSH prompts to trust the host on first connection.`,
        { modal: true },
        'Continue'
      );
      if (proceed !== 'Continue') {
        return undefined;
      }
      await this.store.markTrusted(contextName, boxId);
      stored.trustedAt = new Date().toISOString();
    }

    return stored;
  }

  private async ensureCliConfigured(
    cliInfo: BoxliteCliInfo,
    openSsh: OpenSshInfo,
    contextName: string,
    boxId: string,
    boxName: string,
    options: { forceSetup?: boolean } = {}
  ): Promise<StoredSshConfig | undefined> {
    const loggedIn = await this.ensureCliLoggedIn(cliInfo, contextName);
    if (!loggedIn) {
      return undefined;
    }

    try {
      await this.cli.ensureInbound(cliInfo, contextName, boxId);
    } catch (err) {
      if (err instanceof SshCliError && err.code === 'AUTH_FAILED') {
        await this.store.clearContextLogin(contextName);
        const retryLogin = await this.ensureCliLoggedIn(cliInfo, contextName);
        if (!retryLogin) {
          return undefined;
        }
        await this.cli.ensureInbound(cliInfo, contextName, boxId);
      } else {
        throw err;
      }
    }

    if (options.forceSetup) {
      return this.runCliSetupAndPersist(cliInfo, openSsh, contextName, boxId, boxName, true);
    }

    const ready = this.store.hasReadyConfig(contextName, boxId);
    if (!ready) {
      return this.runCliSetupAndPersist(cliInfo, openSsh, contextName, boxId, boxName, true);
    }

    const stored = this.store.get(contextName, boxId)!;
    const statusRes = await this.cli.sshStatus(cliInfo, contextName, boxId);
    const status = parseStatusOutput(statusRes.stdout, statusRes.stderr);

    if (status.configured === false) {
      this.log(`Box ${boxId} reports SSH not configured; running setup...`);
      return this.runCliSetupAndPersist(cliInfo, openSsh, contextName, boxId, boxName, true);
    }

    if (status.enabled === false) {
      this.log(`SSH is disabled on box ${boxId}; enabling saved configuration...`);
      await this.cli.sshEnable(cliInfo, contextName, boxId);
    }

    if (status.fingerprint && stored.fingerprint && status.fingerprint !== stored.fingerprint) {
      const choice = await vscode.window.showWarningMessage(
        `The SSH host key fingerprint for "${boxName}" has changed.\n\nStored: ${stored.fingerprint}\nCurrent (ssh --status): ${status.fingerprint}\n\nProceed only if you expected this change.`,
        { modal: true },
        'Trust & Update',
        'Reset SSH...'
      );
      if (choice === 'Trust & Update') {
        await this.store.updateFingerprintAndTrust(contextName, boxId, status.fingerprint);
        return this.store.get(contextName, boxId);
      }
      if (choice === 'Reset SSH...') {
        return this.runCliSetupAndPersist(cliInfo, openSsh, contextName, boxId, boxName, true);
      }
      return undefined;
    }

    if (!stored.trustedAt) {
      const fpLine = stored.fingerprint
        ? `Host key fingerprint:\n${stored.fingerprint}`
        : 'Compare the host key fingerprint shown by OpenSSH on first connection.';
      const proceed = await vscode.window.showInformationMessage(
        `Connect to "${boxName}" via SSH.\n\n${fpLine}`,
        { modal: true },
        'Continue'
      );
      if (proceed !== 'Continue') {
        return undefined;
      }
      await this.store.markTrusted(contextName, boxId);
      stored.trustedAt = new Date().toISOString();
    }

    return stored;
  }

  private async fixKeyPermissionsQuietly(keyPath: string): Promise<void> {
    if (!keyPath || !fs.existsSync(keyPath)) {
      return;
    }
    if (process.platform !== 'win32') {
      try {
        const stat = fs.statSync(keyPath);
        if ((stat.mode & 0o077) !== 0) {
          fs.chmodSync(keyPath, 0o600);
          this.log('Applied chmod 600 to SSH private key.', [keyPath]);
        }
      } catch (err: any) {
        this.log(`Could not chmod private key: ${err?.message || err}`, [keyPath]);
      }
    }
  }

  public async fixKeyPermissionsInteractive(keyPath: string): Promise<boolean> {
    if (!keyPath || !fs.existsSync(keyPath)) {
      vscode.window.showWarningMessage('SSH private key file was not found on disk.');
      return false;
    }
    if (process.platform !== 'win32') {
      fs.chmodSync(keyPath, 0o600);
      vscode.window.showInformationMessage('Updated private key permissions to 600.');
      return true;
    }

    const username = process.env.USERNAME || process.env.USER;
    if (!username) {
      vscode.window.showWarningMessage(
        `Run icacls "${keyPath}" /inheritance:r /grant:r "%USERNAME%:R" to restrict key permissions.`
      );
      return false;
    }
    const res = await this.runner.execFile('icacls', [
      keyPath,
      '/inheritance:r',
      '/grant:r',
      `${username}:R`
    ]);
    if (res.exitCode === 0) {
      vscode.window.showInformationMessage('Updated Windows ACL permissions on SSH private key.');
      return true;
    }
    vscode.window.showErrorMessage(`Failed to update Windows ACL: ${res.stderr || res.stdout}`);
    return false;
  }

  private isTerminalAlive(terminal: vscode.Terminal): boolean {
    if (Array.isArray(vscode.window.terminals)) {
      return vscode.window.terminals.includes(terminal);
    }
    return true;
  }

  private openSshTerminal(
    boxId: string,
    boxName: string,
    sshBin: string,
    sshArgs: string[],
    fallbackCommand: string
  ): void {
    const existing = this.activeTerminals.get(boxId);
    if (existing && this.isTerminalAlive(existing)) {
      existing.show();
      return;
    }

    const title = `SSH: ${boxName || boxId.slice(0, 8)}`;
    let terminal: vscode.Terminal;
    if (sshBin && Array.isArray(sshArgs) && sshArgs.length > 0) {
      try {
        terminal = vscode.window.createTerminal({
          name: title,
          shellPath: sshBin,
          shellArgs: sshArgs
        });
      } catch {
        terminal = vscode.window.createTerminal({ name: title });
        terminal.sendText(formatShellCommand(sshBin, sshArgs));
      }
    } else {
      terminal = vscode.window.createTerminal({ name: title });
      terminal.sendText(fallbackCommand);
    }

    this.activeTerminals.set(boxId, terminal);
    terminal.show();
  }

  private async showNetworkDisabledError(message: string): Promise<void> {
    const choice = await vscode.window.showErrorMessage(
      message,
      'Create Box with Options...',
      'Show SSH Output'
    );
    if (choice === 'Create Box with Options...') {
      await vscode.commands.executeCommand('boxlite.createBoxWithOptions');
    } else if (choice === 'Show SSH Output') {
      this.outputChannel.show(true);
    }
  }

  private async handleSshError(err: unknown, boxId?: string, boxName?: string): Promise<void> {
    if (err instanceof SshCliError) {
      this.log(`Error [${err.code}]: ${err.message}`);
      switch (err.code) {
        case 'NETWORK_DISABLED': {
          await this.showNetworkDisabledError(err.message);
          return;
        }
        case 'CLI_NOT_FOUND': {
          const action = await vscode.window.showErrorMessage(
            err.message,
            'Open Install Docs',
            'Configure CLI Path'
          );
          if (action === 'Open Install Docs') {
            await vscode.env.openExternal(vscode.Uri.parse(BOXLITE_SSH_DOCS_URL));
          } else if (action === 'Configure CLI Path') {
            await vscode.commands.executeCommand('workbench.action.openSettings', 'boxlite.ssh.cliPath');
          }
          return;
        }
        case 'SSH_SUBCOMMAND_UNSUPPORTED': {
          const action = await vscode.window.showErrorMessage(
            `Update the BoxLite CLI to use Cloud SSH (${BOXLITE_CLI_INSTALL_CMD}).`,
            'Copy Install Command',
            'Open SSH Docs'
          );
          if (action === 'Copy Install Command') {
            await vscode.env.clipboard.writeText(BOXLITE_CLI_INSTALL_CMD);
            vscode.window.showInformationMessage('CLI install command copied to clipboard.');
          } else if (action === 'Open SSH Docs') {
            await vscode.env.openExternal(vscode.Uri.parse(BOXLITE_SSH_DOCS_URL));
          }
          return;
        }
        case 'OPENSSH_NOT_FOUND': {
          const action = await vscode.window.showErrorMessage(
            err.message,
            'Open SSH Docs',
            'Configure SSH Path'
          );
          if (action === 'Open SSH Docs') {
            await vscode.env.openExternal(vscode.Uri.parse(BOXLITE_SSH_DOCS_URL));
          } else if (action === 'Configure SSH Path') {
            await vscode.commands.executeCommand('workbench.action.openSettings', 'boxlite.ssh.sshPath');
          }
          return;
        }
        case 'AUTH_FAILED':
        case 'BOX_NOT_FOUND': {
          const action = await vscode.window.showErrorMessage(
            err.message,
            'Sign In / Set API Key',
            'Open SSH Docs'
          );
          if (action === 'Sign In / Set API Key') {
            await vscode.commands.executeCommand('boxlite.setApiKey');
          } else if (action === 'Open SSH Docs') {
            await vscode.env.openExternal(vscode.Uri.parse(BOXLITE_SSH_DOCS_URL));
          }
          return;
        }
        case 'PERMISSION_DENIED_KEY': {
          const contextName = await this.getActiveContextName();
          const stored = boxId ? this.store.get(contextName, boxId) : undefined;
          const action = await vscode.window.showErrorMessage(err.message, 'Fix Key Permissions');
          if (action === 'Fix Key Permissions' && stored?.keyPath) {
            await this.fixKeyPermissionsInteractive(stored.keyPath);
          }
          return;
        }
        case 'PUBLICKEY_AUTH_FAILED': {
          const action = await vscode.window.showErrorMessage(err.message, 'Reset SSH');
          if (action === 'Reset SSH' && boxId) {
            await this.setup(boxId, boxName);
          }
          return;
        }
        default: {
          const action = await vscode.window.showErrorMessage(
            `SSH operation failed: ${err.message}`,
            'Show SSH Output'
          );
          if (action === 'Show SSH Output') {
            this.outputChannel.show(true);
          }
          return;
        }
      }
    }

    const message = err instanceof Error ? err.message : String(err);
    this.log(`Unexpected SSH error: ${message}`);
    vscode.window.showErrorMessage(`SSH operation failed: ${message}`);
  }

  public async connect(rawBoxId: string, boxName?: string): Promise<void> {
    let boxId: string;
    try {
      boxId = validateBoxId(rawBoxId);
    } catch (err: any) {
      vscode.window.showErrorMessage(err.message);
      return;
    }

    const existing = this.activeTerminals.get(boxId);
    if (existing && this.isTerminalAlive(existing)) {
      existing.show();
      return;
    }

    const settings = this.getSettings();

    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Connecting to ${boxName || boxId.slice(0, 8)} via SSH...`,
          cancellable: false
        },
        async () => {
          if (settings.mode === 'cli') {
            const { cliInfo, openSsh, contextName } = await this.runCliPreflight();
            const running = await this.ensureBoxRunning(boxId, boxName);
            if (!running.ok) {
              return;
            }
            const resolvedName = running.boxName || boxName || boxId.slice(0, 8);
            const config = await this.ensureCliConfigured(cliInfo, openSsh, contextName, boxId, resolvedName);
            if (!config) {
              return;
            }
            await this.fixKeyPermissionsQuietly(config.keyPath);
            this.openSshTerminal(boxId, resolvedName, config.sshBin, config.sshArgs, config.sshCommand);
            return;
          }

          const { openSsh, contextName } = await this.runSdkPreflight();
          const running = await this.ensureBoxRunning(boxId, boxName);
          if (!running.ok) {
            return;
          }
          const resolvedName = running.boxName || boxName || boxId.slice(0, 8);
          const config = await this.ensureSdkConfigured(openSsh, contextName, boxId, resolvedName);
          if (!config) {
            return;
          }
          await this.fixKeyPermissionsQuietly(config.keyPath);

          const { port: localPort } = await this.forwarderManager.ensureForwarder(
            boxId,
            config.targetPort || 22
          );
          const loopArgs = this.buildSdkLoopbackArgs(
            config.keyPath,
            config.knownHostsPath!,
            config.hostKeyAlias!,
            localPort,
            config.loginUser || 'box'
          );
          this.openSshTerminal(
            boxId,
            resolvedName,
            openSsh.sshBin,
            loopArgs,
            formatShellCommand(openSsh.sshBin, loopArgs)
          );
        }
      );
    } catch (err) {
      await this.handleSshError(err, boxId, boxName);
    }
  }

  public async setup(rawBoxId: string, boxName?: string): Promise<void> {
    let boxId: string;
    try {
      boxId = validateBoxId(rawBoxId);
    } catch (err: any) {
      vscode.window.showErrorMessage(err.message);
      return;
    }

    const settings = this.getSettings();

    try {
      if (settings.mode === 'cli') {
        const { cliInfo, openSsh, contextName } = await this.runCliPreflight();
        const running = await this.ensureBoxRunning(boxId, boxName);
        if (!running.ok) {
          return;
        }
        const resolvedName = running.boxName || boxName || boxId.slice(0, 8);
        const alreadyReady = this.store.hasReadyConfig(contextName, boxId);

        if (alreadyReady) {
          const confirm = await vscode.window.showWarningMessage(
            `Set up / Reset SSH for "${resolvedName}"? This replaces the SSH key configuration and disconnects existing clients.`,
            { modal: true },
            'Reset SSH'
          );
          if (confirm !== 'Reset SSH') {
            return;
          }
          this.configManager.removeHost(boxId);
        }

        const config = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `Configuring SSH for "${resolvedName}"...`,
            cancellable: false
          },
          async () =>
            this.ensureCliConfigured(cliInfo, openSsh, contextName, boxId, resolvedName, {
              forceSetup: true
            })
        );

        if (!config) {
          return;
        }

        const next = await vscode.window.showInformationMessage(
          `SSH is configured for "${resolvedName}".`,
          'Connect Now',
          'Copy Command'
        );
        if (next === 'Connect Now') {
          this.openSshTerminal(boxId, resolvedName, config.sshBin, config.sshArgs, config.sshCommand);
        } else if (next === 'Copy Command') {
          await vscode.env.clipboard.writeText(config.sshCommand);
          vscode.window.showInformationMessage('SSH command copied to clipboard.');
        }
        return;
      }

      const { openSsh, contextName } = await this.runSdkPreflight();
      const running = await this.ensureBoxRunning(boxId, boxName);
      if (!running.ok) {
        return;
      }
      const resolvedName = running.boxName || boxName || boxId.slice(0, 8);
      const alreadyReady = this.store.hasReadyConfig(contextName, boxId);

      if (alreadyReady) {
        const confirm = await vscode.window.showWarningMessage(
          `Set up / Reset SSH for "${resolvedName}"? This replaces the SSH key configuration and disconnects existing clients.`,
          { modal: true },
          'Reset SSH'
        );
        if (confirm !== 'Reset SSH') {
          return;
        }
        this.configManager.removeHost(boxId);
      }

      const config = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Configuring SSH for "${resolvedName}"...`,
          cancellable: false
        },
        async () =>
          this.ensureSdkConfigured(openSsh, contextName, boxId, resolvedName, {
            forceSetup: true
          })
      );

      if (!config) {
        return;
      }

      if (settings.manageConfig) {
        await this.upsertSdkManagedConfig(config, resolvedName, this.configManager.getDefaultConfigPath());
      }

      const next = await vscode.window.showInformationMessage(
        `SSH is configured for "${resolvedName}".`,
        'Connect Now',
        'Copy Command'
      );
      if (next === 'Connect Now') {
        await this.connect(boxId, resolvedName);
      } else if (next === 'Copy Command') {
        await this.copyCommand(boxId, resolvedName);
      }
    } catch (err) {
      await this.handleSshError(err, boxId, boxName);
    }
  }

  public async copyCommand(rawBoxId: string, boxName?: string): Promise<void> {
    let boxId: string;
    try {
      boxId = validateBoxId(rawBoxId);
    } catch (err: any) {
      vscode.window.showErrorMessage(err.message);
      return;
    }

    const settings = this.getSettings();

    try {
      if (settings.mode === 'cli') {
        const contextName = await this.getActiveContextName();
        let stored = this.store.get(contextName, boxId);
        if (!stored || !this.store.hasReadyConfig(contextName, boxId)) {
          const { cliInfo, openSsh } = await this.runCliPreflight();
          const running = await this.ensureBoxRunning(boxId, boxName);
          if (!running.ok) {
            return;
          }
          stored = await this.ensureCliConfigured(
            cliInfo,
            openSsh,
            contextName,
            boxId,
            running.boxName || boxName || boxId.slice(0, 8)
          );
        }

        if (!stored) {
          return;
        }

        const cmd = stored.sshCommand || formatShellCommand(stored.sshBin, stored.sshArgs);
        await vscode.env.clipboard.writeText(cmd);
        vscode.window.showInformationMessage(`SSH command for "${stored.boxName || boxId}" copied to clipboard.`);
        return;
      }

      const { openSsh, contextName } = await this.runSdkPreflight();
      let stored = this.store.get(contextName, boxId);
      if (!stored || !this.store.hasReadyConfig(contextName, boxId)) {
        const running = await this.ensureBoxRunning(boxId, boxName);
        if (!running.ok) {
          return;
        }
        stored = await this.ensureSdkConfigured(
          openSsh,
          contextName,
          boxId,
          running.boxName || boxName || boxId.slice(0, 8)
        );
      }

      if (!stored) {
        return;
      }

      const restUrl = this.credentials.getRestUrl();
      const targetPort = stored.targetPort || 22;
      const proxyCmd =
        settings.transport !== 'forwarder'
          ? await this.buildSdkProxyCommand(boxId, restUrl, targetPort)
          : undefined;

      let args: string[];
      if (proxyCmd) {
        args = [
          '-i',
          stored.keyPath,
          '-o',
          'IdentitiesOnly=yes',
          '-o',
          'StrictHostKeyChecking=yes',
          '-o',
          `UserKnownHostsFile=${stored.knownHostsPath}`,
          '-o',
          `HostKeyAlias=${stored.hostKeyAlias}`,
          '-o',
          `ProxyCommand=${proxyCmd}`,
          `${stored.loginUser || 'box'}@${stored.hostKeyAlias}`
        ];
      } else {
        const { port: localPort } = await this.forwarderManager.ensureForwarder(boxId, targetPort);
        args = this.buildSdkLoopbackArgs(
          stored.keyPath,
          stored.knownHostsPath!,
          stored.hostKeyAlias!,
          localPort,
          stored.loginUser || 'box'
        );
      }

      const cmd = formatShellCommand(openSsh.sshBin, args);
      await vscode.env.clipboard.writeText(cmd);
      vscode.window.showInformationMessage(`SSH command for "${stored.boxName || boxId}" copied to clipboard.`);
    } catch (err) {
      await this.handleSshError(err, boxId, boxName);
    }
  }

  public async disable(rawBoxId: string, boxName?: string): Promise<void> {
    let boxId: string;
    try {
      boxId = validateBoxId(rawBoxId);
    } catch (err: any) {
      vscode.window.showErrorMessage(err.message);
      return;
    }

    const displayName = boxName || boxId.slice(0, 8);
    const confirm = await vscode.window.showWarningMessage(
      `Disable SSH and close the port 22 tunnel for "${displayName}"? Existing SSH clients will be disconnected.`,
      { modal: true },
      'Disable SSH'
    );
    if (confirm !== 'Disable SSH') {
      return;
    }

    const settings = this.getSettings();

    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Disabling SSH for "${displayName}"...`,
          cancellable: false
        },
        async () => {
          const contextName = await this.getActiveContextName();
          const targetPort = this.store.get(contextName, boxId)?.targetPort || 22;

          if (settings.mode === 'cli') {
            const { cliInfo } = await this.runCliPreflight();
            const loggedIn = await this.ensureCliLoggedIn(cliInfo, contextName);
            if (!loggedIn) {
              return;
            }
            // Always revoke tunnel before disabling SSH per BoxLite Cloud docs
            await this.cli.revokeTunnel(cliInfo, contextName, boxId, targetPort);
            await this.cli.sshDisable(cliInfo, contextName, boxId);
          } else {
            const creds = await this.ensureSdkCredentials();
            if (!creds) {
              return;
            }
            // Always revoke tunnel before disabling SSH per BoxLite Cloud docs
            // Ignore 404 (no active tunnel on targetPort) so disableSsh and local cleanup still run
            try {
              await this.restClient.revokeTunnel(creds.restUrl, creds.apiKey, boxId, targetPort);
            } catch (revokeErr) {
              if (!(revokeErr instanceof SshCliError && revokeErr.code === 'BOX_NOT_FOUND')) {
                throw revokeErr;
              }
            }
            await this.restClient.disableSsh(creds.restUrl, creds.apiKey, boxId);
            await this.forwarderManager.stopForwarder(boxId, targetPort);

            const scopeIdentity = `${creds.restUrl.replace(/\/+$/, '')}|${contextName}`;
            removeBoxKeyBundle(this.getStorageRoot(), scopeIdentity, boxId);
          }

          await this.store.remove(contextName, boxId);
          this.configManager.removeHost(boxId);
          this.configManager.removeHost(boxId, this.getExtensionFallbackConfigPath());

          const terminal = this.activeTerminals.get(boxId);
          if (terminal) {
            try {
              terminal.dispose();
            } catch {}
            this.activeTerminals.delete(boxId);
          }

          this.refreshTree?.();
          vscode.window.showInformationMessage(`SSH disabled and port 22 tunnel closed for "${displayName}".`);
        }
      );
    } catch (err) {
      await this.handleSshError(err, boxId, boxName);
    }
  }

  private async upsertSdkManagedConfig(
    config: StoredSshConfig,
    boxName: string,
    targetConfigPath: string
  ): Promise<{ alias: string; configPath: string }> {
    const settings = this.getSettings();
    const restUrl = this.credentials.getRestUrl();
    const useProxyCommand =
      settings.transport === 'proxy-command' ||
      (settings.transport === 'auto' && Boolean(await this.resolveProxyCommandBin()));

    const targetPort = config.targetPort || 22;
    const proxyCmd = useProxyCommand
      ? await this.buildSdkProxyCommand(config.boxId, restUrl, targetPort)
      : undefined;

    let specBase: Omit<SshHostBlockSpec, 'alias'> & { boxName?: string };
    if (proxyCmd) {
      specBase = {
        boxId: config.boxId,
        boxName,
        hostName: config.hostKeyAlias || config.boxId,
        user: config.loginUser || 'box',
        identityFile: config.keyPath,
        userKnownHostsFile: config.knownHostsPath,
        hostKeyAlias: config.hostKeyAlias,
        strictHostKeyChecking: 'yes',
        proxyCommand: proxyCmd
      };
    } else {
      const { port: localPort } = await this.forwarderManager.ensureForwarder(config.boxId, targetPort);
      specBase = {
        boxId: config.boxId,
        boxName,
        hostName: '127.0.0.1',
        port: String(localPort),
        user: config.loginUser || 'box',
        identityFile: config.keyPath,
        userKnownHostsFile: config.knownHostsPath,
        hostKeyAlias: config.hostKeyAlias,
        strictHostKeyChecking: 'yes'
      };
    }

    const res = this.configManager.upsertHost(specBase, targetConfigPath);
    return { alias: res.alias, configPath: res.configPath };
  }

  public async openRemote(rawBoxId: string, boxName?: string): Promise<void> {
    let boxId: string;
    try {
      boxId = validateBoxId(rawBoxId);
    } catch (err: any) {
      vscode.window.showErrorMessage(err.message);
      return;
    }

    const remoteExt =
      vscode.extensions.getExtension(REMOTE_SSH_EXTENSION_ID) ||
      vscode.extensions.getExtension(OPEN_REMOTE_SSH_EXTENSION_ID);

    if (!remoteExt) {
      const action = await vscode.window.showWarningMessage(
        'VS Code Remote-SSH (ms-vscode-remote.remote-ssh) is required to open a Box in a remote VS Code window.',
        'Install Remote-SSH'
      );
      if (action === 'Install Remote-SSH') {
        await vscode.commands.executeCommand('workbench.extensions.installExtension', REMOTE_SSH_EXTENSION_ID);
      }
      return;
    }

    const settings = this.getSettings();

    try {
      let resolvedName = boxName || boxId.slice(0, 8);
      let config: StoredSshConfig | undefined;

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Preparing Remote-SSH for "${resolvedName}"...`,
          cancellable: false
        },
        async () => {
          if (settings.mode === 'cli') {
            const { cliInfo, openSsh, contextName } = await this.runCliPreflight();
            const running = await this.ensureBoxRunning(boxId, boxName);
            if (!running.ok) {
              return;
            }
            resolvedName = running.boxName || resolvedName;
            config = await this.ensureCliConfigured(cliInfo, openSsh, contextName, boxId, resolvedName);
          } else {
            const { openSsh, contextName } = await this.runSdkPreflight();
            const running = await this.ensureBoxRunning(boxId, boxName);
            if (!running.ok) {
              return;
            }
            resolvedName = running.boxName || resolvedName;
            config = await this.ensureSdkConfigured(openSsh, contextName, boxId, resolvedName);
          }
        }
      );

      if (!config) {
        return;
      }

      if (settings.mode === 'cli' && !config.proxyCommand) {
        vscode.window.showErrorMessage('Missing ProxyCommand in SSH setup; cannot configure Remote-SSH.');
        return;
      }

      const writeTargetHost = async (targetPath: string): Promise<string> => {
        if (settings.mode === 'sdk') {
          const res = await this.upsertSdkManagedConfig(config!, resolvedName, targetPath);
          return res.alias;
        }
        const { user, host, port } = extractUserAndHost(config!.sshArgs);
        return this.configManager.upsertHost(
          {
            boxId,
            boxName: resolvedName,
            hostName: host || boxId,
            user: user || 'boxlite',
            identityFile: config!.keyPath,
            proxyCommand: config!.proxyCommand,
            port
          },
          targetPath
        ).alias;
      };

      let alias: string | undefined;
      const suggestedAlias = this.configManager.resolveAlias(resolvedName, boxId);

      if (settings.manageConfig) {
        alias = await writeTargetHost(this.configManager.getDefaultConfigPath());
      } else {
        const choice = await vscode.window.showInformationMessage(
          `Add Host "${suggestedAlias}" to ~/.ssh/config so VS Code Remote-SSH can connect?`,
          { modal: true },
          'Add to ~/.ssh/config',
          'Always Manage Config',
          'Use Extension Config File'
        );

        if (!choice) {
          return;
        }

        if (choice === 'Add to ~/.ssh/config') {
          alias = await writeTargetHost(this.configManager.getDefaultConfigPath());
        } else if (choice === 'Always Manage Config') {
          await vscode.workspace.getConfiguration('boxlite').update(
            'ssh.manageConfig',
            true,
            vscode.ConfigurationTarget.Global
          );
          alias = await writeTargetHost(this.configManager.getDefaultConfigPath());
        } else if (choice === 'Use Extension Config File') {
          const fallbackPath = this.getExtensionFallbackConfigPath();
          alias = await writeTargetHost(fallbackPath);
          const remoteCfg = vscode.workspace.getConfiguration('remote.SSH');
          const currentRemoteFile = remoteCfg.get<string>('configFile');
          if (currentRemoteFile !== fallbackPath) {
            const setCfg = await vscode.window.showInformationMessage(
              `Wrote "${alias}" to ${fallbackPath}. Set "remote.SSH.configFile" to this file now?`,
              { modal: true },
              'Set remote.SSH.configFile'
            );
            if (setCfg === 'Set remote.SSH.configFile') {
              await remoteCfg.update('configFile', fallbackPath, vscode.ConfigurationTarget.Global);
            } else {
              const includeLine = `Include "${fallbackPath}"`;
              const copyBtn = await vscode.window.showInformationMessage(
                `Add "${includeLine}" to your ~/.ssh/config so Remote-SSH can find "${alias}".`,
                'Copy Include Line'
              );
              if (copyBtn === 'Copy Include Line') {
                await vscode.env.clipboard.writeText(includeLine);
              }
              return;
            }
          }
        }
      }

      if (!alias) {
        return;
      }

      const contextName = await this.getActiveContextName();
      await this.store.set(contextName, { ...config, hostAlias: alias });

      try {
        await vscode.commands.executeCommand('opensshremotes.openEmptyWindow', { host: alias });
      } catch {
        const remoteUri = vscode.Uri.parse(`vscode-remote://ssh-remote+${alias}/home/boxlite`);
        await vscode.commands.executeCommand('vscode.openFolder', remoteUri, { forceNewWindow: true });
      }
    } catch (err) {
      await this.handleSshError(err, boxId, boxName);
    }
  }

  public async removeConfigEntries(): Promise<void> {
    const confirm = await vscode.window.showWarningMessage(
      'Remove all BoxLite-managed SSH host blocks from ~/.ssh/config?',
      { modal: true },
      'Remove Entries'
    );
    if (confirm !== 'Remove Entries') {
      return;
    }

    const removedDefault = this.configManager.removeAllHosts();
    const removedFallback = this.configManager.removeAllHosts(this.getExtensionFallbackConfigPath());
    const total = removedDefault + removedFallback;

    if (total === 0) {
      vscode.window.showInformationMessage('No BoxLite-managed SSH config entries were found.');
    } else {
      vscode.window.showInformationMessage(`Removed ${total} BoxLite-managed SSH config ${total === 1 ? 'entry' : 'entries'}.`);
    }
  }
}
