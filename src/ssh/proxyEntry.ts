import * as fs from 'fs';
import * as net from 'net';
import { validateBoxId } from './parse';
import { assertValidPort, BoxliteRestSshClient } from './restClient';
import { BrokerDescriptor } from './tunnelBroker';

interface ProxyCliArgs {
  boxId: string;
  port: number;
  brokerPath?: string;
  restUrl?: string;
}

function parseArgs(argv: string[]): ProxyCliArgs {
  let boxId = '';
  let port = 22;
  let brokerPath: string | undefined;
  let restUrl: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if ((arg === '--box' || arg === '-b') && i + 1 < argv.length) {
      boxId = argv[++i];
    } else if ((arg === '--port' || arg === '-p') && i + 1 < argv.length) {
      port = Number(argv[++i]);
    } else if (arg === '--broker' && i + 1 < argv.length) {
      brokerPath = argv[++i];
    } else if (arg === '--url' && i + 1 < argv.length) {
      restUrl = argv[++i];
    }
  }

  return {
    boxId: validateBoxId(boxId),
    port: assertValidPort(port),
    brokerPath,
    restUrl
  };
}

function relayStdio(remoteSocket: net.Socket): Promise<void> {
  return new Promise((resolve, reject) => {
    let finished = false;
    const finish = (err?: Error) => {
      if (finished) {
        return;
      }
      finished = true;
      try {
        remoteSocket.destroy();
      } catch {}
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    };

    remoteSocket.on('error', (err) => finish(err));
    remoteSocket.on('close', () => finish());
    process.stdin.on('error', (err) => finish(err));
    process.stdout.on('error', () => finish());

    process.stdin.on('end', () => {
      try {
        remoteSocket.end();
      } catch {}
    });

    remoteSocket.pipe(process.stdout, { end: false });
    process.stdin.pipe(remoteSocket, { end: false });
    remoteSocket.resume();
    process.stdin.resume();
  });
}

async function connectViaBroker(brokerPath: string, boxId: string, port: number): Promise<net.Socket> {
  if (!fs.existsSync(brokerPath)) {
    throw new Error(
      `VS Code BoxLite SSH broker not found at "${brokerPath}". Reconnect from VS Code or set BOXLITE_API_KEY.`
    );
  }
  const descriptor = JSON.parse(fs.readFileSync(brokerPath, 'utf-8')) as BrokerDescriptor;
  const socket = net.connect({ host: '127.0.0.1', port: descriptor.port });

  await new Promise<void>((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('Timed out connecting to BoxLite SSH broker.'));
    }, 30_000);

    const onError = (err: Error) => {
      clearTimeout(timer);
      reject(err);
    };

    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      const nlIdx = buf.indexOf(0x0a);
      if (nlIdx === -1) {
        return;
      }
      clearTimeout(timer);
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
      socket.pause();

      const statusLine = buf.subarray(0, nlIdx).toString('utf-8').trim();
      const rest = buf.subarray(nlIdx + 1);
      if (statusLine === 'OK') {
        if (rest.length > 0) {
          socket.unshift(rest);
        }
        resolve();
      } else {
        socket.destroy();
        reject(new Error(statusLine.replace(/^ERR\s+/, '') || 'Broker rejected tunnel request.'));
      }
    };

    socket.once('error', onError);
    socket.once('connect', () => {
      socket.write(`${JSON.stringify({ secret: descriptor.secret, boxId, port })}\n`);
    });
    socket.on('data', onData);
  });

  return socket;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const envApiKey = (process.env.BOXLITE_API_KEY || '').trim();
  const restUrl = (args.restUrl || process.env.BOXLITE_REST_URL || 'https://api.boxlite.ai').trim();

  let socket: net.Socket;
  if (envApiKey) {
    const client = new BoxliteRestSshClient();
    const descriptor = await client.prepareTunnel(restUrl, envApiKey, args.boxId, args.port, true);
    socket = await client.openTunnelStream(descriptor.uri, envApiKey);
  } else if (args.brokerPath) {
    socket = await connectViaBroker(args.brokerPath, args.boxId, args.port);
  } else {
    throw new Error('Set BOXLITE_API_KEY or pass --broker to connect to BoxLite SSH.');
  }

  await relayStdio(socket);
}

main().catch((err) => {
  process.stderr.write(`[boxlite-ssh-proxy] ${err?.message || err}\n`);
  process.exit(1);
});
