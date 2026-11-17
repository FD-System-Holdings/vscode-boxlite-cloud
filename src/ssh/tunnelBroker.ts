import * as crypto from 'crypto';
import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import { CredentialsSupplier } from './localForwarder';
import { validateBoxId } from './parse';
import { BoxliteRestSshClient } from './restClient';

export interface BrokerDescriptor {
  port: number;
  secret: string;
  pid: number;
}

const MAX_HANDSHAKE_BYTES = 4096;

/**
 * Loopback broker hosted by the extension so standalone `ssh-proxy.js` ProxyCommand
 * processes can open one-shot Cloud tunnels without ever writing API keys to disk.
 */
export class LocalTunnelBroker {
  private server: net.Server | undefined;
  private secret: string | undefined;
  private boundPort: number | undefined;
  private activeSockets = new Set<net.Socket>();
  private startPromise: Promise<string> | undefined;

  constructor(
    private readonly descriptorPath: string,
    private readonly restClient: BoxliteRestSshClient,
    private readonly getCredentials: CredentialsSupplier,
    private readonly onLog?: (message: string) => void
  ) {}

  public getDescriptorPath(): string {
    return this.descriptorPath;
  }

  public async ensureStarted(): Promise<string> {
    if (this.server && this.server.listening && this.boundPort && this.secret && fs.existsSync(this.descriptorPath)) {
      return this.descriptorPath;
    }
    if (this.startPromise) {
      return this.startPromise;
    }
    this.startPromise = this.startInternal().finally(() => {
      this.startPromise = undefined;
    });
    return this.startPromise;
  }

  private async startInternal(): Promise<string> {
    const secret = crypto.randomBytes(32).toString('hex');
    const server = net.createServer((socket) => {
      void this.handleClient(socket, secret);
    });

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
      server.close();
      throw new Error('Failed to bind local SSH tunnel broker.');
    }

    this.server = server;
    this.secret = secret;
    this.boundPort = addr.port;

    const dir = path.dirname(this.descriptorPath);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmpPath = path.join(dir, `.ssh-broker.tmp.${process.pid}.${Date.now()}`);
    const payload: BrokerDescriptor = {
      port: addr.port,
      secret,
      pid: process.pid
    };
    fs.writeFileSync(tmpPath, JSON.stringify(payload), { encoding: 'utf-8', mode: 0o600 });
    fs.renameSync(tmpPath, this.descriptorPath);
    if (process.platform !== 'win32') {
      try {
        fs.chmodSync(this.descriptorPath, 0o600);
      } catch {}
    }

    this.onLog?.(`SSH tunnel broker listening on 127.0.0.1:${addr.port}.`);
    return this.descriptorPath;
  }

  private async handleClient(clientSocket: net.Socket, expectedSecret: string): Promise<void> {
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

    clientSocket.on('error', () => cleanup());
    clientSocket.once('close', () => cleanup());

    try {
      const { boxId, port, leftover } = await this.readHandshake(clientSocket, expectedSecret);
      const { restUrl, apiKey } = await this.getCredentials();
      const descriptor = await this.restClient.prepareTunnel(restUrl, apiKey, boxId, port, true);
      tunnelSocket = await this.restClient.openTunnelStream(descriptor.uri, apiKey);

      if (clientSocket.destroyed) {
        tunnelSocket.destroy();
        return;
      }

      this.activeSockets.add(tunnelSocket);
      tunnelSocket.on('error', () => cleanup());
      tunnelSocket.once('close', () => cleanup());

      clientSocket.write('OK\n');
      if (leftover.length > 0) {
        clientSocket.unshift(leftover);
      }
      clientSocket.pipe(tunnelSocket);
      tunnelSocket.pipe(clientSocket);
      clientSocket.resume();
      tunnelSocket.resume();
    } catch (err: any) {
      const msg = (err?.message || String(err)).replace(/[\r\n]+/g, ' ');
      this.onLog?.(`Tunnel broker error: ${msg}`);
      try {
        if (!clientSocket.destroyed && clientSocket.writable) {
          clientSocket.end(`ERR ${msg}\n`);
        }
      } catch {}
      cleanup();
    }
  }

  private readHandshake(
    socket: net.Socket,
    expectedSecret: string
  ): Promise<{ boxId: string; port: number; leftover: Buffer }> {
    return new Promise((resolve, reject) => {
      let buf = Buffer.alloc(0);
      const timer = setTimeout(() => {
        socket.removeListener('data', onData);
        reject(new Error('Broker handshake timed out.'));
      }, 10_000);

      const onData = (chunk: Buffer) => {
        buf = Buffer.concat([buf, chunk]);
        const nlIdx = buf.indexOf(0x0a);
        if (nlIdx === -1) {
          if (buf.length > MAX_HANDSHAKE_BYTES) {
            clearTimeout(timer);
            socket.removeListener('data', onData);
            reject(new Error('Broker handshake line too large.'));
          }
          return;
        }

        clearTimeout(timer);
        socket.removeListener('data', onData);
        socket.pause();

        const line = buf.subarray(0, nlIdx).toString('utf-8').trim();
        const leftover = buf.subarray(nlIdx + 1);

        try {
          const req = JSON.parse(line) as { secret?: string; boxId?: string; port?: number };
          const suppliedBuf = Buffer.from(String(req.secret || ''), 'utf-8');
          const expectedBuf = Buffer.from(expectedSecret, 'utf-8');
          if (
            suppliedBuf.length !== expectedBuf.length ||
            !crypto.timingSafeEqual(suppliedBuf, expectedBuf)
          ) {
            reject(new Error('Unauthorized tunnel broker client.'));
            return;
          }

          const boxId = validateBoxId(String(req.boxId || ''));
          const port = Number(req.port ?? 22);
          if (!Number.isInteger(port) || port < 1 || port > 65535) {
            reject(new Error(`Invalid target port: ${req.port}`));
            return;
          }
          resolve({ boxId, port, leftover });
        } catch (err) {
          reject(err);
        }
      };

      socket.on('data', onData);
    });
  }

  public async dispose(): Promise<void> {
    for (const s of this.activeSockets) {
      try {
        s.destroy();
      } catch {}
    }
    this.activeSockets.clear();

    const srv = this.server;
    this.server = undefined;
    this.secret = undefined;
    this.boundPort = undefined;

    if (fs.existsSync(this.descriptorPath)) {
      try {
        fs.unlinkSync(this.descriptorPath);
      } catch {}
    }

    if (srv) {
      await new Promise<void>((resolve) => {
        try {
          srv.close(() => resolve());
        } catch {
          resolve();
        }
      });
    }
  }
}
