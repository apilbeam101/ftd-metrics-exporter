/**
 * A minimal local `node:http` fixture server for the http/client.ts tests
 * (DESIGN.md §12.2: "Node's `node:http` is sufficient to stand up a
 * fixture-serving stub"). `handler` gets full control per request so
 * tests can script arbitrary status-code sequences, delays, and headers.
 */
import http, { type IncomingMessage, type ServerResponse } from 'node:http';

export interface TestHttpServer {
  port: number;
  requests: Array<{ url: string; headers: http.IncomingHttpHeaders }>;
  close(): Promise<void>;
  /** Count of TCP sockets currently connected to this server — used to prove a client-side Agent/dispatcher actually tore down its keep-alive sockets rather than merely rejecting subsequent calls for an unrelated reason. */
  liveSocketCount(): number;
}

export function startTestHttpServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<TestHttpServer> {
  const requests: Array<{ url: string; headers: http.IncomingHttpHeaders }> = [];
  const sockets = new Set<import('node:net').Socket>();
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      requests.push({ url: req.url ?? '', headers: req.headers });
      handler(req, res);
    });
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('expected an AddressInfo from server.listen'));
        return;
      }
      resolve({
        port: address.port,
        requests,
        close: () => new Promise((res) => server.close(() => res())),
        liveSocketCount: () => sockets.size,
      });
    });
  });
}
