import * as path from 'path';

export const MIN_TESTED_CLI_VERSION = '0.10.5';

export interface ParsedSshSetup {
  keyPath?: string;
  fingerprint?: string;
  sshCommand: string;
  sshBin: string;
  sshArgs: string[];
  proxyCommand?: string;
  user?: string;
  host?: string;
  port?: string;
  raw: string;
}

export interface ParsedSshStatus {
  enabled?: boolean;
  configured?: boolean;
  fingerprint?: string;
  keyPath?: string;
  raw: string;
}

export interface CliCapabilities {
  hasSsh: boolean;
  hasJsonFlag: boolean;
  jsonFlag?: string;
  version?: string;
}

const SAFE_BOX_ID_REGEX = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** Validates that a Box ID or name is safe to pass as a CLI positional argument. */
export function validateBoxId(boxId: string): string {
  const trimmed = (boxId || '').trim();
  if (!trimmed) {
    throw new Error('Box ID cannot be empty.');
  }
  if (!SAFE_BOX_ID_REGEX.test(trimmed)) {
    throw new Error(
      `Invalid Box ID "${trimmed}". Box IDs must start with an alphanumeric character and contain only letters, digits, dots, underscores, or hyphens.`
    );
  }
  return trimmed;
}

/**
 * Tokenizes a command line string with quote awareness while keeping Windows
 * backslashes intact inside double quotes unless escaping a quote (`\"`).
 */
export function tokenizeCommand(commandLine: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let inToken = false;
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < commandLine.length; i++) {
    const ch = commandLine[i];

    if (quote === "'") {
      if (ch === "'") {
        quote = null;
      } else {
        current += ch;
      }
      inToken = true;
      continue;
    }

    if (quote === '"') {
      if (ch === '\\' && i + 1 < commandLine.length && commandLine[i + 1] === '"') {
        current += '"';
        i++;
      } else if (ch === '"') {
        quote = null;
      } else {
        current += ch;
      }
      inToken = true;
      continue;
    }

    if (/\s/.test(ch)) {
      if (inToken) {
        tokens.push(current);
        current = '';
        inToken = false;
      }
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      inToken = true;
      continue;
    }

    current += ch;
    inToken = true;
  }

  if (inToken) {
    tokens.push(current);
  }

  return tokens;
}

export function extractProxyCommand(sshArgs: string[]): string | undefined {
  for (let i = 0; i < sshArgs.length; i++) {
    const arg = sshArgs[i];
    if (arg === '-o' && i + 1 < sshArgs.length) {
      const opt = sshArgs[i + 1];
      const match = /^ProxyCommand\s*=\s*(.+)$/i.exec(opt);
      if (match) {
        return match[1].trim();
      }
      i++;
    } else if (arg.startsWith('-o')) {
      const opt = arg.slice(2);
      const match = /^ProxyCommand\s*=\s*(.+)$/i.exec(opt);
      if (match) {
        return match[1].trim();
      }
    }
  }
  return undefined;
}

export function extractIdentityFile(sshArgs: string[]): string | undefined {
  for (let i = 0; i < sshArgs.length; i++) {
    const arg = sshArgs[i];
    if (arg === '-i' && i + 1 < sshArgs.length) {
      return sshArgs[i + 1];
    }
    if (arg.startsWith('-i') && arg.length > 2) {
      return arg.slice(2);
    }
  }
  return undefined;
}

const SSH_OPTIONS_WITH_VALUE = new Set([
  '-B', '-b', '-c', '-D', '-E', '-e', '-F', '-I', '-i', '-J',
  '-L', '-l', '-m', '-O', '-o', '-p', '-Q', '-R', '-S', '-W', '-w'
]);

export function extractUserAndHost(sshArgs: string[]): { user?: string; host?: string; port?: string } {
  let user: string | undefined;
  let host: string | undefined;
  let port: string | undefined;

  for (let i = 0; i < sshArgs.length; i++) {
    const arg = sshArgs[i];
    if (arg === '-p' && i + 1 < sshArgs.length) {
      port = sshArgs[i + 1];
      i++;
      continue;
    }
    if (arg.startsWith('-p') && arg.length > 2 && /^\d+$/.test(arg.slice(2))) {
      port = arg.slice(2);
      continue;
    }
    if (arg === '-l' && i + 1 < sshArgs.length) {
      user = sshArgs[i + 1];
      i++;
      continue;
    }
    if (SSH_OPTIONS_WITH_VALUE.has(arg)) {
      i++;
      continue;
    }
    if (arg.startsWith('-')) {
      continue;
    }
    const atIdx = arg.indexOf('@');
    if (atIdx > 0) {
      user = user || arg.slice(0, atIdx);
      host = arg.slice(atIdx + 1);
    } else {
      host = arg;
    }
    break;
  }

  return { user, host, port };
}

function tryParseJsonObject(text: string): Record<string, unknown> | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{')) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Ignore non-JSON output
  }
  return undefined;
}

function stripWrappingQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith('`') && trimmed.endsWith('`'))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function extractCommandAfterMarker(lines: string[]): string | undefined {
  const markerIdx = lines.findIndex((line) =>
    /copy and run the following command to enter the box/i.test(line)
  );
  if (markerIdx === -1) {
    return undefined;
  }

  const collected: string[] = [];
  for (let i = markerIdx + 1; i < lines.length; i++) {
    const rawLine = lines[i];
    const trimmed = rawLine.trim();
    if (!trimmed) {
      if (collected.length > 0) {
        break;
      }
      continue;
    }
    if (collected.length === 0) {
      // Skip optional markdown code fence if CLI renders one
      if (/^```/.test(trimmed)) {
        continue;
      }
    } else if (/^```/.test(trimmed)) {
      break;
    }

    if (trimmed.endsWith('\\')) {
      collected.push(trimmed.slice(0, -1).trimEnd());
      continue;
    }
    collected.push(trimmed);
    // Single-line command without continuation ends here
    break;
  }

  return collected.length > 0 ? collected.join(' ').trim() : undefined;
}

function extractFallbackSshCommand(lines: string[]): string | undefined {
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (/^(?:["'][^"']*ssh(?:\.exe)?["']|ssh(?:\.exe)?)\s+/i.test(trimmed)) {
      const parts = [trimmed];
      let j = i;
      while (parts[parts.length - 1].endsWith('\\') && j + 1 < lines.length) {
        parts[parts.length - 1] = parts[parts.length - 1].slice(0, -1).trimEnd();
        j++;
        parts.push(lines[j].trim());
      }
      const candidate = parts.join(' ').trim();
      if (/ProxyCommand|-i\s/i.test(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
}

/**
 * Parses `boxlite ssh <box>` output (JSON or human-readable text) into structured fields.
 */
export function parseSetupOutput(stdout: string, stderr = ''): ParsedSshSetup {
  const raw = [stdout, stderr].filter(Boolean).join('\n').trim();
  const json = tryParseJsonObject(stdout) || tryParseJsonObject(raw);

  if (json) {
    const cmdRaw =
      (typeof json.ssh_command === 'string' && json.ssh_command) ||
      (typeof json.sshCommand === 'string' && json.sshCommand) ||
      (typeof json.command === 'string' && json.command) ||
      '';
    const argsFromJson = Array.isArray(json.args)
      ? json.args.filter((a): a is string => typeof a === 'string')
      : undefined;

    const tokens = cmdRaw ? tokenizeCommand(cmdRaw) : [];
    const sshBin =
      (typeof json.ssh_bin === 'string' && json.ssh_bin) ||
      (tokens.length > 0 ? tokens[0] : 'ssh');
    const sshArgs = argsFromJson || (tokens.length > 1 ? tokens.slice(1) : []);
    const keyPath =
      (typeof json.private_key_path === 'string' && json.private_key_path) ||
      (typeof json.privateKeyPath === 'string' && json.privateKeyPath) ||
      (typeof json.key_path === 'string' && json.key_path) ||
      (typeof json.keyPath === 'string' && json.keyPath) ||
      extractIdentityFile(sshArgs);
    const fingerprint =
      (typeof json.fingerprint === 'string' && json.fingerprint) ||
      (typeof json.host_key_fingerprint === 'string' && json.host_key_fingerprint) ||
      (typeof json.hostKeyFingerprint === 'string' && json.hostKeyFingerprint) ||
      undefined;
    const proxyCommand =
      (typeof json.proxy_command === 'string' && json.proxy_command) ||
      (typeof json.proxyCommand === 'string' && json.proxyCommand) ||
      extractProxyCommand(sshArgs);
    const { user, host, port } = extractUserAndHost(sshArgs);

    return {
      keyPath,
      fingerprint,
      sshCommand: cmdRaw || formatShellCommand(sshBin, sshArgs),
      sshBin,
      sshArgs,
      proxyCommand,
      user,
      host,
      port,
      raw
    };
  }

  const lines = raw.split(/\r?\n/);
  const sshCommand = extractCommandAfterMarker(lines) || extractFallbackSshCommand(lines) || '';
  const tokens = sshCommand ? tokenizeCommand(sshCommand) : [];
  const sshBin = tokens.length > 0 ? tokens[0] : '';
  const sshArgs = tokens.length > 1 ? tokens.slice(1) : [];

  let keyPath: string | undefined;
  let fingerprint: string | undefined;

  for (const line of lines) {
    if (!keyPath) {
      const keyMatch = /^(?:\*\s*)?(?:private[\s-]?key(?:\s+path)?|key[\s-]?path|identity[\s-]?file)\s*:\s*(.+)$/i.exec(
        line.trim()
      );
      if (keyMatch) {
        keyPath = stripWrappingQuotes(keyMatch[1]);
      }
    }
    if (!fingerprint) {
      const fpLineMatch = /^(?:\*\s*)?(?:(?:ssh\s+)?host[\s-]?(?:key\s+)?)?fingerprint\s*:\s*(.+)$/i.exec(
        line.trim()
      );
      if (fpLineMatch) {
        fingerprint = stripWrappingQuotes(fpLineMatch[1]);
      }
    }
  }

  if (!fingerprint) {
    const fpTokenMatch = /\b(SHA256:[A-Za-z0-9+/=]+|MD5:(?:[0-9a-fA-F]{2}:){15}[0-9a-fA-F]{2})\b/.exec(raw);
    if (fpTokenMatch) {
      fingerprint = fpTokenMatch[1];
    }
  }

  if (!keyPath) {
    keyPath = extractIdentityFile(sshArgs);
  }

  const proxyCommand = extractProxyCommand(sshArgs);
  const { user, host, port } = extractUserAndHost(sshArgs);

  return {
    keyPath,
    fingerprint,
    sshCommand,
    sshBin,
    sshArgs,
    proxyCommand,
    user,
    host,
    port,
    raw
  };
}

export function validateParsedSetup(
  parsed: ParsedSshSetup,
  fileExists: (filePath: string) => boolean
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!parsed.sshCommand.trim() || !parsed.sshBin) {
    errors.push('Missing SSH command in CLI setup output.');
  } else {
    const baseName = path.basename(parsed.sshBin).toLowerCase();
    if (baseName !== 'ssh' && baseName !== 'ssh.exe') {
      errors.push(`Expected SSH executable starting with "ssh", got "${parsed.sshBin}".`);
    }
  }

  if (parsed.sshArgs.length === 0) {
    errors.push('Parsed SSH command has no arguments.');
  }

  if (!parsed.proxyCommand) {
    errors.push('Parsed SSH command does not include a ProxyCommand option.');
  }

  if (!parsed.keyPath) {
    errors.push('Could not determine private key path from CLI output or -i flag.');
  } else if (!fileExists(parsed.keyPath)) {
    errors.push(`Private key file does not exist at "${parsed.keyPath}".`);
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

/**
 * Parses `boxlite ssh --status <box>` output (JSON or text).
 */
export function parseStatusOutput(stdout: string, stderr = ''): ParsedSshStatus {
  const raw = [stdout, stderr].filter(Boolean).join('\n').trim();
  const json = tryParseJsonObject(stdout) || tryParseJsonObject(raw);

  if (json) {
    const enabled =
      typeof json.enabled === 'boolean'
        ? json.enabled
        : typeof json.active === 'boolean'
          ? json.active
          : typeof json.status === 'string'
            ? json.status.toLowerCase() === 'enabled' || json.status.toLowerCase() === 'active'
            : undefined;
    const configured =
      typeof json.configured === 'boolean'
        ? json.configured
        : enabled !== undefined
          ? true
          : undefined;
    const fingerprint =
      (typeof json.fingerprint === 'string' && json.fingerprint) ||
      (typeof json.host_key_fingerprint === 'string' && json.host_key_fingerprint) ||
      (typeof json.hostKeyFingerprint === 'string' && json.hostKeyFingerprint) ||
      undefined;
    const keyPath =
      (typeof json.private_key_path === 'string' && json.private_key_path) ||
      (typeof json.key_path === 'string' && json.key_path) ||
      undefined;
    return { enabled, configured, fingerprint, keyPath, raw };
  }

  let enabled: boolean | undefined;
  let configured: boolean | undefined;
  const lower = raw.toLowerCase();

  if (/\bnot\s+configured\b|\bunconfigured\b|\bno\s+ssh\s+config/i.test(lower)) {
    configured = false;
    enabled = false;
  } else if (/\bdisabled\b|\binactive\b/i.test(lower)) {
    configured = true;
    enabled = false;
  } else if (/\benabled\b|\bactive\b/i.test(lower)) {
    configured = true;
    enabled = true;
  }

  let fingerprint: string | undefined;
  for (const line of raw.split(/\r?\n/)) {
    const fpLineMatch = /^(?:\*\s*)?(?:(?:ssh\s+)?host[\s-]?(?:key\s+)?)?fingerprint\s*:\s*(.+)$/i.exec(
      line.trim()
    );
    if (fpLineMatch) {
      fingerprint = stripWrappingQuotes(fpLineMatch[1]);
      break;
    }
  }
  if (!fingerprint) {
    const fpTokenMatch = /\b(SHA256:[A-Za-z0-9+/=]+|MD5:(?:[0-9a-fA-F]{2}:){15}[0-9a-fA-F]{2})\b/.exec(raw);
    if (fpTokenMatch) {
      fingerprint = fpTokenMatch[1];
    }
  }

  let keyPath: string | undefined;
  for (const line of raw.split(/\r?\n/)) {
    const keyMatch = /^(?:\*\s*)?(?:private[\s-]?key(?:\s+path)?|key[\s-]?path|identity[\s-]?file)\s*:\s*(.+)$/i.exec(
      line.trim()
    );
    if (keyMatch) {
      keyPath = stripWrappingQuotes(keyMatch[1]);
      break;
    }
  }

  return { enabled, configured, fingerprint, keyPath, raw };
}

export function parseCapabilitiesFromHelp(helpText: string): { hasJsonFlag: boolean; jsonFlag?: string } {
  if (/--json\b/.test(helpText)) {
    return { hasJsonFlag: true, jsonFlag: '--json' };
  }
  if (/--output\b[^\n]*json/i.test(helpText)) {
    return { hasJsonFlag: true, jsonFlag: '--output=json' };
  }
  return { hasJsonFlag: false };
}

export function parseCliVersion(versionText: string): string | undefined {
  const match = /\bv?(\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?)\b/.exec(versionText || '');
  return match ? match[1] : undefined;
}

export function shellEscapeArg(arg: string, platform: NodeJS.Platform = process.platform): string {
  if (arg === '') {
    return platform === 'win32' ? '""' : "''";
  }
  if (/^[A-Za-z0-9_./:=+-]+$/.test(arg)) {
    return arg;
  }
  if (platform === 'win32') {
    const escaped = arg.replace(/"/g, '""');
    return `"${escaped}"`;
  }
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

export function formatShellCommand(
  bin: string,
  args: string[],
  platform: NodeJS.Platform = process.platform
): string {
  return [shellEscapeArg(bin, platform), ...args.map((a) => shellEscapeArg(a, platform))].join(' ');
}

export function redactSensitiveText(text: string, extraPaths: string[] = []): string {
  let out = text
    .replace(/\b(blk?_live_)[A-Za-z0-9_-]{4,}/g, '$1[REDACTED]')
    .replace(/\b(Bearer\s+)[A-Za-z0-9._-]+/gi, '$1[REDACTED]');

  for (const sensitivePath of extraPaths) {
    if (sensitivePath && sensitivePath.trim().length > 0) {
      out = out.split(sensitivePath).join('<key-path>');
    }
  }
  return out;
}
