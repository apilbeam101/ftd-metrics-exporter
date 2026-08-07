/**
 * Per-backend `undici` Agent factory (DESIGN.md §2.7, §9.6). Each backend
 * gets its own Agent instance with its own `connect` options — this is
 * what makes TLS trust scoping real rather than aspirational: an FMC CA
 * bundle lives only in the FMC backend's Agent, never in a process-wide
 * store (`NODE_EXTRA_CA_CERTS` is exactly the thing this design avoids).
 * Never share one Agent instance across backends.
 */

import { Agent } from 'undici';

export interface AgentOptions {
  /** PEM-encoded CA bundle contents, or `undefined` to trust only the system store. */
  ca?: string;
  /** TLS 1.2 floor, per DESIGN.md §9.1 — never left to the runtime default. */
  minVersion: 'TLSv1.2' | 'TLSv1.3';
  /** DESIGN.md §9.6's explicitly-labeled escape hatch. Defaults to `false`. */
  rejectUnauthorized?: boolean;
  connectTimeoutMs?: number;
  /** Sized to the concurrency cap so the Agent's own pool never becomes the bottleneck (IMPLEMENTATION_PLAN.md Stage 6 risk note). */
  connections?: number;
}

export function createAgent(options: AgentOptions): Agent {
  return new Agent({
    connect: {
      ca: options.ca,
      minVersion: options.minVersion,
      rejectUnauthorized: options.rejectUnauthorized ?? true,
    },
    connectTimeout: options.connectTimeoutMs ?? 10_000,
    connections: options.connections ?? null,
  });
}
