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

export interface BoxNetworkInfoResponse {
  box_id?: string;
  name?: string | null;
  status?: string;
  network?: {
    inbound?: { mode?: 'enabled' | 'disabled'; allow_net?: string[] };
    outbound?: { mode?: 'enabled' | 'disabled'; allow_net?: string[] };
  };
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

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export function assertSecureUrl(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new SshCliError('UNKNOWN', `Invalid URL: "${rawUrl}"`);
  }
  if (parsed.protocol === 'https:') {
    return parsed;
  }
  if (parsed.protocol === 'http:') {
    if (LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase())) {
      return parsed;
    }
    throw new SshCliError(
      'UNKNOWN',
      `Insecure http:// URL is only allowed for loopback hosts (127.0.0.1, localhost, ::1); use https:// instead ("${parsed.hostname}").`
    );
  }
  throw new SshCliError('UNKNOWN', `Unsupported URL protocol: "${parsed.protocol}"`);
}

export function assertSafeApiKey(apiKey: string): string {
  if (!apiKey || !apiKey.trim()) {
    throw new SshCliError('AUTH_FAILED', 'No BoxLite Cloud API key is configured.');
  }
  if (/[\r\n\0]/.test(apiKey)) {
    throw new SshCliError('AUTH_FAILED', 'Invalid BoxLite Cloud API key: control characters are not allowed.');
  }
  return apiKey.trim();
}

export function assertValidPort(port: number): number {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new SshCliError('UNKNOWN', `Invalid target port: ${port}. Expected an integer between 1 and 65535.`);
  }
  return port;
}

export function parseListenPort(listenAddress?: string, fallbackPort = 22): number {
  const trimmed = (listenAddress || '').trim();
  if (!trimmed) {
    return fallbackPort;
  }
  const colonIdx = trimmed.lastIndexOf(':');
  if (colonIdx === -1) {
    return fallbackPort;
  }
  const port = Number(trimmed.slice(colonIdx + 1));
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return fallbackPort;
  }
  return port;
}

export class NodeRestHttpTransport implements RestHttpTransport {
  public request(
    method: string,
    url: string,
    headers: Record<string, string>,
    body?: string,
    timeoutMs = DEFAULT_HTTP_TIMEOUT_MS
  ): Promise<{ statusCode: number; body: string }> {
    return new Promise((resolve, reject) => {
      const parsed = assertSecureUrl(url);
      const isHttps = parsed.protocol === 'https:';
      const mod = isHttps ? https : http;

      const reqHeaders: Record<string, string> = { ...headers };
      if (body !== undefined) {
        reqHeaders['Content-Length'] = String(Buffer.byteLength(body, 'utf-8'));
      } else if (method.toUpperCase() === 'POST' || method.toUpperCase() === 'PUT') {
        reqHeaders['Content-Length'] = '0';
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
  if (msg.toLowerCase().includes('box networking is disabled')) {
    return new SshCliError(
      'NETWORK_DISABLED',
      'Box was created with Outbound Network disabled (no guest NIC provisioned at creation, e.g. Quick Create / Air-Gapped mode). BoxLite Cloud SSH tunnels require a guest NIC — create a box with Outbound Network enabled.',
      body
    );
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
    const safeKey = assertSafeApiKey(apiKey);
    const url = this.buildV1Url(restUrl, subPath);
    assertSecureUrl(url);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${safeKey}`,
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

  public async getBox(
    restUrl: string,
    apiKey: string,
    boxId: string
  ): Promise<BoxNetworkInfoResponse> {
    const safeId = encodeURIComponent(validateBoxId(boxId));
    return this.requestJson<BoxNetworkInfoResponse>('GET', restUrl, apiKey, `/boxes/${safeId}`);
  }

  public async enableInbound(restUrl: string, apiKey: string, boxId: string): Promise<void> {
    const safeId = encodeURIComponent(validateBoxId(boxId));
    await this.requestJson('PUT', restUrl, apiKey, `/boxes/${safeId}/network/inbound`, {
      mode: 'enabled',
      allow_net: []
    });
  }

  public async enableOutbound(
    restUrl: string,
    apiKey: string,
    boxId: string,
    allowNet: string[] = []
  ): Promise<void> {
    const safeId = encodeURIComponent(validateBoxId(boxId));
    await this.requestJson('PUT', restUrl, apiKey, `/boxes/${safeId}/network/outbound`, {
      mode: 'enabled',
      allow_net: allowNet
    });
  }

  public async ensureTunnelReachable(
    restUrl: string,
    apiKey: string,
    boxId: string,
    onLog?: (msg: string) => void
  ): Promise<void> {
    let box: BoxNetworkInfoResponse;
    try {
      box = await this.getBox(restUrl, apiKey, boxId);
    } catch (err) {
      if (err instanceof SshCliError && err.code === 'BOX_NOT_FOUND') {
        return;
      }
      throw err;
    }

    if (box.network?.inbound?.mode === 'disabled') {
      await this.enableInbound(restUrl, apiKey, boxId);
    }

    if (box.network?.outbound?.mode === 'disabled') {
      onLog?.(`Outbound network is disabled on box ${boxId} (guest NIC inactive); enabling outbound network via REST API...`);
      try {
        await this.enableOutbound(restUrl, apiKey, boxId, box.network?.outbound?.allow_net || []);
      } catch (err) {
        if (err instanceof SshCliError && err.code === 'AUTH_FAILED') {
          throw err;
        }
        const detail = err instanceof Error ? err.message : String(err);
        throw new SshCliError(
          'NETWORK_DISABLED',
          `Box "${box.name || boxId}" (${boxId}) was created with Outbound Network disabled (no guest NIC provisioned at creation, e.g. Quick Create / Air-Gapped mode). BoxLite Cloud SSH tunnels require a guest NIC — create a box with Outbound Network enabled.`,
          detail
        );
      }
    }
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
    const validPort = assertValidPort(port);
    const body = isPublic ? undefined : { isPublic: false };
    return this.requestJson<TunnelDescriptorResponse>(
      'POST',
      restUrl,
      apiKey,
      `/boxes/${safeId}/network/tunnel?port=${validPort}`,
      body
    );
  }

  public async revokeTunnel(restUrl: string, apiKey: string, boxId: string, port = 22): Promise<void> {
    const safeId = encodeURIComponent(validateBoxId(boxId));
    const validPort = assertValidPort(port);
    await this.requestJson('DELETE', restUrl, apiKey, `/boxes/${safeId}/network/tunnel?port=${validPort}`);
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
    let safeKey: string;
    let parsed: URL;
    try {
      safeKey = assertSafeApiKey(apiKey);
      parsed = assertSecureUrl(tunnelUri);
    } catch (err) {
      return Promise.reject(err);
    }

    const isHttps = parsed.protocol === 'https:';
    const port = parsed.port ? Number(parsed.port) : isHttps ? 443 : 80;
    const authority = `${parsed.hostname}:${port}`;

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

        // Non-2xx refusal: read short error body bounded by Content-Length / 512 bytes / 2s like upstream client.rs
        socket.removeListener('data', onHandshakeData);
        socket.removeListener('close', onHandshakeClose);
        const contentLengthMatch = /^content-length:\s*(\d+)\s*$/im.exec(headerText);
        const expectedRefusalBytes = contentLengthMatch
          ? Math.min(Number(contentLengthMatch[1]), CONNECT_REFUSAL_MAX_BYTES)
          : CONNECT_REFUSAL_MAX_BYTES;
        let refusalTimer: ReturnType<typeof setTimeout> | undefined;
        let refusalBuf = leftover.subarray(0, CONNECT_REFUSAL_MAX_BYTES);
        let refusalDone = false;
        const finishRefusal = () => {
          if (refusalDone) {
            return;
          }
          refusalDone = true;
          if (refusalTimer !== undefined) {
            clearTimeout(refusalTimer);
          }
          const detail = refusalBuf.toString('utf-8').trim() || `CONNECT rejected with HTTP ${statusCode}`;
          fail(parseErrorMessage(statusCode, detail));
        };
        if (refusalBuf.length >= expectedRefusalBytes) {
          finishRefusal();
          return;
        }
        refusalTimer = setTimeout(finishRefusal, CONNECT_REFUSAL_TIMEOUT_MS);
        socket.on('data', (more: Buffer) => {
          const remaining = CONNECT_REFUSAL_MAX_BYTES - refusalBuf.length;
          if (remaining > 0) {
            refusalBuf = Buffer.concat([refusalBuf, more.subarray(0, remaining)]);
          }
          if (refusalBuf.length >= expectedRefusalBytes) {
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
          `X-BoxLite-Authorization: Bearer ${safeKey}`,
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

const MAX_TUNNEL_RECOVERY_ATTEMPTS = 3;
const TUNNEL_RETRY_BACKOFF_MS = 400;

/**
 * Prepares a one-shot tunnel and opens its CONNECT stream, attempting
 * automatic inbound/outbound/SSH recovery if the proxy reports the box
 * is unreachable.
 */
export async function openTunnelWithRecovery(
  restClient: BoxliteRestSshClient,
  restUrl: string,
  apiKey: string,
  boxId: string,
  port: number,
  isCancelled: () => boolean,
  onLog?: (message: string) => void
): Promise<net.Socket | undefined> {
  for (let attempt = 1; attempt <= MAX_TUNNEL_RECOVERY_ATTEMPTS; attempt++) {
    if (isCancelled()) {
      return undefined;
    }

    const descriptor = await restClient.prepareTunnel(restUrl, apiKey, boxId, port, true);
    if (isCancelled()) {
      return undefined;
    }

    try {
      return await restClient.openTunnelStream(descriptor.uri, apiKey);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isUnreachable = /box unreachable|guest tunnel unavailable/i.test(msg);
      if (!isUnreachable || attempt >= MAX_TUNNEL_RECOVERY_ATTEMPTS || isCancelled()) {
        throw err;
      }

      onLog?.(
        `Tunnel to ${boxId}:${port} returned "${msg}"; verifying network and guest SSH state before retrying (attempt ${attempt}/${MAX_TUNNEL_RECOVERY_ATTEMPTS})...`
      );
      await restClient.enableInbound(restUrl, apiKey, boxId).catch(() => {});
      await restClient.ensureTunnelReachable(restUrl, apiKey, boxId, onLog);
      const st = await restClient.getSshStatus(restUrl, apiKey, boxId).catch(() => undefined);
      if (st && !st.enabled && st.generation > 0) {
        await restClient.enableSsh(restUrl, apiKey, boxId).catch(() => {});
      }
      await new Promise<void>((resolve) => setTimeout(resolve, TUNNEL_RETRY_BACKOFF_MS));
    }
  }
  return undefined;
}
