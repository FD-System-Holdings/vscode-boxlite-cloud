import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as https from 'https';
import * as http from 'http';
import { BoxLiteBridgeClient } from '../bridge/client';
import { SecretSpec } from '../bridge/protocol';
import { CredentialsManager } from '../auth/credentials';
import { SecretsManager } from '../auth/secretsStore';
import { ProjectManager, buildSupervisorEntrypoint } from './project';
import { LogStreamManager } from '../logs/logStream';
import { formatErrorWithDiagnosis } from '../util/diagnosis';
import { formatSecretPlaceholder, validateEnvAgainstSecrets } from '../util/validation';

export function matchesIgnorePattern(entryName: string, relativePath: string, patterns: string[]): boolean {
  const normalizedRel = relativePath.replace(/\\/g, '/');
  for (const rawPattern of patterns) {
    const pattern = rawPattern.trim().replace(/\/+$/, '');
    if (!pattern) {
      continue;
    }
    if (pattern.startsWith('*')) {
      const suffix = pattern.slice(1);
      if (entryName.endsWith(suffix) || normalizedRel.endsWith(suffix)) {
        return true;
      }
    } else if (
      entryName === pattern ||
      normalizedRel === pattern ||
      normalizedRel.startsWith(`${pattern}/`)
    ) {
      return true;
    }
  }
  return false;
}

export function isPathWithinRoot(rootDir: string, candidatePath: string): boolean {
  const resolvedRoot = path.resolve(rootDir);
  const resolvedCandidate = path.resolve(candidatePath);
  const rel = path.relative(resolvedRoot, resolvedCandidate);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export function stageAppDirectory(appDir: string, ignorePatterns: string[]): string {
  const resolvedAppDir = path.resolve(appDir);
  const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'boxlite-deploy-'));

  const copyFiltered = (srcDir: string, dstDir: string, relPrefix: string) => {
    const entries = fs.readdirSync(srcDir, { withFileTypes: true });
    for (const entry of entries) {
      const relPath = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      if (matchesIgnorePattern(entry.name, relPath, ignorePatterns)) {
        continue;
      }
      const srcPath = path.join(srcDir, entry.name);
      const dstPath = path.join(dstDir, entry.name);
      if (entry.isDirectory()) {
        fs.mkdirSync(dstPath, { recursive: true });
        copyFiltered(srcPath, dstPath, relPath);
      } else if (entry.isSymbolicLink()) {
        const target = fs.readlinkSync(srcPath);
        const resolvedTarget = path.resolve(srcDir, target);
        if (!isPathWithinRoot(resolvedAppDir, resolvedTarget)) {
          continue;
        }
        fs.symlinkSync(target, dstPath);
      } else {
        fs.copyFileSync(srcPath, dstPath);
      }
    }
  };

  copyFiltered(resolvedAppDir, stagingDir, '');
  return stagingDir;
}

export function buildRestartCommand(startCmd: string = 'python3 -u server.py'): string {
  const trimmed = (startCmd || 'python3 -u server.py').trim();
  const escaped = trimmed.replace(/'/g, "'\\''");
  const firstToken = trimmed.split(/\s+/)[0] || '';
  const escapedToken = firstToken.replace(/'/g, "'\\''");
  const isShell = firstToken === 'sh' || firstToken === 'bash' || firstToken === '/bin/sh' || firstToken === '/bin/bash';
  const tokenBranch = firstToken && !isShell ? `|*'${escapedToken} '*` : '';
  return [
    `for p in /proc/[0-9]*; do`,
    `  pid=\${p#/proc/};`,
    `  [ "$pid" = "1" ] || [ "$pid" = "$$" ] && continue;`,
    `  cmd=$(tr '\\0' ' ' < "$p/cmdline" 2>/dev/null || true);`,
    `  case "$cmd" in *"while true;"*|*"/proc/[0-9]*"*) continue ;; *'${escaped}'*${tokenBranch}) kill "$pid" 2>/dev/null || true ;; esac;`,
    `done`
  ].join(' ');
}

export function buildHealthProbeCommand(port: number, healthPath: string): string {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid health probe port: ${port}`);
  }
  const rawPath = (healthPath || '/healthz').trim();
  if (/[\r\n\0]/.test(rawPath)) {
    throw new Error('Invalid healthPath: control characters are not allowed.');
  }
  const normalizedPath = rawPath.startsWith('/') ? rawPath : `/${rawPath}`;
  const url = `http://127.0.0.1:${port}${normalizedPath}`;
  const escapedUrl = url.replace(/'/g, "'\\''");
  return [
    `BOXLITE_HEALTH_URL='${escapedUrl}'; export BOXLITE_HEALTH_URL;`,
    `if command -v curl >/dev/null 2>&1; then`,
    `  curl -fsS --max-time 2 "$BOXLITE_HEALTH_URL" >/dev/null;`,
    `elif command -v wget >/dev/null 2>&1; then`,
    `  wget -q -T 2 -O /dev/null "$BOXLITE_HEALTH_URL";`,
    `elif command -v python3 >/dev/null 2>&1; then`,
    `  python3 -c 'import os, urllib.request; r = urllib.request.urlopen(os.environ["BOXLITE_HEALTH_URL"], timeout=2); assert 200 <= r.status < 300';`,
    `elif command -v node >/dev/null 2>&1; then`,
    `  node -e 'fetch(process.env.BOXLITE_HEALTH_URL, { signal: AbortSignal.timeout(2000) }).then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))';`,
    `else`,
    `  exit 127;`,
    `fi`
  ].join(' ');
}

export class BoxLiteDeployer {
  constructor(
    private bridge: BoxLiteBridgeClient,
    private credentials: CredentialsManager,
    private logManager: LogStreamManager,
    private outputChannel: vscode.OutputChannel,
    private onDeploySuccess?: () => void,
    private secretsManager?: SecretsManager,
    private healthPollIntervalMs: number = 2000,
    private externalCheckFn: (url: string, token?: string) => Promise<number> = checkHttpHealth
  ) {}

  public async deployWorkspace(targetBoxId?: string): Promise<void> {
    const projectInfo = await ProjectManager.findProjectConfig();
    if (!projectInfo) {
      const choice = await vscode.window.showInformationMessage(
        'No boxlite.json found in workspace. Would you like to create a new BoxLite project?',
        'Create Project'
      );
      if (choice === 'Create Project') {
        await vscode.commands.executeCommand('boxlite.newProject');
      }
      return;
    }

    const { config, fileUri } = projectInfo;
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
    const appDir = path.resolve(workspaceRoot, config.appDir || './app');

    if (workspaceRoot && !isPathWithinRoot(workspaceRoot, appDir)) {
      vscode.window.showErrorMessage(
        `Application directory "${config.appDir}" must stay inside the workspace folder.`
      );
      return;
    }

    if (!fs.existsSync(appDir)) {
      vscode.window.showErrorMessage(`Application directory "${config.appDir}" does not exist in workspace.`);
      return;
    }

    // Step 1: Ensure API Key
    let apiKey = await this.credentials.getApiKey();
    if (!apiKey) {
      apiKey = await this.credentials.promptForApiKey();
      if (!apiKey) {
        vscode.window.showWarningMessage('Deployment aborted: BoxLite API Key is required.');
        return;
      }
    }

    this.outputChannel.show(true);
    this.outputChannel.appendLine(`\n=== BoxLite Deployment: ${config.name} ===`);
    this.outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] Starting deployment pipeline...`);

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Deploying ${config.name} to BoxLite Cloud...`,
        cancellable: false
      },
      async (progress) => {
        try {
          // Step 2: Resolve Box (reuse or create)
          let boxId = targetBoxId || config.boxId;
          let boxName = config.name;

          progress.report({ message: 'Resolving Box instance...' });
          if (boxId) {
            this.outputChannel.appendLine(`[deploy] Reusing configured boxId: ${boxId}`);
            try {
              await this.bridge.inspectBox(boxId);
              // Ensure box is started
              await this.bridge.startBox(boxId);
            } catch (e: any) {
              this.outputChannel.appendLine(`[deploy] Box ${boxId} not found or inactive. Creating a new Box...`);
              boxId = null;
            }
          }

          if (!boxId) {
            const randomSuffix = Math.random().toString(16).substring(2, 8);
            boxName = `${config.name}-${randomSuffix}`;
            this.outputChannel.appendLine(`[deploy] Provisioning new Box: ${boxName}...`);

            // Supervisor entrypoint ensures PID 1 stays alive and restarts app when server.py exists
            const supervisor = buildSupervisorEntrypoint(config.start || 'python3 -u server.py');

            if (config.volumes && config.volumes.length > 0) {
              for (const v of config.volumes) {
                this.outputChannel.appendLine(`[deploy] Mounting volume '${v.managed_volume}' at '${v.guest_path}'`);
              }
            }

            // Resolve Secrets proxy injection rules from workstation SecretStorage
            let resolvedSecrets: SecretSpec[] | undefined;
            const envMap: Record<string, string> = {};
            if (config.env) {
              if (Array.isArray(config.env)) {
                for (const entry of config.env) {
                  const idx = String(entry).indexOf('=');
                  if (idx > 0) {
                    envMap[String(entry).substring(0, idx)] = String(entry).substring(idx + 1);
                  }
                }
              } else {
                Object.assign(envMap, config.env);
              }
            }

            if (config.secrets && config.secrets.length > 0) {
              const resolvedList: SecretSpec[] = [];
              for (const s of config.secrets) {
                let secretVal: string | undefined;
                if (this.secretsManager) {
                  const stored = await this.secretsManager.getSecret(s.name);
                  secretVal = stored?.value;
                }
                if (!secretVal) {
                  const prompted = await vscode.window.showInputBox({
                    title: `BoxLite Secret Credential: ${s.name}`,
                    prompt: `Enter credential value for secret "${s.name}" (hosts: ${(s.hosts || []).join(', ')})`,
                    password: true,
                    ignoreFocusOut: true,
                    validateInput: (val) => (!val || !val.trim() ? 'Secret value cannot be empty.' : null)
                  });
                  if (!prompted) {
                    throw new Error(`Deployment aborted: credential value for secret "${s.name}" is required.`);
                  }
                  secretVal = prompted.trim();
                  if (this.secretsManager) {
                    await this.secretsManager.saveSecret({
                      name: s.name,
                      value: secretVal,
                      hosts: s.hosts || [],
                      headers: s.headers || { Authorization: 'Bearer {value}' },
                      envVar: s.envVar
                    });
                  }
                }
                resolvedList.push({
                  name: s.name,
                  value: secretVal,
                  hosts: s.hosts || [],
                  headers: s.headers || { Authorization: 'Bearer {value}' }
                });
                if (s.envVar && !envMap[s.envVar]) {
                  envMap[s.envVar] = formatSecretPlaceholder(s.name);
                }
                this.outputChannel.appendLine(
                  `[deploy] Configuring Secret '${s.name}' (placeholder ${formatSecretPlaceholder(s.name)}) for hosts: ${(s.hosts || []).join(', ')}`
                );
              }
              const envCheck = validateEnvAgainstSecrets(envMap, resolvedList);
              if (!envCheck.valid) {
                throw new Error(envCheck.error || 'Environment contains raw secret value.');
              }
              resolvedSecrets = resolvedList;
            }

            const created = await this.bridge.createBox({
              name: boxName,
              image: config.image || 'python',
              cpus: config.cpus,
              memoryMib: config.memoryMib,
              diskSizeGb: config.diskSizeGb,
              autoRemove: false,
              autoStop: config.autoStop ?? 0,
              autoDelete: config.autoDelete,
              autoResume: config.autoResume,
              entrypoint: supervisor,
              env: Object.keys(envMap).length > 0 ? envMap : undefined,
              network: {
                inbound: { mode: config.network?.inbound || 'enabled' },
                outbound: {
                  mode: config.network?.outbound?.mode || 'enabled',
                  allow_net: config.network?.outbound?.allow_net || []
                }
              },
              volumes: config.volumes && config.volumes.length > 0 ? config.volumes : undefined,
              secrets: resolvedSecrets
            });

            boxId = created.boxId;
            this.outputChannel.appendLine(`[deploy] Box created: ID=${boxId}`);
            await ProjectManager.saveBoxId(fileUri, boxId);
          }

          // Step 3: Prepare guest destination
          progress.report({ message: 'Preparing /app in guest rootfs...' });
          const mkdirRes = await this.bridge.exec(boxId, 'mkdir', ['-p', '/app']);
          if (mkdirRes.exitCode !== 0) {
            throw new Error(`Failed to create /app in guest: ${mkdirRes.stderr}`);
          }

          // Step 4: Copy filtered application files (excluding .env, .git, node_modules, .venv, etc.)
          progress.report({ message: 'Uploading application code...' });
          this.outputChannel.appendLine(`[deploy] Staging and copying ${appDir} to /app...`);
          const ignores = ProjectManager.getIgnorePatterns(workspaceRoot);
          const stagingDir = stageAppDirectory(appDir, ignores);
          try {
            const sourcePath = stagingDir.endsWith('/') || stagingDir.endsWith('\\') ? stagingDir + '.' : stagingDir + '/.';
            await this.bridge.copyIn(boxId, sourcePath, '/app');
          } finally {
            try {
              fs.rmSync(stagingDir, { recursive: true, force: true });
            } catch {
              // Ignore cleanup errors
            }
          }

          // Step 5: Restart running process so supervisor re-launches with newly deployed files
          progress.report({ message: 'Restarting application in guest...' });
          await this.bridge.exec(boxId, 'sh', ['-c', buildRestartCommand(config.start || 'python3 -u server.py')]);
          this.outputChannel.appendLine('[deploy] Code uploaded and application restart signal sent.');

          // Step 6: Wait for guest healthz readiness
          progress.report({ message: 'Verifying internal service health...' });
          const port = config.port || 8080;
          const healthPath = config.healthPath || '/healthz';
          const probeCmd = buildHealthProbeCommand(port, healthPath);

          let healthy = false;
          for (let attempt = 1; attempt <= 30; attempt++) {
            this.outputChannel.appendLine(`[deploy] Health probe attempt ${attempt}/30...`);
            const probeRes = await this.bridge.exec(boxId, 'sh', ['-c', probeCmd]);
            if (probeRes.exitCode === 0) {
              healthy = true;
              break;
            }
            if (this.healthPollIntervalMs > 0) {
              await new Promise((r) => setTimeout(r, this.healthPollIntervalMs));
            }
          }

          if (!healthy) {
            const logs = await this.bridge.tailLog(boxId, '/tmp/server.log', 40);
            this.outputChannel.appendLine(`[deploy] ERROR: App did not respond to ${healthPath}. Recent logs:\n${logs.content}`);
            throw new Error(`Service did not become healthy within 60s. Check /tmp/server.log output.`);
          }
          this.outputChannel.appendLine('[deploy] Guest service healthy!');

          // Step 7: Configure network & declare tunnel (respecting boxlite.json network.inbound)
          const inboundMode = config.network?.inbound || 'enabled';
          if (inboundMode === 'disabled') {
            progress.report({ message: 'Keeping inbound networking disabled...' });
            await this.bridge.updateInbound(boxId, 'disabled');
            this.outputChannel.appendLine('[deploy] Inbound networking is disabled per boxlite.json; skipping tunnel creation.');
            this.outputChannel.appendLine(`\n=== Deployment Complete! ===`);

            if (this.onDeploySuccess) {
              this.onDeploySuccess();
            }

            const actionLogs = 'Stream Logs';
            vscode.window
              .showInformationMessage(
                `Deployed ${config.name} successfully to BoxLite (inbound disabled)!`,
                actionLogs
              )
              .then((selection) => {
                if (selection === actionLogs) {
                  this.logManager.openOrStreamLogs(boxId!, boxName);
                }
              });
            return;
          }

          progress.report({ message: 'Configuring network and tunnel...' });
          await this.bridge.updateInbound(boxId, 'enabled');

          const isPublic = config.access !== 'private';
          const tunnel = await this.bridge.tunnel(boxId, port, isPublic);
          const publicUrl = tunnel.url;
          this.outputChannel.appendLine(`[deploy] Tunnel established: ${publicUrl}`);

          // Step 8: Outside-the-box readiness check (proxy propagation)
          progress.report({ message: 'Testing external URL access...' });
          let externalOk = false;
          const base = publicUrl.endsWith('/') ? publicUrl : `${publicUrl}/`;
          const rel = healthPath.startsWith('/') ? healthPath.substring(1) : healthPath;
          const checkUrl = new URL(rel, base).toString();

          for (let attempt = 1; attempt <= 10; attempt++) {
            try {
              const status = await this.externalCheckFn(checkUrl, tunnel.token);
              if (status === 200) {
                externalOk = true;
                break;
              }
            } catch (err) {
              // Wait for cloud proxy propagation
            }
            if (this.healthPollIntervalMs > 0) {
              await new Promise((r) => setTimeout(r, this.healthPollIntervalMs));
            }
          }

          if (!externalOk) {
            this.outputChannel.appendLine('[deploy] Warning: External proxy health check timed out. URL may take a few moments to propagate.');
          } else {
            this.outputChannel.appendLine('[deploy] External public URL is reachable and healthy!');
          }

          // Step 9: Notify user
          this.outputChannel.appendLine(`\n=== Deployment Complete! ===`);
          this.outputChannel.appendLine(`Public URL: ${publicUrl}`);
          if (tunnel.token) {
            this.outputChannel.appendLine(
              `Access Token (Private): ${CredentialsManager.redactKey(tunnel.token)} (use "Copy Private Access Token" in Boxes view)`
            );
          }

          if (this.onDeploySuccess) {
            this.onDeploySuccess();
          }

          const actionOpen = 'Open in Browser';
          const actionCopy = 'Copy URL';
          const actionLogs = 'Stream Logs';

          vscode.window
            .showInformationMessage(
              `Deployed ${config.name} successfully to BoxLite!`,
              actionOpen,
              actionCopy,
              actionLogs
            )
            .then(async (selection) => {
              if (selection === actionOpen) {
                try {
                  const parsed = new URL(publicUrl);
                  if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
                    vscode.env.openExternal(vscode.Uri.parse(publicUrl));
                  }
                } catch {
                  // Ignore invalid URL
                }
              } else if (selection === actionCopy) {
                await vscode.env.clipboard.writeText(publicUrl);
                vscode.window.showInformationMessage('Public URL copied to clipboard.');
              } else if (selection === actionLogs) {
                this.logManager.openOrStreamLogs(boxId!, boxName);
              }
            });
        } catch (error: any) {
          this.outputChannel.appendLine(`[deploy] ERROR: ${error.message}`);
          vscode.window.showErrorMessage(`Deployment failed: ${formatErrorWithDiagnosis(error)}`);
        }
      }
    );
  }
}

const HEALTH_LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

function checkHttpHealth(targetUrl: string, token?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(targetUrl);
    if (urlObj.protocol !== 'https:' && urlObj.protocol !== 'http:') {
      reject(new Error(`Unsupported health check protocol: ${urlObj.protocol}`));
      return;
    }
    if (token && urlObj.protocol === 'http:' && !HEALTH_LOOPBACK_HOSTS.has(urlObj.hostname.toLowerCase())) {
      reject(new Error('Refusing to send private access token over insecure http:// URL.'));
      return;
    }
    const client = urlObj.protocol === 'https:' ? https : http;

    const headers: Record<string, string> = {};
    if (token) {
      headers['X-BoxLite-Access-Token'] = token;
    }

    const req = client.get(
      targetUrl,
      {
        headers,
        timeout: 10000
      },
      (res) => {
        res.resume();
        resolve(res.statusCode || 0);
      }
    );

    req.on('error', (err) => reject(err));
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Timeout'));
    });
  });
}
