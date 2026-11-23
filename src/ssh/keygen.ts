import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { validateBoxId } from './parse';

export interface GeneratedKeyPair {
  privateKeyPem: string;
  publicKeyLine: string;
  fingerprint: string;
}

export interface BoxKeyBundle {
  directory: string;
  clientKeyPath: string;
  clientPublicKeyPath: string;
  clientPublicKey: string;
  hostKeyPath: string;
  hostPublicKeyPath: string;
  hostPrivateKey: string;
  hostPublicKey: string;
  hostFingerprint: string;
  knownHostsPath: string;
  existed: boolean;
}

function encodeSshString(buf: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(buf.length, 0);
  return Buffer.concat([len, buf]);
}

/**
 * Generates an unencrypted Ed25519 OpenSSH keypair in pure Node.js `crypto`
 * without requiring external `ssh-keygen`.
 */
export function generateEd25519KeyPair(comment = 'boxlite'): GeneratedKeyPair {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  const pkcs8 = privateKey.export({ format: 'der', type: 'pkcs8' });
  const pubRaw = spki.subarray(spki.length - 32);
  const seedRaw = pkcs8.subarray(pkcs8.length - 32);
  const priv64 = Buffer.concat([seedRaw, pubRaw]);

  const alg = Buffer.from('ssh-ed25519', 'utf8');
  const pubBlob = Buffer.concat([encodeSshString(alg), encodeSshString(pubRaw)]);
  const publicKeyLine = comment
    ? `ssh-ed25519 ${pubBlob.toString('base64')} ${comment}`
    : `ssh-ed25519 ${pubBlob.toString('base64')}`;
  const fingerprint =
    'SHA256:' +
    crypto
      .createHash('sha256')
      .update(pubBlob)
      .digest('base64')
      .replace(/=+$/, '');

  const checkInt = crypto.randomBytes(4);
  const privSectionUnpadded = Buffer.concat([
    checkInt,
    checkInt,
    encodeSshString(alg),
    encodeSshString(pubRaw),
    encodeSshString(priv64),
    encodeSshString(Buffer.from(comment, 'utf8'))
  ]);

  const blockSize = 8;
  const padLen = (blockSize - (privSectionUnpadded.length % blockSize)) % blockSize;
  const padding = Buffer.alloc(padLen);
  for (let i = 0; i < padLen; i++) {
    padding[i] = i + 1;
  }
  const privSection = Buffer.concat([privSectionUnpadded, padding]);

  const numKeys = Buffer.alloc(4);
  numKeys.writeUInt32BE(1, 0);

  const keyFileBin = Buffer.concat([
    Buffer.from('openssh-key-v1\0', 'utf8'),
    encodeSshString(Buffer.from('none', 'utf8')),
    encodeSshString(Buffer.from('none', 'utf8')),
    encodeSshString(Buffer.alloc(0)),
    numKeys,
    encodeSshString(pubBlob),
    encodeSshString(privSection)
  ]);

  const b64 = keyFileBin.toString('base64');
  const wrappedLines = b64.match(/.{1,70}/g) || [];
  const privateKeyPem = [
    '-----BEGIN OPENSSH PRIVATE KEY-----',
    ...wrappedLines,
    '-----END OPENSSH PRIVATE KEY-----',
    ''
  ].join('\n');

  return { privateKeyPem, publicKeyLine, fingerprint };
}

/**
 * Computes the SHA-256 fingerprint from an OpenSSH public key line (`ssh-ed25519 AAAA...`).
 */
export function computePublicKeyFingerprint(publicKeyLine: string): string | undefined {
  const parts = (publicKeyLine || '').trim().split(/\s+/);
  if (parts.length < 2) {
    return undefined;
  }
  try {
    const blob = Buffer.from(parts[1], 'base64');
    if (blob.length === 0) {
      return undefined;
    }
    return (
      'SHA256:' +
      crypto
        .createHash('sha256')
        .update(blob)
        .digest('base64')
        .replace(/=+$/, '')
    );
  } catch {
    return undefined;
  }
}

/**
 * Extracts algorithm and base64 key payload (ignoring trailing comment) for exact identity comparison.
 */
export function publicKeyIdentity(publicKeyLine: string): { algorithm: string; payload: string } | undefined {
  const parts = (publicKeyLine || '').trim().split(/\s+/);
  if (parts.length < 2 || !parts[0] || !parts[1]) {
    return undefined;
  }
  return { algorithm: parts[0], payload: parts[1] };
}

export function publicKeysMatch(a: string, b: string): boolean {
  const idA = publicKeyIdentity(a);
  const idB = publicKeyIdentity(b);
  if (!idA || !idB) {
    return false;
  }
  return idA.algorithm === idB.algorithm && idA.payload === idB.payload;
}

function writePrivateFileAtomic(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.tmp.${process.pid}.${Date.now()}`);
  fs.writeFileSync(tmpPath, content, { encoding: 'utf-8', mode: 0o600 });
  fs.renameSync(tmpPath, filePath);
  if (process.platform !== 'win32') {
    try {
      fs.chmodSync(filePath, 0o600);
    } catch {}
  }
}

export function writePinnedKnownHosts(
  knownHostsPath: string,
  hostAlias: string,
  expectedHostPublicKey: string
): void {
  const id = publicKeyIdentity(expectedHostPublicKey);
  if (!id) {
    throw new Error('Invalid host public key: cannot write known_hosts entry.');
  }
  const line = `${hostAlias} ${id.algorithm} ${id.payload}\n`;
  writePrivateFileAtomic(knownHostsPath, line);
}

export function buildScopeHash(scopeIdentity: string): string {
  return crypto.createHash('sha256').update(scopeIdentity).digest('hex').slice(0, 24);
}

/**
 * Loads existing client/host keypairs for a box or generates fresh ones atomically.
 * Never silently rotates existing keys unless `reset` is true.
 */
export function ensureBoxKeyBundle(
  storageRootDir: string,
  scopeIdentity: string,
  boxId: string,
  reset = false
): BoxKeyBundle {
  const safeBoxId = validateBoxId(boxId);
  const scopeHash = buildScopeHash(scopeIdentity);
  const directory = path.join(storageRootDir, 'ssh', scopeHash, safeBoxId);
  const clientKeyPath = path.join(directory, 'client_key');
  const clientPublicKeyPath = path.join(directory, 'client_key.pub');
  const hostKeyPath = path.join(directory, 'host_key');
  const hostPublicKeyPath = path.join(directory, 'host_key.pub');
  const knownHostsPath = path.join(directory, 'known_hosts');

  const allFilesExist =
    fs.existsSync(clientKeyPath) &&
    fs.existsSync(clientPublicKeyPath) &&
    fs.existsSync(hostKeyPath) &&
    fs.existsSync(hostPublicKeyPath);

  if (allFilesExist && !reset) {
    const clientPublicKey = fs.readFileSync(clientPublicKeyPath, 'utf-8').trim();
    const hostPrivateKey = fs.readFileSync(hostKeyPath, 'utf-8');
    const hostPublicKey = fs.readFileSync(hostPublicKeyPath, 'utf-8').trim();
    const hostFingerprint = computePublicKeyFingerprint(hostPublicKey) || '';
    return {
      directory,
      clientKeyPath,
      clientPublicKeyPath,
      clientPublicKey,
      hostKeyPath,
      hostPublicKeyPath,
      hostPrivateKey,
      hostPublicKey,
      hostFingerprint,
      knownHostsPath,
      existed: true
    };
  }

  const parent = path.dirname(directory);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });

  const stagingDir = path.join(parent, `.staging-${boxId}-${process.pid}-${Date.now()}`);
  fs.mkdirSync(stagingDir, { recursive: true, mode: 0o700 });

  try {
    const clientPair = generateEd25519KeyPair('boxlite-client');
    const hostPair = generateEd25519KeyPair('boxlite-host');

    fs.writeFileSync(path.join(stagingDir, 'client_key'), clientPair.privateKeyPem, {
      encoding: 'utf-8',
      mode: 0o600
    });
    fs.writeFileSync(path.join(stagingDir, 'client_key.pub'), `${clientPair.publicKeyLine}\n`, {
      encoding: 'utf-8',
      mode: 0o644
    });
    fs.writeFileSync(path.join(stagingDir, 'host_key'), hostPair.privateKeyPem, {
      encoding: 'utf-8',
      mode: 0o600
    });
    fs.writeFileSync(path.join(stagingDir, 'host_key.pub'), `${hostPair.publicKeyLine}\n`, {
      encoding: 'utf-8',
      mode: 0o644
    });

    if (fs.existsSync(directory)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
    fs.renameSync(stagingDir, directory);

    return {
      directory,
      clientKeyPath,
      clientPublicKeyPath,
      clientPublicKey: clientPair.publicKeyLine,
      hostKeyPath,
      hostPublicKeyPath,
      hostPrivateKey: hostPair.privateKeyPem,
      hostPublicKey: hostPair.publicKeyLine,
      hostFingerprint: hostPair.fingerprint,
      knownHostsPath,
      existed: false
    };
  } catch (err) {
    fs.rmSync(stagingDir, { recursive: true, force: true });
    throw err;
  }
}

export function removeBoxKeyBundle(storageRootDir: string, scopeIdentity: string, boxId: string): void {
  const safeBoxId = validateBoxId(boxId);
  const scopeHash = buildScopeHash(scopeIdentity);
  const directory = path.join(storageRootDir, 'ssh', scopeHash, safeBoxId);
  if (fs.existsSync(directory)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
