/**
 * A minimal local `node:https` fixture server (DESIGN.md §12.2: "a
 * self-signed local mock server") for the http/agent.ts TLS tests.
 * Listens on `127.0.0.1` on an OS-assigned port and always responds `200
 * ok` — the tests care about whether the TLS handshake succeeds at all,
 * not about response content.
 */
import https, { type ServerOptions } from 'node:https';

export interface TestHttpsServer {
  port: number;
  close(): Promise<void>;
}

export function startTestHttpsServer(tlsOptions: ServerOptions): Promise<TestHttpsServer> {
  return new Promise((resolve, reject) => {
    const server = https.createServer(tlsOptions, (_req, res) => {
      res.writeHead(200);
      res.end('ok');
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
        close: () => new Promise((res) => server.close(() => res())),
      });
    });
  });
}
