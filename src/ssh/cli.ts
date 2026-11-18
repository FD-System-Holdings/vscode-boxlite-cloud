import { execFile as nodeExecFile, spawn as nodeSpawn } from 'child_process';
import * as path from 'path';
import { createCleanSubprocessEnv, parseExecutableCommand } from '../util/process';
import {
  CliCapabilities,
  parseCapabilitiesFromHelp,
  parseCliVersion,
  validateBoxId
} from './parse';

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface CliRunner {
  execFile(
    bin: string,
    args: string[],
    options?: { timeoutMs?: number; stdin?: string; env?: NodeJS.ProcessEnv }
  ): Promise<ExecResult>;
}

export type SshErrorCode =
  | 'CLI_NOT_FOUND'
  | 'SSH_SUBCOMMAND_UNSUPPORTED'
  | 'OPENSSH_NOT_FOUND'
  | 'AUTH_FAILED'
  | 'BOX_NOT_FOUND'
  | 'NETWORK_DISABLED'
  | 'SSH_DISABLED'
  | 'PERMISSION_DENIED_KEY'
  | 'PUBLICKEY_AUTH_FAILED'
  | 'PARSE_FAILED'
  | 'UNKNOWN';

export class SshCliError extends Error {
  constructor(
    public readonly code: SshErrorCode,
    message: string,
    public readonly rawOutput?: string
  ) {
    super(message);
    this.name = 'SshCliError';
  }
}

export interface BoxliteCliInfo {
  bin: string;
  baseArgs: string[];
  version?: string;
  capabilities: CliCapabilities;
}

export interface OpenSshInfo {
  sshBin: string;
  sshKeygenBin: string;
  version?: string;
}

const DEFAULT_TIMEOUT_MS = 60_000;

export class NodeCliRunner implements CliRunner {
  public execFile(
    bin: string,
    args: string[],
    options?: { timeoutMs?: number; stdin?: string; env?: NodeJS.ProcessEnv }
  ): Promise<ExecResult> {
    const env = createCleanSubprocessEnv(options?.env);
    const timeout = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    if (options?.stdin !== undefined) {
      return new Promise<ExecResult>((resolve, reject) => {
        const child = nodeSpawn(bin, args, {
          env,
          shell: false,
          stdio: ['pipe', 'pipe', 'pipe']
        });

        let stdout = '';
        let stderr = '';
        let settled = false;

        const timer = setTimeout(() => {
          if (!settled) {
            settled = true;
            try {
              child.kill();
            } catch {}
            const err: NodeJS.ErrnoException = new Error(`Command timed out after ${timeout}ms`);
            err.code = 'ETIMEDOUT';
            reject(err);
          }
        }, timeout);

        child.stdout?.on('data', (chunk: Buffer | string) => {
          stdout += chunk.toString();
        });
        child.stderr?.on('data', (chunk: Buffer | string) => {
          stderr += chunk.toString();
        });
        child.on('error', (err) => {
          clearTimeout(timer);
          if (!settled) {
            settled = true;
            reject(err);
          }
        });
        child.on('close', (code) => {
          clearTimeout(timer);
          if (!settled) {
            settled = true;
            resolve({
              stdout,
              stderr,
              exitCode: typeof code === 'number' ? code : 1
            });
          }
        });

        try {
          child.stdin?.write(options.stdin);
          child.stdin?.end();
        } catch (err) {
          clearTimeout(timer);
          if (!settled) {
            settled = true;
            reject(err);
          }
        }
      });
    }

    return new Promise<ExecResult>((resolve, reject) => {
      nodeExecFile(
        bin,
        args,
        {
          env,
          timeout,
          maxBuffer: 4 * 1024 * 1024
        },
        (error, stdout, stderr) => {
          if (error) {
            const errObj = error as NodeJS.ErrnoException & { code?: string | number };
            if (errObj.code === 'ENOENT' || errObj.code === 'EACCES' || errObj.code === 'ETIMEDOUT') {
              reject(errObj);
              return;
            }
            const exitCode = typeof errObj.code === 'number' ? errObj.code : 1;
            resolve({
              stdout: stdout || '',
              stderr: stderr || errObj.message || '',
              exitCode
            });
            return;
          }
          resolve({
            stdout: stdout || '',
            stderr: stderr || '',
            exitCode: 0
          });
        }
      );
    });
  }
}

export function classifyCliOutputError(result: ExecResult): SshCliError {
  const combined = `${result.stderr}\n${result.stdout}`.trim();
  const lower = combined.toLowerCase();

  if (
    lower.includes('unknown command') ||
    lower.includes('unknown subcommand') ||
    lower.includes('unrecognized subcommand') ||
    (lower.includes('invalid choice') && lower.includes('ssh'))
  ) {
    return new SshCliError(
      'SSH_SUBCOMMAND_UNSUPPORTED',
      'Installed BoxLite CLI does not support the "ssh" command. Please update to the latest BoxLite CLI.',
      combined
    );
  }

  if (
    lower.includes('unauthorized') ||
    lower.includes('authentication failed') ||
    lower.includes('not logged in') ||
    lower.includes('invalid api key') ||
    lower.includes('401')
  ) {
    return new SshCliError(
      'AUTH_FAILED',
      'BoxLite CLI authentication failed. Verify your active API key and account.',
      combined
    );
  }

  if (lower.includes('not found') || lower.includes('404') || lower.includes('no such box')) {
    return new SshCliError(
      'BOX_NOT_FOUND',
      'Box not found for the active BoxLite Cloud account.',
      combined
    );
  }

  if (lower.includes('ssh is disabled') || (lower.includes('ssh') && lower.includes('disabled'))) {
    return new SshCliError('SSH_DISABLED', 'SSH is currently disabled on this box.', combined);
  }

  if (lower.includes('box networking is disabled') || lower.includes('no guest nic')) {
    return new SshCliError(
      'NETWORK_DISABLED',
      'Box was created with Outbound Network disabled (no guest NIC provisioned at creation). BoxLite Cloud SSH tunnels require a guest NIC — create a box with Outbound Network enabled.',
      combined
    );
  }

  if (lower.includes('bad permissions') || lower.includes('unprotected private key')) {
    return new SshCliError(
      'PERMISSION_DENIED_KEY',
      'OpenSSH rejected the private key file permissions.',
      combined
    );
  }

  if (lower.includes('permission denied (publickey)')) {
    return new SshCliError(
      'PUBLICKEY_AUTH_FAILED',
      'Permission denied (publickey). Another SSH setup may have replaced the authorized key.',
      combined
    );
  }

  return new SshCliError('UNKNOWN', combined || `Command exited with code ${result.exitCode}.`, combined);
}

function sanitizeContextNamePart(raw: string): string {
  const cleaned = raw.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned || 'default';
}

export function buildCliContextName(prefix: string, keyId: string): string {
  const safePrefix = sanitizeContextNamePart(prefix || 'vscode');
  const safeKeyId = sanitizeContextNamePart(keyId || 'default');
  return `${safePrefix}-${safeKeyId}`;
}

export class BoxliteSshCli {
  private capabilityCache = new Map<string, CliCapabilities>();

  constructor(private readonly runner: CliRunner = new NodeCliRunner()) {}

  public clearCache(): void {
    this.capabilityCache.clear();
  }

  public async findBoxliteCli(configuredPath?: string): Promise<BoxliteCliInfo> {
    const rawCmd = (configuredPath || '').trim() || 'boxlite';
    const parsed = parseExecutableCommand(rawCmd);
    const bin = parsed.bin || 'boxlite';
    const baseArgs = parsed.args;

    let version: string | undefined;
    try {
      const verRes = await this.runner.execFile(bin, [...baseArgs, '--version'], { timeoutMs: 10_000 });
      if (verRes.exitCode === 0) {
        version = parseCliVersion(`${verRes.stdout}\n${verRes.stderr}`);
      }
    } catch (err: any) {
      if (err?.code === 'ENOENT') {
        throw new SshCliError(
          'CLI_NOT_FOUND',
          `BoxLite CLI ("${bin}") was not found on PATH. Install it to use Cloud SSH.`
        );
      }
    }

    const cacheKey = `${bin}::${baseArgs.join(' ')}::${version || 'unknown'}`;
    const cached = this.capabilityCache.get(cacheKey);
    if (cached) {
      if (!cached.hasSsh) {
        throw new SshCliError(
          'SSH_SUBCOMMAND_UNSUPPORTED',
          'Installed BoxLite CLI does not support the "ssh" command. Please update to the latest BoxLite CLI.'
        );
      }
      return { bin, baseArgs, version, capabilities: cached };
    }

    let helpRes: ExecResult;
    try {
      helpRes = await this.runner.execFile(bin, [...baseArgs, 'ssh', '--help'], { timeoutMs: 10_000 });
    } catch (err: any) {
      if (err?.code === 'ENOENT') {
        throw new SshCliError(
          'CLI_NOT_FOUND',
          `BoxLite CLI ("${bin}") was not found on PATH. Install it to use Cloud SSH.`
        );
      }
      throw new SshCliError('UNKNOWN', `Failed to probe BoxLite CLI: ${err?.message || String(err)}`);
    }

    const helpText = `${helpRes.stdout}\n${helpRes.stderr}`;
    if (helpRes.exitCode !== 0) {
      const classified = classifyCliOutputError(helpRes);
      if (classified.code === 'SSH_SUBCOMMAND_UNSUPPORTED' || /unknown|invalid/i.test(helpText)) {
        this.capabilityCache.set(cacheKey, { hasSsh: false, hasJsonFlag: false, version });
        throw new SshCliError(
          'SSH_SUBCOMMAND_UNSUPPORTED',
          'Installed BoxLite CLI does not support the "ssh" command. Please update to the latest BoxLite CLI.',
          helpText
        );
      }
      throw classified;
    }

    const jsonCaps = parseCapabilitiesFromHelp(helpText);
    const capabilities: CliCapabilities = {
      hasSsh: true,
      hasJsonFlag: jsonCaps.hasJsonFlag,
      jsonFlag: jsonCaps.jsonFlag,
      version
    };
    this.capabilityCache.set(cacheKey, capabilities);

    return { bin, baseArgs, version, capabilities };
  }

  public async findOpenSsh(configuredSshPath?: string, requireKeygen = true): Promise<OpenSshInfo> {
    const rawSsh = (configuredSshPath || '').trim() || 'ssh';
    const parsedSsh = parseExecutableCommand(rawSsh);
    const sshBin = parsedSsh.bin || 'ssh';

    let sshVersion: string | undefined;
    try {
      const res = await this.runner.execFile(sshBin, ['-V'], { timeoutMs: 10_000 });
      const combined = `${res.stdout}\n${res.stderr}`.trim();
      if (!/openssh|ssh/i.test(combined) && res.exitCode !== 0) {
        throw new SshCliError('OPENSSH_NOT_FOUND', `OpenSSH client ("${sshBin}") did not respond as expected.`);
      }
      sshVersion = combined.split(/\r?\n/)[0]?.trim();
    } catch (err: any) {
      if (err instanceof SshCliError) {
        throw err;
      }
      if (err?.code === 'ENOENT') {
        throw new SshCliError(
          'OPENSSH_NOT_FOUND',
          `OpenSSH client ("${sshBin}") was not found. Install OpenSSH to connect via SSH.`
        );
      }
      throw new SshCliError('OPENSSH_NOT_FOUND', `Failed to verify OpenSSH ("${sshBin}"): ${err?.message || err}`);
    }

    const sshDir = path.dirname(sshBin);
    const keygenName = process.platform === 'win32' && sshBin.toLowerCase().endsWith('.exe')
      ? 'ssh-keygen.exe'
      : 'ssh-keygen';
    const candidateKeygen = sshDir && sshDir !== '.' ? path.join(sshDir, keygenName) : keygenName;

    let sshKeygenBin = candidateKeygen;
    if (requireKeygen) {
      try {
        await this.runner.execFile(candidateKeygen, ['-?'], { timeoutMs: 10_000 });
      } catch (err: any) {
        if (err?.code === 'ENOENT' && candidateKeygen !== 'ssh-keygen') {
          sshKeygenBin = 'ssh-keygen';
          try {
            await this.runner.execFile('ssh-keygen', ['-?'], { timeoutMs: 10_000 });
          } catch (fallbackErr: any) {
            if (fallbackErr?.code === 'ENOENT') {
              throw new SshCliError(
                'OPENSSH_NOT_FOUND',
                'OpenSSH "ssh-keygen" was not found. Install OpenSSH (ssh and ssh-keygen).'
              );
            }
          }
        } else if (err?.code === 'ENOENT') {
          throw new SshCliError(
            'OPENSSH_NOT_FOUND',
            'OpenSSH "ssh-keygen" was not found. Install OpenSSH (ssh and ssh-keygen).'
          );
        }
      }
    }

    return { sshBin, sshKeygenBin, version: sshVersion };
  }

  public async cliLogin(
    cli: BoxliteCliInfo,
    contextName: string,
    restUrl: string,
    apiKey: string
  ): Promise<void> {
    if (!apiKey || !apiKey.trim()) {
      throw new SshCliError('AUTH_FAILED', 'No BoxLite Cloud API key is configured.');
    }

    const args = [
      ...cli.baseArgs,
      '--context',
      contextName,
      'auth',
      'login',
      '--url',
      restUrl,
      '--api-key-stdin'
    ];
    const res = await this.runner.execFile(cli.bin, args, {
      stdin: apiKey.trim(),
      timeoutMs: 30_000
    });
    if (res.exitCode !== 0) {
      throw classifyCliOutputError(res);
    }
  }

  public async ensureInbound(cli: BoxliteCliInfo, contextName: string, boxId: string): Promise<void> {
    const safeBoxId = validateBoxId(boxId);
    const args = [...cli.baseArgs, '--context', contextName, 'network', 'inbound', safeBoxId, 'enabled'];
    const res = await this.runner.execFile(cli.bin, args, { timeoutMs: 30_000 });
    if (res.exitCode !== 0) {
      throw classifyCliOutputError(res);
    }
  }

  private async runWithOptionalJson(
    cli: BoxliteCliInfo,
    baseSubArgs: string[],
    jsonFlag?: string
  ): Promise<ExecResult> {
    if (jsonFlag) {
      const resWithJson = await this.runner.execFile(cli.bin, [...cli.baseArgs, ...baseSubArgs, jsonFlag], {
        timeoutMs: 60_000
      });
      if (resWithJson.exitCode === 0) {
        return resWithJson;
      }
      const combined = `${resWithJson.stderr}\n${resWithJson.stdout}`.toLowerCase();
      if (!combined.includes('unknown') && !combined.includes('unrecognized') && !combined.includes('unexpected')) {
        throw classifyCliOutputError(resWithJson);
      }
    }

    const res = await this.runner.execFile(cli.bin, [...cli.baseArgs, ...baseSubArgs], {
      timeoutMs: 60_000
    });
    if (res.exitCode !== 0) {
      throw classifyCliOutputError(res);
    }
    return res;
  }

  public async sshSetup(cli: BoxliteCliInfo, contextName: string, boxId: string): Promise<ExecResult> {
    const safeBoxId = validateBoxId(boxId);
    const jsonFlag = cli.capabilities.hasJsonFlag ? cli.capabilities.jsonFlag : undefined;
    return this.runWithOptionalJson(cli, ['--context', contextName, 'ssh', safeBoxId], jsonFlag);
  }

  public async sshStatus(cli: BoxliteCliInfo, contextName: string, boxId: string): Promise<ExecResult> {
    const safeBoxId = validateBoxId(boxId);
    const jsonFlag = cli.capabilities.hasJsonFlag ? cli.capabilities.jsonFlag : undefined;
    return this.runWithOptionalJson(cli, ['--context', contextName, 'ssh', '--status', safeBoxId], jsonFlag);
  }

  public async sshEnable(cli: BoxliteCliInfo, contextName: string, boxId: string): Promise<ExecResult> {
    const safeBoxId = validateBoxId(boxId);
    const args = [...cli.baseArgs, '--context', contextName, 'ssh', '--enable', safeBoxId];
    const res = await this.runner.execFile(cli.bin, args, { timeoutMs: 30_000 });
    if (res.exitCode !== 0) {
      throw classifyCliOutputError(res);
    }
    return res;
  }

  public async sshDisable(cli: BoxliteCliInfo, contextName: string, boxId: string): Promise<ExecResult> {
    const safeBoxId = validateBoxId(boxId);
    const args = [...cli.baseArgs, '--context', contextName, 'ssh', '--disable', safeBoxId];
    const res = await this.runner.execFile(cli.bin, args, { timeoutMs: 30_000 });
    if (res.exitCode !== 0) {
      throw classifyCliOutputError(res);
    }
    return res;
  }

  public async revokeTunnel(
    cli: BoxliteCliInfo,
    contextName: string,
    boxId: string,
    port = 22
  ): Promise<ExecResult> {
    const safeBoxId = validateBoxId(boxId);
    const args = [...cli.baseArgs, '--context', contextName, 'network', 'tunnel', '--revoke', safeBoxId, String(port)];
    const res = await this.runner.execFile(cli.bin, args, { timeoutMs: 30_000 });
    if (res.exitCode !== 0) {
      throw classifyCliOutputError(res);
    }
    return res;
  }
}
