import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface SshHostBlockSpec {
  boxId: string;
  alias: string;
  hostName: string;
  user: string;
  identityFile: string;
  proxyCommand?: string;
  port?: string;
  userKnownHostsFile?: string;
  hostKeyAlias?: string;
  strictHostKeyChecking?: 'yes' | 'ask';
}

export interface ManagedBlockSpan {
  boxId: string;
  alias?: string;
  startIndex: number;
  endIndex: number;
}

const START_MARKER_PREFIX = '# >>> boxlite-cloud:';
const START_MARKER_SUFFIX = ' (managed by BoxLite extension) >>>';
const END_MARKER_PREFIX = '# <<< boxlite-cloud:';
const END_MARKER_SUFFIX = ' <<<';

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function sanitizeAlias(
  boxName: string | undefined,
  boxId: string,
  existingAliasesForOtherBoxes?: Set<string>
): string {
  const cleanedName = (boxName || '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');

  const shortId = boxId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .slice(0, 6) || 'box';

  const baseBody = cleanedName.startsWith('boxlite-')
    ? cleanedName.slice('boxlite-'.length)
    : cleanedName;

  const baseAlias = baseBody ? `boxlite-${baseBody}` : `boxlite-${shortId}`;

  if (!existingAliasesForOtherBoxes || !existingAliasesForOtherBoxes.has(baseAlias)) {
    return baseAlias;
  }

  const withShortId = `${baseAlias}-${shortId}`;
  if (!existingAliasesForOtherBoxes.has(withShortId)) {
    return withShortId;
  }

  let counter = 2;
  while (existingAliasesForOtherBoxes.has(`${withShortId}-${counter}`)) {
    counter++;
  }
  return `${withShortId}-${counter}`;
}

function formatConfigPathValue(filePath: string): string {
  if (/[\s"'#]/.test(filePath)) {
    return `"${filePath.replace(/"/g, '\\"')}"`;
  }
  return filePath;
}

export function formatManagedBlock(spec: SshHostBlockSpec, eol = '\n'): string {
  const lines = [
    `${START_MARKER_PREFIX}${spec.boxId}${START_MARKER_SUFFIX}`,
    `Host ${spec.alias}`,
    `  HostName ${spec.hostName}`,
    `  User ${spec.user || 'box'}`,
    `  IdentityFile ${formatConfigPathValue(spec.identityFile)}`,
    '  IdentitiesOnly yes'
  ];

  if (spec.port && spec.port !== '22') {
    lines.push(`  Port ${spec.port}`);
  }

  if (spec.userKnownHostsFile) {
    lines.push(`  UserKnownHostsFile ${formatConfigPathValue(spec.userKnownHostsFile)}`);
  }

  if (spec.hostKeyAlias) {
    lines.push(`  HostKeyAlias ${spec.hostKeyAlias}`);
  }

  if (spec.strictHostKeyChecking) {
    lines.push(`  StrictHostKeyChecking ${spec.strictHostKeyChecking}`);
  }

  if (spec.proxyCommand) {
    lines.push(`  ProxyCommand ${spec.proxyCommand}`);
  }

  lines.push(`${END_MARKER_PREFIX}${spec.boxId}${END_MARKER_SUFFIX}`);
  return lines.join(eol);
}

export function parseManagedBlocks(configText: string): ManagedBlockSpan[] {
  const spans: ManagedBlockSpan[] = [];
  const startRegex = /^# >>> boxlite-cloud:([^\s]+) \(managed by BoxLite extension\) >>>[ \t]*\r?$/gm;

  let match: RegExpExecArray | null;
  while ((match = startRegex.exec(configText)) !== null) {
    const boxId = match[1];
    const startIndex = match.index;
    const afterStart = match.index + match[0].length;
    const endRegex = new RegExp(
      `^${escapeRegExp(END_MARKER_PREFIX + boxId + END_MARKER_SUFFIX)}[ \\t]*\\r?$`,
      'm'
    );
    const rest = configText.slice(afterStart);
    const endMatch = endRegex.exec(rest);
    if (!endMatch) {
      continue;
    }
    const endIndex = afterStart + endMatch.index + endMatch[0].length;
    const blockBody = configText.slice(startIndex, endIndex);
    const hostMatch = /^[ \t]*Host[ \t]+([^\s#]+)/m.exec(blockBody);
    spans.push({
      boxId,
      alias: hostMatch ? hostMatch[1] : undefined,
      startIndex,
      endIndex
    });
  }

  return spans;
}

export function collectOtherAliases(configText: string, excludeBoxId?: string): Set<string> {
  const managed = parseManagedBlocks(configText);
  const aliases = new Set<string>();

  for (const span of managed) {
    if (span.boxId !== excludeBoxId && span.alias) {
      aliases.add(span.alias);
    }
  }

  // Also scan outside managed blocks for existing Host declarations
  let stripped = configText;
  for (let i = managed.length - 1; i >= 0; i--) {
    const s = managed[i];
    stripped = stripped.slice(0, s.startIndex) + stripped.slice(s.endIndex);
  }
  const hostLineRegex = /^[ \t]*Host[ \t]+(.+)$/gm;
  let match: RegExpExecArray | null;
  while ((match = hostLineRegex.exec(stripped)) !== null) {
    const line = match[1].split('#')[0].trim();
    for (const token of line.split(/\s+/)) {
      if (token && !token.includes('*') && !token.includes('?')) {
        aliases.add(token);
      }
    }
  }

  return aliases;
}

function detectEol(text: string): string {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

export function upsertBlock(
  configText: string,
  spec: SshHostBlockSpec
): { content: string; alias: string; changed: boolean } {
  const eol = detectEol(configText);
  const existing = parseManagedBlocks(configText).find((b) => b.boxId === spec.boxId);
  const blockText = formatManagedBlock(spec, eol);

  if (existing) {
    const before = configText.slice(0, existing.startIndex);
    const after = configText.slice(existing.endIndex);
    const nextContent = `${before}${blockText}${after}`;
    return {
      content: nextContent,
      alias: spec.alias,
      changed: nextContent !== configText
    };
  }

  const trimmedEnd = configText.replace(/[ \t\r\n]+$/, '');
  const nextContent = trimmedEnd.length === 0
    ? `${blockText}${eol}`
    : `${trimmedEnd}${eol}${eol}${blockText}${eol}`;

  return {
    content: nextContent,
    alias: spec.alias,
    changed: true
  };
}

export function removeBlock(
  configText: string,
  boxId: string
): { content: string; removed: boolean } {
  const existing = parseManagedBlocks(configText).find((b) => b.boxId === boxId);
  if (!existing) {
    return { content: configText, removed: false };
  }

  const eol = detectEol(configText);
  const before = configText.slice(0, existing.startIndex).replace(/[ \t\r\n]+$/, '');
  const after = configText.slice(existing.endIndex).replace(/^[ \t\r\n]+/, '');

  let nextContent = '';
  if (before && after) {
    nextContent = `${before}${eol}${eol}${after}`;
  } else if (before) {
    nextContent = `${before}${eol}`;
  } else if (after) {
    nextContent = after;
  }

  return { content: nextContent, removed: true };
}

export function removeAllManagedBlocks(configText: string): { content: string; removedCount: number } {
  const spans = parseManagedBlocks(configText);
  if (spans.length === 0) {
    return { content: configText, removedCount: 0 };
  }

  let current = configText;
  for (const span of spans) {
    const res = removeBlock(current, span.boxId);
    current = res.content;
  }

  return { content: current, removedCount: spans.length };
}

export class SshConfigFileManager {
  constructor(private readonly defaultConfigPath: string = path.join(os.homedir(), '.ssh', 'config')) {}

  public getDefaultConfigPath(): string {
    return this.defaultConfigPath;
  }

  public ensureSshDir(filePath: string): void {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
  }

  public readConfig(filePath = this.defaultConfigPath): string {
    if (!fs.existsSync(filePath)) {
      return '';
    }
    return fs.readFileSync(filePath, 'utf-8');
  }

  public writeAtomic(filePath: string, content: string): void {
    this.ensureSshDir(filePath);
    const dir = path.dirname(filePath);
    const baseName = path.basename(filePath);
    const backupPath = path.join(dir, `${baseName}.boxlite.bak`);

    if (fs.existsSync(filePath) && !fs.existsSync(backupPath)) {
      fs.copyFileSync(filePath, backupPath);
      if (process.platform !== 'win32') {
        try {
          fs.chmodSync(backupPath, 0o600);
        } catch {}
      }
    }

    const tempPath = path.join(dir, `.${baseName}.boxlite.tmp.${process.pid}.${Date.now()}`);
    fs.writeFileSync(tempPath, content, { encoding: 'utf-8', mode: 0o600 });
    fs.renameSync(tempPath, filePath);
  }

  public resolveAlias(boxName: string | undefined, boxId: string, filePath = this.defaultConfigPath): string {
    const current = this.readConfig(filePath);
    const existing = parseManagedBlocks(current).find((b) => b.boxId === boxId);
    if (existing?.alias && !boxName) {
      return existing.alias;
    }
    const otherAliases = collectOtherAliases(current, boxId);
    return sanitizeAlias(boxName, boxId, otherAliases);
  }

  public upsertHost(
    specWithoutCollisionCheck: Omit<SshHostBlockSpec, 'alias'> & { boxName?: string; alias?: string },
    filePath = this.defaultConfigPath
  ): { alias: string; changed: boolean; configPath: string } {
    const current = this.readConfig(filePath);
    const otherAliases = collectOtherAliases(current, specWithoutCollisionCheck.boxId);
    const alias =
      specWithoutCollisionCheck.alias && !otherAliases.has(specWithoutCollisionCheck.alias)
        ? specWithoutCollisionCheck.alias
        : sanitizeAlias(specWithoutCollisionCheck.boxName, specWithoutCollisionCheck.boxId, otherAliases);

    const spec: SshHostBlockSpec = {
      boxId: specWithoutCollisionCheck.boxId,
      alias,
      hostName: specWithoutCollisionCheck.hostName,
      user: specWithoutCollisionCheck.user,
      identityFile: specWithoutCollisionCheck.identityFile,
      proxyCommand: specWithoutCollisionCheck.proxyCommand,
      port: specWithoutCollisionCheck.port,
      userKnownHostsFile: specWithoutCollisionCheck.userKnownHostsFile,
      hostKeyAlias: specWithoutCollisionCheck.hostKeyAlias,
      strictHostKeyChecking: specWithoutCollisionCheck.strictHostKeyChecking
    };

    const res = upsertBlock(current, spec);
    if (res.changed || !fs.existsSync(filePath)) {
      this.writeAtomic(filePath, res.content);
    }

    return { alias, changed: res.changed, configPath: filePath };
  }

  public removeHost(boxId: string, filePath = this.defaultConfigPath): boolean {
    if (!fs.existsSync(filePath)) {
      return false;
    }
    const current = this.readConfig(filePath);
    const res = removeBlock(current, boxId);
    if (res.removed) {
      this.writeAtomic(filePath, res.content);
    }
    return res.removed;
  }

  public removeAllHosts(filePath = this.defaultConfigPath): number {
    if (!fs.existsSync(filePath)) {
      return 0;
    }
    const current = this.readConfig(filePath);
    const res = removeAllManagedBlocks(current);
    if (res.removedCount > 0) {
      this.writeAtomic(filePath, res.content);
    }
    return res.removedCount;
  }
}
