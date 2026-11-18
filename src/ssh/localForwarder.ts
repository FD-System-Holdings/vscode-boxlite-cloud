import * as net from 'net';
import { BoxliteRestSshClient, openTunnelWithRecovery } from './restClient';

export interface CredentialsSupplier {
  (): Promise<{ restUrl: string; apiKey: string }>;
}

/**
 * In-extension loopback TCP forwarder (127.0.0.1:<ephemeralPort>) backed by
 * one-shot BoxLite Cloud tunnels. Each accepted TCP socket creates a fresh
 * `prepareTunnel` + `openTunnelStream` connection.
 */
export class LocalSshForwarder {
  private server: net.Server | undefined;
  private boundPort: number | undefined;
  private activeSockets = new Set<net.Socket>();
  private closed = false;

  constructor(
    public readonly boxId: string,
    public readonly targetPort: number,
    private readonly restClient: BoxliteRestSshClient,
    private readonly getCredentials: CredentialsSupplier,
    private readonly onLog?: (message: string) => void,
    private readonly onError?: (boxId: string, err: unknown) => void
  ) {}

  public getPort(): number | undefined {
    return this.boundPort;
  }

  public isListening(): boolean {
    return Boolean(this.server && this.server.listening && !this.closed);
  }

  public async start(): Promise<{ host: string; port: number }> {
    if (this.server && this.server.listening && this.boundPort) {
      return { host: '127.0.0.1', port: this.boundPort };
    }

    this.closed = false;
    const server = net.createServer((clientSocket) => {
      void this.handleClientSocket(clientSocket);
    });
    this.server = server;

    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => {
        server.removeListener('listening', onListening);
        reject(err);
      };
      const onListening = () => {
        server.removeListener('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(0, '127.0.0.1');
    });

    const addr = server.address();
    if (!addr || typeof addr === 'string') {
      await this.close();
      throw new Error('Failed to bind local SSH forwarder to an ephemeral TCP port.');
    }

    this.boundPort = addr.port;
    this.onLog?.(`Local SSH forwarder listening on 127.0.0.1:${addr.port} for box ${this.boxId}:${this.targetPort}.`);
    return { host: '127.0.0.1', port: addr.port };
  }

  private async handleClientSocket(clientSocket: net.Socket): Promise<void> {
    if (this.closed) {
      clientSocket.destroy();
      return;
    }

    // Pause immediately so client SSH banner bytes wait until the remote CONNECT stream opens.
    clientSocket.pause();
    this.activeSockets.add(clientSocket);

    let tunnelSocket: net.Socket | undefined;

    const cleanup = () => {
      this.activeSockets.delete(clientSocket);
      if (tunnelSocket) {
        this.activeSockets.delete(tunnelSocket);
        if (!tunnelSocket.destroyed) {
          tunnelSocket.destroy();
        }
      }
      if (!clientSocket.destroyed) {
        clientSocket.destroy();
      }
    };

    clientSocket.on('error', (err) => {
      this.onLog?.(`Local SSH client socket error for ${this.boxId}: ${err.message}`);
      cleanup();
    });
    clientSocket.once('close', () => {
      cleanup();
    });

    try {
      const { restUrl, apiKey } = await this.getCredentials();
      tunnelSocket = await openTunnelWithRecovery(
        this.restClient,
        restUrl,
        apiKey,
        this.boxId,
        this.targetPort,
        () => this.closed || clientSocket.destroyed,
        this.onLog
      );
      if (!tunnelSocket || this.closed || clientSocket.destroyed) {
        if (tunnelSocket && !tunnelSocket.destroyed) {
          tunnelSocket.destroy();
        }
        return;
      }

      this.activeSockets.add(tunnelSocket);
      tunnelSocket.on('error', (err) => {
        this.onLog?.(`Remote SSH tunnel stream error for ${this.boxId}: ${err.message}`);
        cleanup();
      });
      tunnelSocket.once('close', () => {
        cleanup();
      });

      clientSocket.pipe(tunnelSocket);
      tunnelSocket.pipe(clientSocket);
      clientSocket.resume();
      tunnelSocket.resume();
    } catch (err: any) {
      this.onLog?.(`Failed to establish SSH tunnel for ${this.boxId}: ${err?.message || err}`);
      this.onError?.(this.boxId, err);
      cleanup();
    }
  }

  public async close(): Promise<void> {
    this.closed = true;
    for (const sock of this.activeSockets) {
      try {
        sock.destroy();
      } catch {}
    }
    this.activeSockets.clear();

    const srv = this.server;
    this.server = undefined;
    this.boundPort = undefined;
    if (!srv) {
      return;
    }
    await new Promise<void>((resolve) => {
      try {
        srv.close(() => resolve());
      } catch {
        resolve();
      }
    });
  }
}

export class LocalForwarderManager {
  private forwarders = new Map<string, LocalSshForwarder>();

  constructor(
    private readonly restClient: BoxliteRestSshClient,
    private readonly getCredentials: CredentialsSupplier,
    private readonly onLog?: (message: string) => void,
    private readonly onError?: (boxId: string, err: unknown) => void
  ) {}

  public async ensureForwarder(boxId: string, targetPort = 22): Promise<{ host: string; port: number }> {
    const key = `${boxId}:${targetPort}`;
    const existing = this.forwarders.get(key);
    if (existing && existing.isListening() && existing.getPort()) {
      return { host: '127.0.0.1', port: existing.getPort()! };
    }

    const forwarder = new LocalSshForwarder(
      boxId,
      targetPort,
      this.restClient,
      this.getCredentials,
      this.onLog,
      this.onError
    );
    this.forwarders.set(key, forwarder);
    return forwarder.start();
  }

  public async stopForwarder(boxId: string, targetPort = 22): Promise<void> {
    const key = `${boxId}:${targetPort}`;
    const forwarder = this.forwarders.get(key);
    if (forwarder) {
      this.forwarders.delete(key);
      await forwarder.close();
    }
  }

  public async dispose(): Promise<void> {
    const all = Array.from(this.forwarders.values());
    this.forwarders.clear();
    await Promise.all(all.map((f) => f.close()));
  }
}
