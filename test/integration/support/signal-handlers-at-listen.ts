import net from 'node:net';

// Preloaded into a spawned dist/index.js via --import. Records how many
// SIGTERM/SIGINT listeners exist at the instant the metrics server binds,
// turning a timing-dependent signal race into a deterministic observation.
// dist-smoke.test.ts matches this marker; keep the two in sync.
const MARKER = 'SIGNAL_HANDLERS_AT_LISTEN';

const originalListen = net.Server.prototype.listen;
net.Server.prototype.listen = function (this: net.Server, ...args: unknown[]) {
  const counts = {
    SIGTERM: process.listenerCount('SIGTERM'),
    SIGINT: process.listenerCount('SIGINT'),
  };
  process.stderr.write(`${MARKER} ${JSON.stringify(counts)}\n`);
  return (originalListen as (...a: unknown[]) => net.Server).apply(this, args);
} as typeof net.Server.prototype.listen;
