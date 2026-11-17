import * as http from 'http';
import * as https from 'https';
import * as net from 'net';
import * as tls from 'tls';
import { SshCliError } from './cli';
import { validateBoxId } from './parse';

export interface SshAccountSpec {
  login: string;
  authorized_keys?: string[];
  ca?: { public_key: string; principal: string } | null;
}

export interface SshConfigureRequest {
  listen_address: string;
  host_private_key: string;
  accounts: SshAccountSpec[];
}

export interface SshStatusResponse {
  enabled: boolean;
  generation: number;
  listen_address: string;
  host_public_key: string;
  host_key_fingerprint: string;
}

export interface TunnelDescriptorResponse {
  uri: string;
  isPublic?: boolean;
  token?: string | null;
}

export interface RestHttpTransport {
  request(
    method: string,
    url: string,
    headers: Record<string, string>,
    body?: string,
    timeoutMs?: number
  ): Promise<{ statusCode: number; body: string }>;
}

const DEFAULT_HTTP_TIMEOUT_MS = 30_000;
const CONNECT_REFUSAL_MAX_BYTES = 512;
const CONNECT_REFUSAL_TIMEOUT_MS = 2_000;
const MAX_CONNECT_HEADER_BYTES = 16_384;

export class NodeRestHttpTransport implements RestHttpTransport {
  public request(
    method: string,
    url: string,
    headers: Record<string, string>,
    body?: string,
    timeoutMs = DEFAULT_HTTP_TIMEOUT_MS
  ): Promise<{ statusCode: number; body: string }> {
    return new Promise((resolve, reject) => {
      const parsed = new URL(url);
      const isHttps = parsed.protocol === 'https:';
      const mod = isHttps ? https : http;

      const reqHeaders: Record<string, string> = { ...headers };
      if (body !== undefined) {
        reqHeaders['Content-Length'] = String(Buffer.byteLength(body, 'utf-8'));
      }

      const req = mod.request(
        {
          protocol: parsed.protocol,
          hostname: parsed.hostname,
          port: parsed.port ? Number(parsed.port) : isHttps ? 443 : 80,
          path: `${parsed.pathname}${parsed.search}`,
          method,
          headers: reqHeaders,
          timeout: timeoutMs
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            resolve({
              statusCode: res.statusCode ?? 0,
              body: Buffer.concat(chunks).toString('utf-8')
            });
          });
        }
      );

      req.on('timeout', () => {
        req.destroy(new Error(`Request timed out after ${timeoutMs}ms`));
      });
      req.on('error', (err) => reject(err));

      if (body !== undefined) {
        req.write(body);
      }
      req.end();
    });
  }
}

function parseErrorMessage(statusCode: number, body: string): SshCliError {
  let msg = body.trim();
  try {
    const parsed = JSON.parse(body);
    if (parsed && typeof parsed === 'object') {
      msg = parsed.message || parsed.error || msg;
    }
  } catch {
    // Keep raw text
  }

  if (statusCode === 401 || statusCode === 403) {
    return new SshCliError(
      'AUTH_FAILED',
      msg || `BoxLite Cloud authentication failed (${statusCode}).`
    );
  }
  if (statusCode === 404) {
    return new SshCliError('BOX_NOT_FOUND', msg || 'Box not found in BoxLite Cloud (404).');
  }
  return new SshCliError('UNKNOWN', msg || `BoxLite Cloud API returned HTTP ${statusCode}.`, body);
}

export class BoxliteRestSshClient {
  constructor(private readonly transport: RestHttpTransport = new NodeRestHttpTransport()) {}

  private buildV1Url(restUrl: string, subPath: string): string {
    const base = restUrl.trim().replace(/\/+$/, '');
    return `${base}/v1${subPath}`;
  }

  private async requestJson<T>(
    method: string,
    restUrl: string,
    apiKey: string,
    subPath: string,
    body?: unknown,
    timeoutMs = DEFAULT_HTTP_TIMEOUT_MS
  ): Promise<T> {
    if (!apiKey || !apiKey.trim()) {
      throw new SshCliError('AUTH_FAILED', 'No BoxLite Cloud API key is configured.');
    }

    const url = this.buildV1Url(restUrl, subPath);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${apiKey.trim()}`,
      Accept: 'application/json',
      'User-Agent': 'boxlite-cloud-vscode/0.3.0'
    };

    let bodyStr: string | undefined;
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      bodyStr = JSON.stringify(body);
    }

    const res = await this.transport.request(method, url, headers, bodyStr, timeoutMs);
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw parseErrorMessage(res.statusCode, res.body);
    }

    if (!res.body || !res.body.trim()) {
      return {} as T;
    }

    try {
      return JSON.parse(res.body) as T;
    } catch {
      throw new SshCliError(
        'PARSE_FAILED',
        `Expected JSON response from ${method} ${subPath}, got invalid body.`,
        res.body
      );
    }
  }

  public async enableInbound(restUrl: string, apiKey: string, boxId: string): Promise<void> {
    const safeId = encodeURIComponent(validateBoxId(boxId));
    await this.requestJson('PUT', restUrl, apiKey, `/boxes/${safeId}/network/inbound`, {
      mode: 'enabled',
      allow_net: []
    });
  }

  public async getSshStatus(
    restUrl: string,
    apiKey: string,
    boxId: string
  ): Promise<SshStatusResponse> {
    const safeId = encodeURIComponent(validateBoxId(boxId));
    return this.requestJson<SshStatusResponse>('GET', restUrl, apiKey, `/boxes/${safeId}/ssh`);
  }

  /**
   * Configures guest SSH (never auto-retried, as each accepted call restarts the guest listener).
   */
  public async configureSsh(
    restUrl: string,
    apiKey: string,
    boxId: string,
    config: SshConfigureRequest
  ): Promise<SshStatusResponse> {
    const safeId = encodeURIComponent(validateBoxId(boxId));
    return this.requestJson<SshStatusResponse>('POST', restUrl, apiKey, `/boxes/${safeId}/ssh`, config, 60_000);
  }

  public async enableSsh(restUrl: string, apiKey: string, boxId: string): Promise<SshStatusResponse> {
    const safeId = encodeURIComponent(validateBoxId(boxId));
    return this.requestJson<SshStatusResponse>('POST', restUrl, apiKey, `/boxes/${safeId}/ssh/enable`);
  }

  public async disableSsh(restUrl: string, apiKey: string, boxId: string): Promise<SshStatusResponse> {
    const safeId = encodeURIComponent(validateBoxId(boxId));
    return this.requestJson<SshStatusResponse>('DELETE', restUrl, apiKey, `/boxes/${safeId}/ssh`);
  }

  public async prepareTunnel(
    restUrl: string,
    apiKey: string,
    boxId: string,
    port = 22,
    isPublic = true
  ): Promise<TunnelDescriptorResponse> {
    const safeId = encodeURIComponent(validateBoxId(boxId));
    const body = isPublic ? undefined : { isPublic: false };
    return this.requestJson<TunnelDescriptorResponse>(
      'POST',
      restUrl,
      apiKey,
      `/boxes/${safeId}/network/tunnel?port=${port}`,
      body
    );
  }

  public async revokeTunnel(restUrl: string, apiKey: string, boxId: string, port = 22): Promise<void> {
    const safeId = encodeURIComponent(validateBoxId(boxId));
    await this.requestJson('DELETE', restUrl, apiKey, `/boxes/${safeId}/network/tunnel?port=${port}`);
  }

  /**
   * Opens a raw bidirectional byte stream to the prepared tunnel URI via HTTP/1.1 CONNECT.
   * Each prepared tunnel URI is one-shot; call prepareTunnel() for every new connection.
   */
  public openTunnelStream(
    tunnelUri: string,
    apiKey: string,
    timeoutMs = DEFAULT_HTTP_TIMEOUT_MS
  ): Promise<net.Socket> {
    if (!apiKey || !apiKey.trim()) {
      return Promise.reject(new SshCliError('AUTH_FAILED', 'No BoxLite Cloud API key is configured.'));
    }

    let parsed: URL;
    try {
      parsed = new URL(tunnelUri);
    } catch {
      return Promise.reject(new SshCliError('UNKNOWN', `Invalid tunnel URI: "${tunnelUri}"`));
    }

    const isHttps = parsed.protocol === 'https:';
    if (!isHttps && parsed.protocol !== 'http:') {
      return Promise.reject(new SshCliError('UNKNOWN', `Unsupported tunnel URI protocol: "${parsed.protocol}"`));
    }

    const port = parsed.port ? Number(parsed.port) : isHttps ? 443 : 80;
    const authority = parsed.host; // hostname or hostname:port

    return new Promise<net.Socket>((resolve, reject) => {
      let settled = false;
      let headerBuf = Buffer.alloc(0);

      const socket: net.Socket = isHttps
        ? tls.connect({
            host: parsed.hostname,
            port,
            servername: parsed.hostname,
            ALPNProtocols: ['http/1.1']
          })
        : net.connect({ host: parsed.hostname, port });

      const cleanupListeners = () => {
        socket.removeListener('data', onHandshakeData);
        socket.removeListener('error', onHandshakeError);
        socket.removeListener('close', onHandshakeClose);
        clearTimeout(handshakeTimer);
      };

      const fail = (err: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanupListeners();
        try {
          socket.destroy();
        } catch {}
        reject(err);
      };

      const handshakeTimer = setTimeout(() => {
        fail(new SshCliError('UNKNOWN', `Tunnel CONNECT timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      const onHandshakeError = (err: Error) => {
        fail(new SshCliError('UNKNOWN', `Tunnel socket error: ${err.message}`));
      };

      const onHandshakeClose = () => {
        fail(new SshCliError('UNKNOWN', 'Tunnel closed before CONNECT handshake completed.'));
      };

      const onHandshakeData = (chunk: Buffer) => {
        headerBuf = Buffer.concat([headerBuf, chunk]);
        const headerEnd = headerBuf.indexOf('\r\n\r\n');
        if (headerEnd === -1) {
          if (headerBuf.length > MAX_CONNECT_HEADER_BYTES) {
            fail(new SshCliError('UNKNOWN', 'Tunnel proxy CONNECT response headers exceeded 16 KiB limit.'));
          }
          return;
        }

        const headerText = headerBuf.subarray(0, headerEnd).toString('utf-8');
        const leftover = headerBuf.subarray(headerEnd + 4);
        const statusLine = headerText.split(/\r?\n/)[0] || '';
        const statusMatch = /^HTTP\/\d(?:\.\d)?\s+(\d{3})\b/i.exec(statusLine);
        const statusCode = statusMatch ? Number(statusMatch[1]) : 0;

        if (statusCode >= 200 && statusCode < 300) {
          settled = true;
          cleanupListeners();
          socket.pause();
          if (leftover.length > 0) {
            socket.unshift(leftover);
          }
          resolve(socket);
          return;
        }

        // Non-2xx refusal: read short error body bounded by 512 bytes / 2s like upstream client.rs
        socket.removeListener('data', onHandshakeData);
        socket.removeListener('close', onHandshakeClose);
        let refusalBuf = leftover.subarray(0, CONNECT_REFUSAL_MAX_BYTES);
        const finishRefusal = () => {
          clearTimeout(refusalTimer);
          const detail = refusalBuf.toString('utf-8').trim() || `CONNECT rejected with HTTP ${statusCode}`;
          fail(parseErrorMessage(statusCode, detail));
        };
        if (refusalBuf.length >= CONNECT_REFUSAL_MAX_BYTES) {
          finishRefusal();
          return;
        }
        const refusalTimer = setTimeout(finishRefusal, CONNECT_REFUSAL_TIMEOUT_MS);
        socket.on('data', (more: Buffer) => {
          const remaining = CONNECT_REFUSAL_MAX_BYTES - refusalBuf.length;
          if (remaining > 0) {
            refusalBuf = Buffer.concat([refusalBuf, more.subarray(0, remaining)]);
          }
          if (refusalBuf.length >= CONNECT_REFUSAL_MAX_BYTES) {
            finishRefusal();
          }
        });
        socket.once('end', finishRefusal);
        socket.once('close', finishRefusal);
      };

      const connectEvent = isHttps ? 'secureConnect' : 'connect';
      socket.once(connectEvent, () => {
        const reqLines = [
          `CONNECT ${authority} HTTP/1.1`,
          `Host: ${authority}`,
          `X-BoxLite-Authorization: Bearer ${apiKey.trim()}`,
          '',
          ''
        ].join('\r\n');
        socket.write(reqLines);
      });

      socket.on('data', onHandshakeData);
      socket.on('error', onHandshakeError);
      socket.on('close', onHandshakeClose);
    });
  }
}
