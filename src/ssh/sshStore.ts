import * as crypto from 'crypto';
import * as fs from 'fs';
import * as vscode from 'vscode';

const STORAGE_KEY_CONFIGS = 'boxlite.ssh.configs';
const STORAGE_KEY_LOGGED_CONTEXTS = 'boxlite.ssh.loggedContexts';

export interface StoredSshConfig {
  boxId: string;
  boxName?: string;
  contextName: string;
  mode?: 'sdk' | 'cli';
  keyPath: string;
  knownHostsPath?: string;
  hostKeyAlias?: string;
  hostPublicKey?: string;
  loginUser?: string;
  fingerprint: string;
  sshBin: string;
  sshArgs: string[];
  sshCommand: string;
  proxyCommand?: string;
  hostAlias?: string;
  configuredAt: string;
  trustedAt?: string;
}

export class SshStore {
  constructor(
    private readonly context: Pick<vscode.ExtensionContext, 'globalState'>,
    private readonly fileExists: (filePath: string) => boolean = (p) => fs.existsSync(p)
  ) {}

  public static buildKey(orgContext: string, boxId: string): string {
    return `${orgContext}:${boxId}`;
  }

  public static computeCredentialDigest(restUrl: string, apiKey: string): string {
    return crypto.createHash('sha256').update(`${restUrl}|${apiKey}`).digest('hex');
  }

  private loadMap(): Record<string, StoredSshConfig> {
    const raw = this.context.globalState.get<Record<string, StoredSshConfig>>(STORAGE_KEY_CONFIGS);
    if (!raw || typeof raw !== 'object') {
      return {};
    }
    return { ...raw };
  }

  private async saveMap(map: Record<string, StoredSshConfig>): Promise<void> {
    await this.context.globalState.update(STORAGE_KEY_CONFIGS, map);
  }

  public get(orgContext: string, boxId: string): StoredSshConfig | undefined {
    const map = this.loadMap();
    return map[SshStore.buildKey(orgContext, boxId)];
  }

  public hasReadyConfig(orgContext: string, boxId: string): boolean {
    const entry = this.get(orgContext, boxId);
    if (!entry || !entry.keyPath) {
      return false;
    }
    try {
      return this.fileExists(entry.keyPath);
    } catch {
      return false;
    }
  }

  /**
   * Checks whether any stored config for `boxId` (or matching `orgContext`) has an existing key file.
   */
  public isBoxSshReadySync(boxId: string, orgContext?: string): boolean {
    if (orgContext) {
      return this.hasReadyConfig(orgContext, boxId);
    }
    const map = this.loadMap();
    for (const entry of Object.values(map)) {
      if (entry && entry.boxId === boxId && entry.keyPath) {
        try {
          if (this.fileExists(entry.keyPath)) {
            return true;
          }
        } catch {
          // Ignore fs errors
        }
      }
    }
    return false;
  }

  public async set(orgContext: string, config: StoredSshConfig): Promise<void> {
    const map = this.loadMap();
    map[SshStore.buildKey(orgContext, config.boxId)] = { ...config };
    await this.saveMap(map);
  }

  public async updateFingerprintAndTrust(
    orgContext: string,
    boxId: string,
    fingerprint: string
  ): Promise<void> {
    const map = this.loadMap();
    const key = SshStore.buildKey(orgContext, boxId);
    const existing = map[key];
    if (!existing) {
      return;
    }
    map[key] = {
      ...existing,
      fingerprint,
      trustedAt: new Date().toISOString()
    };
    await this.saveMap(map);
  }

  public async markTrusted(orgContext: string, boxId: string): Promise<void> {
    const map = this.loadMap();
    const key = SshStore.buildKey(orgContext, boxId);
    const existing = map[key];
    if (!existing) {
      return;
    }
    map[key] = {
      ...existing,
      trustedAt: new Date().toISOString()
    };
    await this.saveMap(map);
  }

  public async remove(orgContext: string, boxId: string): Promise<void> {
    const map = this.loadMap();
    const key = SshStore.buildKey(orgContext, boxId);
    if (key in map) {
      delete map[key];
      await this.saveMap(map);
    }
  }

  public listAll(): StoredSshConfig[] {
    return Object.values(this.loadMap());
  }

  public isContextLoggedIn(contextName: string, restUrl: string, apiKey: string): boolean {
    const logged = this.context.globalState.get<Record<string, string>>(STORAGE_KEY_LOGGED_CONTEXTS) || {};
    const digest = SshStore.computeCredentialDigest(restUrl, apiKey);
    return logged[contextName] === digest;
  }

  public async markContextLoggedIn(contextName: string, restUrl: string, apiKey: string): Promise<void> {
    const logged = {
      ...(this.context.globalState.get<Record<string, string>>(STORAGE_KEY_LOGGED_CONTEXTS) || {})
    };
    logged[contextName] = SshStore.computeCredentialDigest(restUrl, apiKey);
    await this.context.globalState.update(STORAGE_KEY_LOGGED_CONTEXTS, logged);
  }

  public async clearContextLogin(contextName: string): Promise<void> {
    const logged = {
      ...(this.context.globalState.get<Record<string, string>>(STORAGE_KEY_LOGGED_CONTEXTS) || {})
    };
    if (contextName in logged) {
      delete logged[contextName];
      await this.context.globalState.update(STORAGE_KEY_LOGGED_CONTEXTS, logged);
    }
  }
}
