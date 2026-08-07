# Cisco FTD Health Metrics Exporter — Design Document

**Status:** Draft for review
**Document type:** Design (architecture and decisions). Implementation details, final code, Dockerfiles, manifests, and the Grafana dashboard JSON are deliverables of a separate implementation pass.
**Date:** 2026-07-30
**Working project name:** `ftd-metrics-exporter` (npm package name: `ftd-metrics-exporter`; container image: `ghcr.io/apilbeam101/ftd-metrics-exporter`)

---

## Table of contents

1. [Overview, goals, non-goals](#1-overview-goals-non-goals)
2. [Architecture](#2-architecture)
3. [Backend adapters in detail](#3-backend-adapters-in-detail)
4. [Metric design](#4-metric-design)
5. [Deployment: standalone process](#5-deployment-standalone-process)
6. [Deployment: Docker](#6-deployment-docker)
7. [Deployment: Kubernetes](#7-deployment-kubernetes)
8. [Configuration reference](#8-configuration-reference)
9. [Security](#9-security)
10. [Grafana dashboard design](#10-grafana-dashboard-design)
11. [Observability of the exporter itself](#11-observability-of-the-exporter-itself)
12. [Testing strategy](#12-testing-strategy)
13. [Repository hygiene and release process](#13-repository-hygiene-and-release-process)
14. [Open questions, risks, implementation-phase unknowns](#14-open-questions-risks-implementation-phase-unknowns)
15. [Appendix A: SCC vs standalone FMC endpoint comparison](#appendix-a-scc-vs-standalone-fmc-endpoint-comparison)
16. [Appendix B: confirmed SCC response schema](#appendix-b-confirmed-scc-response-schema)

---

## 1. Overview, goals, non-goals

### 1.1 What this is

A standalone, long-running service that polls Cisco Firepower Threat Defense (FTD) device health metrics from a Cisco firewall management API, decomposes the JSON into labeled time series, and exposes them on an HTTP `/metrics` endpoint in Prometheus text exposition format.

It is a conventional Prometheus **exporter**, in exactly the same architectural role as `blackbox_exporter`, `snmp_exporter`, or `node_exporter`: it adapts a non-Prometheus-shaped data source into a scrapeable target. Nothing about it is push-based, and it has no coupling to any specific collector.

It supports **two mutually exclusive backend API types**, selected at startup:

| Backend | Product | Selected by |
|---|---|---|
| `scc` | Cisco Security Cloud Control (SCC) Firewall Manager API — cloud-delivered FMC (cdFMC), formerly branded "CDO" | `BACKEND_TYPE=scc` |
| `fmc` | Standalone on-premises Cisco Secure Firewall Management Center (FMC) REST API | `BACKEND_TYPE=fmc` |

These are genuinely different products with different authentication models, different URL structures, and — critically — **different endpoint capabilities**. See [§3](#3-backend-adapters-in-detail).

### 1.2 Why this exists

Operators running **Grafana Alloy + Prometheus** have no way to get FTD health data into that stack today. Alloy has no component for "poll an arbitrary REST API on an interval, decode JSON, emit labeled metrics" — there is no built-in primitive for it, and nothing in the Cisco ecosystem fills the gap either.

The correct architectural fix is to give that *poll + decode + label* responsibility its own dedicated exporter, which is the standard Prometheus answer to this class of problem. Once this exporter exists, Alloy needs nothing more than a `prometheus.scrape` block pointed at it.

Building it as a separate public open-source project rather than embedding it in a private repo is deliberate: **anyone** running SCC-managed or FMC-managed FTDs alongside Prometheus/Grafana has this same gap, and there is no existing exporter that fills it.

### 1.3 Goals

- **G1** — Expose FTD health metrics in Prometheus text exposition format on `/metrics`, scrapeable unmodified by both Prometheus and Grafana Alloy.
- **G2** — Support both SCC/cdFMC and standalone on-prem FMC backends behind one common internal interface, so a customer's choice of management plane is a configuration concern, not a different product.
- **G3** — Comprehensive metric coverage. CPU, memory, disk, and interface remain the priority baseline (they are the fundamental health signals operators expect from firewall monitoring on day one), but HA, VPN, and chassis health are in v1 scope because on the SCC backend they arrive in the *same response payload* at essentially zero additional cost.
- **G4** — Run identically as a bare process (Windows, macOS, Linux), as a Docker container, and as a Kubernetes Deployment, with each deployment path documented as a self-contained, independently followable path.
- **G5** — Zero credentials in the repository. Every secret comes from a gitignored `.env` file (or the platform-native secret mechanism), with a checked-in `example.env` documenting every variable and how to obtain its value.
- **G6** — Modern security posture by default: TLS everywhere, no plaintext secret storage, no secret logging, TLS 1.2+ only, and no blanket certificate-verification bypass as the recommended path.
- **G7** — Single-language toolchain: TypeScript on Node.js 24+, no Python, no native addons, no mixed-language build steps.
- **G8** — Respect documented upstream rate limits by design, not by hoping the operator configures a sane scrape interval.
- **G9** — Be observable itself, so that an exporter failure is visible as a metric rather than as silently stale data.

### 1.4 Non-goals

Stated explicitly so scope creep has something to bounce off:

- **Not a configuration tool.** The exporter issues **GET requests only**. It never creates, modifies, or deletes FTD/FMC objects, policies, or devices. This is both a scope decision and a security property (see [§9.5](#95-least-privilege-api-accounts)).
- **Not a log shipper.** It does not read, parse, forward, or transform syslog, connection events, IPS events, or audit logs. Loki/Alloy log pipelines remain the right tool for that and are entirely out of scope.
- **Not a replacement for FMC/SCC health alerting.** It surfaces the same underlying data to Prometheus so that operators can alert in one place; it does not attempt to reimplement Cisco's own health-policy alerting logic.
- **Not an event-stream exporter.** Discrete health *events* and *alerts* (FMC `/health/events`, `/health/alerts`) are considered for a limited status-gauge treatment in a later version, but the exporter is not an event-to-metric bridge with per-event cardinality.
- **Not a per-VPN-user telemetry system.** Individual RA VPN session detail is explicitly excluded on label-cardinality grounds. See [§4.7](#47-explicitly-excluded-from-scope).
- **Not a push-based metrics writer.** No push output of any kind. Pull-only.
- **Does not bundle Grafana Alloy, Prometheus, or Grafana.** The companion dashboard is a JSON artifact, not a deployment.

---

## 2. Architecture

### 2.1 Component overview

```
                        ┌──────────────────────────────────────────────────────────┐
                        │                ftd-metrics-exporter                      │
                        │                                                          │
  .env / env vars ─────►│  ┌────────────┐                                          │
                        │  │   Config   │  load → validate → freeze                 │
                        │  │   Loader   │  (fails fast at startup)                  │
                        │  └─────┬──────┘                                           │
                        │        │                                                  │
                        │        ▼                                                  │
                        │  ┌───────────────────────────────────────────┐            │
                        │  │              Poller                       │            │
                        │  │  setTimeout loop @ POLL_INTERVAL_SECONDS  │            │
                        │  │  + jitter, + backoff on failure           │            │
                        │  └─────┬─────────────────────────────┬───────┘            │
                        │        │                             │                    │
                        │        ▼                             ▼                    │
                        │  ┌──────────────────┐        ┌───────────────────┐        │
                        │  │  HealthBackend   │◄───────│  Self-Metrics     │        │
                        │  │   (interface)    │        │  Recorder         │        │
                        │  └────┬────────┬────┘        └───────────────────┘        │
                        │       │        │                                          │
                        │  ┌────▼────┐ ┌─▼──────────────────────┐                   │
                        │  │   SCC   │ │   Standalone FMC       │                   │
                        │  │ Adapter │ │   Adapter              │                   │
                        │  │         │ │  ┌──────────────────┐  │                   │
                        │  │         │ │  │ FmcTokenManager  │  │                   │
                        │  │         │ │  ├──────────────────┤  │                   │
                        │  │         │ │  │ DeviceDiscovery  │  │                   │
                        │  │         │ │  └──────────────────┘  │                   │
                        │  └────┬────┘ └─┬──────────────────────┘                   │
                        │       │        │                                          │
                        │       ▼        ▼                                          │
                        │  ┌──────────────────────────┐                             │
                        │  │  HttpClient (TLS policy, │                             │
                        │  │  timeouts, retry,        │                             │
                        │  │  concurrency limiter)    │                             │
                        │  └──────────┬───────────────┘                             │
                        │             │                                             │
                        │             ▼  normalized DeviceHealthSnapshot[]          │
                        │  ┌──────────────────────────┐                             │
                        │  │   MetricsCache           │  in-memory only,            │
                        │  │   (last good snapshot    │  never written to disk      │
                        │  │    + fetchedAt)          │                             │
                        │  └──────────┬───────────────┘                             │
                        │             │ read on scrape                              │
                        │             ▼                                             │
                        │  ┌──────────────────────────┐                             │
                        │  │  MetricsRenderer         │  prom-client Registry       │
                        │  │  (custom collector)      │  + custom collect()         │
                        │  └──────────┬───────────────┘                             │
                        │             │                                             │
                        │  ┌──────────▼───────────────┐                             │
                        │  │  HTTP Server             │  GET /metrics               │
                        │  │  (node:http / node:https)│  GET /healthz  GET /readyz  │
                        │  └──────────────────────────┘                             │
                        │                                                          │
                        │  ┌──────────────────────────┐                             │
                        │  │  Logger (JSON, redacting)│                             │
                        │  └──────────────────────────┘                             │
                        └───────┬──────────────────────────────────────────────────┘
                                │ scrape (HTTP or HTTPS)
                                ▼
              ┌─────────────────────────────────┐
              │  Grafana Alloy (prometheus.scrape)│  ── remote_write ──►  Prometheus
              │        or Prometheus directly     │
              └─────────────────────────────────┘
                                                                    │
                                                                    ▼
                                                             Grafana dashboard
```

Upstream, the adapters talk to either:

```
  SCC Adapter  ──HTTPS──►  https://api.<region>.security.cisco.com/firewall/v1/...
  FMC Adapter  ──HTTPS──►  https://<fmc-host>/api/fmc_platform/v1/...
                           https://<fmc-host>/api/fmc_config/v1/domain/{domainUUID}/...
```

### 2.2 The poll-cache-serve pattern (central design decision)

**Decision: the exporter never calls the upstream API in the request path of a `/metrics` scrape.**

An internal poller runs on its own timer, fetches a complete snapshot, normalizes it, and atomically replaces an in-memory cache. Every `GET /metrics` renders from that cache.

This is the single most important architectural choice in the document, and it is driven by a hard constraint: **the SCC health-metrics endpoint has a documented limit of 2 requests per minute.** A naive "fetch on scrape" exporter would be rate-limited into uselessness by any Prometheus deployment with a normal scrape interval, and would break outright if two Prometheus replicas or an Alloy instance and a human `curl` scraped concurrently.

Consequences and benefits:

- **Prometheus `scrape_interval` is fully decoupled from upstream rate limits.** An operator can scrape every 15s while the exporter polls every 60s. Prometheus will see a step function (repeated identical values between polls), which is normal and expected for exporters fronting slow data sources, and correct given the upstream data is itself a windowed average.
- **Scrape latency is bounded and tiny** — no upstream network call, no risk of a scrape timing out because Cisco's API was slow.
- **N scrapers cost 1 upstream request.** Multiple Prometheus replicas, an Alloy agent, and ad-hoc debugging all share one poll cycle.
- **Failure isolation.** An upstream failure does not fail the scrape; it serves the last-good snapshot and increments an error counter, so the operator sees `ftd_exporter_poll_errors_total` rising and `ftd_exporter_cache_age_seconds` growing rather than a hole in the data.

**Staleness policy.** Serving arbitrarily old data silently is worse than serving nothing. The design therefore:

1. Always exposes `ftd_exporter_cache_age_seconds` and `ftd_exporter_last_successful_poll_timestamp_seconds` so staleness is *measurable* and alertable.
2. Continues serving the last-good snapshot indefinitely rather than emptying the cache — a 90-second-old CPU average is still useful; a gap is not. (Rationale: gaps break `rate()`/`avg_over_time()` continuity and look identical to "device removed", which is a genuinely different condition.)
3. Sets `ftd_exporter_up 0` when the most recent poll attempt failed, giving alerting rules a clean binary signal that does not require the operator to reason about timestamps.

**Rejected alternative — fetch on scrape with an internal token bucket.** Simpler to describe, but it couples correctness to scraper behavior, makes scrape latency depend on Cisco's API, and produces confusing partial results when the bucket is empty. Rejected.

### 2.3 Backend adapter abstraction

Both backends normalize into one internal shape. The interface is deliberately narrow:

```ts
interface HealthBackend {
  readonly kind: 'scc' | 'fmc';
  init(): Promise<void>;                          // auth bootstrap, domain resolution
  fetchSnapshot(): Promise<DeviceHealthSnapshot[]>;
  close(): Promise<void>;
}
```

`DeviceHealthSnapshot` is the exporter's own domain model, **not** a pass-through of either vendor payload. Every conditional group is optional at the type level, because the live API sample confirms these keys are *absent*, not null:

```ts
interface DeviceHealthSnapshot {
  deviceUid: string;
  deviceName: string;
  windowStart?: Date;
  windowEnd?: Date;
  cpu?: { lina?: number; snort?: number; system?: number };
  memory?: { lina?: number; snort?: number; system?: number };
  disk?: { totalUsagePercent?: number };
  chassis?: ChassisStats;          // absent on non-chassis hardware
  interfaces?: InterfaceStats[];
  ha?: HaStats;                    // absent unless device is in an HA pair
  raVpn?: RaVpnStats;              // absent unless RA VPN configured
  s2sTunnels?: S2sTunnelStats[];   // absent unless S2S VPN configured
}
```

The renderer consumes only this type and knows nothing about SCC or FMC. This is what makes the two backends genuinely pluggable rather than "same request with a different header", which matters because — as [§3](#3-backend-adapters-in-detail) details — the standalone FMC backend needs *many* requests, in a *specific sequence*, to produce one snapshot that SCC produces in a single call.

**Exactly one backend is active per process instance.** A customer with both an SCC tenant and an on-prem FMC runs two instances of the exporter with different configurations, scraped as two Prometheus jobs. Rationale: it keeps configuration validation unambiguous, keeps the rate-limit accounting per-instance and per-backend (the two backends have completely different limits), avoids inventing a multi-tenant config file format, and matches how every mainstream exporter handles multiple targets. Multi-target support in a single process is noted as a possible future enhancement in [§14](#14-open-questions-risks-implementation-phase-unknowns), not v1.

### 2.4 Configuration loading

- All configuration is via **environment variables**. No config file format is invented.
- For local/standalone runs, variables come from a **gitignored `.env`** file, loaded at startup. Node 24 has native support for this (`process.loadEnvFile()` / the `--env-file` CLI flag), so **no `dotenv` dependency is required**.
- Environment variables already present in the process environment always win over `.env` file contents. This is what makes the Docker (`--env-file`, `-e`) and Kubernetes (`Secret` → `envFrom`) paths work without a `.env` file existing at all.
- Configuration is **validated and frozen at startup, and the process exits non-zero on any validation failure.** Fail-fast, not fail-at-first-poll. Validation covers: required-variable presence conditional on `BACKEND_TYPE`, URL well-formedness, numeric ranges, mutual exclusivity, and file readability for any path-valued variable (CA bundle, TLS cert/key).
- Startup logs an **effective configuration summary with every secret redacted** (see [§9.4](#94-credential-handling-and-redaction)) — invaluable for support, and safe.
- No runtime configuration reload. Changing configuration means restarting the process. Rationale: it eliminates a class of partially-applied-config bugs, and every deployment target (systemd, Docker, Kubernetes) already has a first-class restart mechanism.

### 2.5 Error handling, retry, and backoff

Errors are classified, because the right response differs sharply:

| Class | Examples | Response |
|---|---|---|
| **Fatal config** | Missing required env var, unparseable URL, unreadable CA bundle | Exit non-zero at startup |
| **Auth — recoverable** | FMC token expired / refresh ceiling reached | Re-authenticate, retry once immediately |
| **Auth — likely fatal** | SCC `401`/`403` with a valid-looking token | Log a loud, actionable error; keep running; do **not** hot-loop. Backoff applies. `ftd_exporter_up 0` |
| **Rate limited** | HTTP `429`, or SCC 2/min limit tripped | Respect `Retry-After` when present; otherwise backoff. Never retry-storm |
| **Transient network/5xx** | `ECONNRESET`, `ETIMEDOUT`, `502`, `503`, `500` | Bounded retry with exponential backoff + full jitter |
| **Schema/parse** | Unexpected type, missing required field | Skip *that device or group only*, keep the rest of the snapshot, increment a parse-error counter |

Specifics:

- **Retry policy:** max 3 attempts per upstream request, exponential backoff with full jitter (base 500 ms, cap 8 s), retrying only on transient classes and `429`. Idempotent GETs only, so retries are always safe.
- **Poll-level backoff:** if an entire poll cycle fails, the *next* poll is delayed by an escalating factor (2×, 4× … capped at 10 minutes) rather than firing on schedule into a known-broken upstream. Recovery resets the factor immediately.
- **Partial success is a success.** On the FMC backend a snapshot is assembled from many requests. If 48 of 50 devices return data, the exporter publishes the 48 and records the 2 failures. Discarding a whole cycle over one bad device would be a self-inflicted outage.
- **Startup jitter:** a small random delay (0–10% of the poll interval) before the first poll, so a fleet of restarted replicas does not synchronize into a thundering herd against one FMC.
- **Timeouts:** every upstream request gets an explicit total-time budget (default 30 s, configurable) via `AbortSignal`. No unbounded waits.

### 2.6 Logging

- **Structured JSON to stdout**, one object per line. No log files, no rotation logic — stdout is what systemd, Docker, and Kubernetes all capture natively.
- Levels: `error`, `warn`, `info`, `debug`, controlled by `LOG_LEVEL` (default `info`).
- **A redacting serializer is mandatory and applied at the logger boundary**, not at each call site. Relying on developers to remember not to log a token is a design flaw, not a coding standard. See [§9.4](#94-credential-handling-and-redaction).
- Every log line carries `backend` and, where applicable, `device_uid` for correlation.
- At `info`, one line per poll cycle summarizing devices, duration, and outcome. At `debug`, per-request URLs (with query strings sanitized) and response sizes — but **never response bodies by default**, since bodies may include device names and topology detail some operators consider sensitive.
- **Library recommendation:** `pino` if a logging dependency is acceptable (fast, JSON-native, first-class redaction via its `redact` option). A ~60-line hand-rolled JSON logger is a legitimate zero-dependency alternative given the exporter's needs are trivial. **Recommendation: hand-rolled**, to hold the dependency count at two (see [§2.7](#27-technology-choices)); `pino`'s redaction path-matching is genuinely nice but not worth a dependency tree for six log statements.

### 2.7 Technology choices

Dependency footprint is a **security and adoption property** for software shipped to third parties, not a matter of taste. Every dependency is a supply-chain entry and something a customer's security team must review. The bar here is deliberately high.

| Concern | Candidates | Decision | Rationale |
|---|---|---|---|
| Language / runtime | TypeScript on Node.js | **TypeScript, Node.js ≥ 24** (`engines.node: ">=24"`) | Org policy: single-language toolchain, no Python. Node 24 gives native `.env` loading, stable `fetch`, `node:test`, and native TS type-stripping |
| Prometheus client | `prom-client`, hand-rolled formatter | **`prom-client`** | De facto standard, actively maintained, correct exposition-format edge cases (escaping, `NaN`/`Inf`, `HELP`/`TYPE` ordering), supports custom collectors. Hand-rolling exposition format is a classic subtle-bug generator |
| HTTP server | `express`, `fastify`, `hono`, `node:http` | **`node:http` (and `node:https`)** | Two or three routes with no middleware, no body parsing, no routing complexity. A framework would be the largest dependency in the project for zero benefit. Also makes the native-TLS listener a two-line change (`https.createServer(tlsOpts, handler)`) |
| Upstream HTTP client | global `fetch`, `node:https`, `undici`, `axios`, `got` | **`undici`** (explicit dependency) | Discussed below |
| Env config loading | `dotenv`, `dotenv-flow`, native | **Native** (`process.loadEnvFile()` / `--env-file`) | Built into Node 24. A dependency for this is unjustifiable |
| Config validation | `zod`, `envalid`, hand-rolled | **Hand-rolled** (~100 lines, typed) | Needs are ~20 variables with simple rules. `zod` is excellent and is the fallback if validation grows, but it is a large surface for this. Noted as an acceptable deviation if the implementer disagrees |
| Test runner | `node:test`, `vitest`, `jest` | **`node:test`** + `node:assert` | Zero dependencies, ships with Node, adequate for unit + mock-server integration tests. `vitest` only if snapshot ergonomics prove painful |
| Build | `tsc`, `esbuild`, `tsup` | **`tsc`** | Plain library-style build to `dist/`. No bundling needed for a server process. Keeps `devDependencies` to TypeScript and types |
| Lint / format | `eslint` + `prettier`, `biome` | **`biome`** (single devDependency) or `eslint`+`prettier` | Implementation-phase preference; either is fine. `biome` is one dependency instead of a dozen plugins |

**On the upstream HTTP client — the one non-obvious call.** Node's global `fetch` is convenient and dependency-free, but it provides **no supported way to set per-request TLS trust options** (custom CA bundle, `minVersion`, `rejectUnauthorized`). The only zero-dependency lever is `NODE_EXTRA_CA_CERTS`, which is process-wide, must be set before the process starts, and cannot be scoped to one upstream host. For a project whose primary on-prem TLS story is "load an operator-supplied CA bundle for a self-signed FMC certificate" (see [§9.6](#96-certificate-trust-for-on-prem-fmc)), that is disqualifying.

`undici` — which *is* the implementation behind Node's global `fetch`, so this is not adding a new HTTP stack — exposes an `Agent`/`Dispatcher` with a `connect` option accepting exactly the TLS settings needed:

```ts
const dispatcher = new Agent({
  connect: { ca: caBundle, minVersion: 'TLSv1.2', rejectUnauthorized: !insecureSkipVerify },
  connectTimeout: 10_000,
});
```

This also gives clean per-backend connection pooling and a natural place to cap concurrency for the FMC backend's 10-connection limit. **Decision: `undici` as an explicit dependency.** A `node:https`-based wrapper is the acceptable zero-dependency fallback if the implementation phase prefers it; it costs a small promise-wrapping layer and loses nothing functionally.

**Resulting runtime dependency count: two (`prom-client`, `undici`).** That is a genuine selling point for a tool that third parties must security-review before deploying.

**Hard rule: no native addons, no `node-gyp`, no optional platform-specific dependencies, anywhere in the tree.** This is what makes goal G4's "same artifact on Windows, macOS, Linux" true rather than aspirational, and it must be enforced in review (and ideally by a CI check that the install produces no build steps).

---

## 3. Backend adapters in detail

### 3.1 The critical asymmetry

This deserves stating plainly because it shapes the whole design:

> **SCC/cdFMC provides a single convenient endpoint that returns all health metrics for all managed devices in one call. Standalone on-prem FMC does not have that endpoint at all.**

On SCC, one `GET` returns a JSON array with one fully-populated object per device. On standalone FMC, the nearest equivalent (`/health/aggregatemetrics`) accepts **one device and one metric family per request**, requires a filter-string syntax, and must be preceded by device discovery. For a 50-device FMC with five metric families, one logical "snapshot" may require on the order of 250 upstream requests, versus SCC's one.

Additionally the auth models are opposites: SCC uses a static non-expiring bearer token (fire-and-forget); FMC uses a stateful 30-minute token with a hard 3-refresh ceiling that must be actively managed.

This is why the adapters are separate components implementing a shared interface, rather than one parameterized client. Anything less would leak FMC's sequencing and token lifecycle into SCC's trivial path, or force FMC's complexity through an abstraction shaped by SCC's simplicity.

### 3.2 SCC (Security Cloud Control / cdFMC) adapter

#### 3.2.1 Base URL and regions

The base URL is **fully operator-configurable via `SCC_BASE_URL`, and no region is ever hardcoded or defaulted.** Regional hosts:

| Region | Base URL |
|---|---|
| US | `https://api.us.security.cisco.com/firewall` |
| EU | `https://api.eu.security.cisco.com/firewall` |
| APJ | `https://api.apj.security.cisco.com/firewall` |
| Australia | `https://api.au.security.cisco.com/firewall` |
| India | `https://api.in.security.cisco.com/firewall` |
| UAE | `https://api.uae.security.cisco.com/firewall` |
| FedRAMP | `https://manage.secure.cisco/api/rest` (excludes MSP APIs) |

**Legacy vs current hostnames.** Older `edge.<region>.cdo.cisco.com` hosts still function but are being migrated to the `api.<region>.security.cisco.com` form above. An operator whose environment still points at the old form will find it continues to work — the docs (README and `example.env`) must say so explicitly *and* recommend updating, so that a working-but-deprecated URL does not become a mystery outage later. The `example.env` will list the full regional table with the legacy form noted as deprecated.

Because the legacy and current hosts also differ in path prefix (`/api/rest/v1/...` vs `/firewall/v1/...`), the adapter treats `SCC_BASE_URL` as an opaque prefix and appends only the endpoint-relative portion, letting a legacy base URL work unchanged. The path suffix appended is `/v1/inventory/managers/{fmcUid}/health/metrics`.

#### 3.2.2 Authentication

- **Static, non-expiring bearer token**, sent as `Authorization: Bearer <token>`.
- No refresh, no expiry tracking, no token endpoint. The adapter reads `SCC_API_TOKEN` once at startup and uses it verbatim.
- **How the operator obtains it** (this text belongs verbatim in `example.env` and the README): SCC UI → **Settings → User Management → "+"** → give the user a name → check **"API Only User"** → select a role → **OK** → **Generate API Token**. The token is displayed **exactly once** and must be copied immediately.
- **Least privilege: a Read-only API-only user is sufficient and is the recommendation.** The exporter issues only GETs. An Edit-capable token also works but grants unnecessary authority, and this document recommends against it.
- **Rotation:** because these tokens never expire, nothing forces hygiene. The design recommends an operational practice of **periodic manual rotation** (e.g. every 90 days, aligned to the operator's own credential policy) and documents it as a best practice — clearly labeled as a recommendation, not an API requirement, so operators are not left hunting for a rotation endpoint that does not exist.

#### 3.2.3 The health metrics endpoint

```
GET {SCC_BASE_URL}/v1/inventory/managers/{SCC_FMC_UID}/health/metrics?timeRange={5m|15m|30m|1h}
Authorization: Bearer <token>
```

- `timeRange` is operator-configurable via `SCC_TIME_RANGE`, validated against the exact set `5m|15m|30m|1h`, default `5m`. **This is a known configuration-bug class to guard against** — validating a variable and then hardcoding a default anyway. The implementation must include a unit test asserting the configured value actually reaches the request query string. Calling this out here so the test is not forgotten.
- Response: JSON array, one object per FTD device managed by that FMC UID. Full schema in [Appendix B](#appendix-b-confirmed-scc-response-schema).
- Error responses observed/documented: `400`, `401`, `403`, `405`, `500`. Handled per [§2.5](#25-error-handling-retry-and-backoff).
- API spec versions at time of research: `1.20.0` (SCC firewall-manager), `1.17.0` (cdFMC sub-API).

#### 3.2.4 Rate limiting — the binding constraint

**Documented hard limit: 2 requests per minute for this specific endpoint.**

Design response:

1. **Minimum enforced spacing of 30 seconds** between requests per FMC UID, implemented in the adapter itself as a monotonic-clock guard — not merely documented as advice. If the poller somehow asks sooner, the adapter waits or declines.
2. **`POLL_INTERVAL_SECONDS` defaults to `60`** and is **validated with a hard floor of `30`** on this backend; a configured value below the floor is a startup error, not a silent clamp (silent clamping hides operator mistakes).
3. Since exactly one request per poll cycle is needed for the entire fleet, a 60 s interval consumes 1 of the 2 permitted requests per minute — comfortable headroom for a retry.
4. **Retries count against the limit.** The retry policy's jittered backoff is explicitly bounded so that a poll cycle plus its retries cannot exceed 2 requests in any 60-second window.
5. `429` responses honor `Retry-After` and increment `ftd_exporter_poll_errors_total{reason="rate_limited"}` so operators can see it.

**This is precisely why the poll-cache-serve pattern is non-negotiable on this backend.** With fetch-on-scrape, a single Prometheus at a 15 s interval would issue 4 requests/minute — double the limit — and fail continuously.

#### 3.2.5 Health-policy prerequisite

Metrics availability is **gated by per-device health-policy configuration**: for a specific health metric to be available for a device, that device's health policy must be configured to collect it.

This is an operational prerequisite, not an exporter bug, and it is the **single most likely support question** ("why is metric X missing?"). It must appear:

- in the README's **Troubleshooting** section, as the first thing to check when a metric group is absent;
- in the metric-scope table in [§4](#4-metric-design), noted against conditional groups;
- as a documented pointer to check the device's health policy in SCC/FMC, **not** the exporter configuration.

#### 3.2.6 Response mapping

A pure function: `SccHealthMetricsResponse → DeviceHealthSnapshot[]`. No I/O, no logging, fully unit-testable against captured fixture JSON (see [§12](#12-testing-strategy)).

Mapping rules that matter:

- **Every one of the five conditional groups** (`chassisStatsHealthMetrics`, `haHealthMetrics`, `raVpnSessionHealthMetrics`, `s2sVpnTunnelHealthMetrics`, and per-interface `interfaceName`) is **optional at the type level**. The live sample confirms absent *keys*, not null values — so `undefined` checks, not truthiness checks, and no default-to-zero anywhere.
- **`interfaceName` falls back to `interface`.** The human label (`"outside"`) is confirmed frequently absent for unnamed/unused interfaces; the hardware id (`"Ethernet1/1"`) is always present. See [§4.3](#43-label-strategy).
- **No interface filtering.** All interfaces are exported, including down, unused, all-zero ones. A down interface with zero traffic is meaningful signal, and filtering it would make "interface disappeared" indistinguishable from "interface idle".
- **String enums are mapped to numeric gauges** at render time, not at parse time; the snapshot keeps the original string so the renderer can decide representation. See [§4.4](#44-representing-status-enums).
- `startTime`/`endTime` parsed as ISO 8601 into `Date`, surfaced per [§4.5](#45-sample-window-timestamps). Unparseable values are dropped with a warning, not fatal.

### 3.3 Standalone on-prem FMC adapter

#### 3.3.1 URL structure and API families

```
https://<FMC_HOST>/api/fmc_platform/v1/...                      auth, system info, licensing
https://<FMC_HOST>/api/fmc_config/v1/domain/{domainUUID}/...    devices, health, chassis, VPN, HA
https://<FMC_HOST>/api/fmc_troubleshoot/v1/domain/{domainUUID}/...   diagnostics — NOT used by this exporter
```

**Domain UUID** is a real structural concept in FMC with **no equivalent in SCC's single-tenant-per-token model**. FMC has a Global domain plus optional sub-domains, each with its own UUID, and it appears in the path of every `fmc_config` request. The adapter resolves it as follows:

1. If `FMC_DOMAIN_UUID` is explicitly configured, use it (allows scoping the exporter to one sub-domain).
2. Otherwise, extract it from the **claims inside the access token** returned by `generatetoken`.
3. `GET /api/fmc_platform/v1/info/domain` is available as an enumeration/fallback path and is the right source for a future multi-domain mode.

**Footgun to document: device UUID `0` is a magic value** meaning "the FMC appliance itself" in some health filters, as distinct from a managed device. This must be called out in the README and in code comments, because silently querying device `0` and getting FMC-appliance health where the operator expected device health is a confusing failure mode. v1 does not query device `0`; FMC-appliance-level health is backlog ([§4.6](#46-scope-table)).

#### 3.3.2 Authentication and the `FmcTokenManager`

FMC's auth is stateful and must be actively managed. It gets its **own named component: `FmcTokenManager`.**

The protocol:

- **`POST /api/fmc_platform/v1/auth/generatetoken`**
  - Credentials sent via **HTTP Basic Auth header** — *not* a JSON body.
  - The response has **no body**. Tokens are returned as **response headers**: `X-auth-access-token` and `X-auth-refresh-token`.
  - The domain UUID is embedded as a claim inside the access-token payload.
- **Subsequent requests:** header `X-auth-access-token: <token>`.
- **`POST /api/fmc_platform/v1/auth/refreshtoken`**
  - Requires **both** `X-auth-access-token` and `X-auth-refresh-token` headers.
  - Returns a new header pair.
- **Token lifetime: 30 minutes.**
- **Refreshable a maximum of 3 times**, after which a full re-authentication via `generatetoken` is mandatory.

`FmcTokenManager` responsibilities:

| Responsibility | Behavior |
|---|---|
| Track access-token expiry | Refresh **proactively** at ~80% of lifetime (≈24 min), never lazily on a 401 |
| Track refresh count | Increment per refresh; at **3**, discard both tokens and perform full `generatetoken` |
| Serialize acquisition | A single in-flight promise shared by all callers, so N concurrent device requests never trigger N logins |
| Handle mid-flight expiry | On an unexpected `401`, force re-auth and retry the failed request **once** |
| Expose state as metrics | `ftd_exporter_fmc_token_refreshes_total`, `ftd_exporter_fmc_token_reauths_total`, `ftd_exporter_fmc_token_expiry_timestamp_seconds` |
| Never log token material | Tokens are held in memory only; the redacting logger covers both header names ([§9.4](#94-credential-handling-and-redaction)) |

**Cisco's explicit warning, which must be surfaced to operators:** a single FMC user account **cannot be used simultaneously via the UI and the API** — doing so silently logs the other session out. The practical consequence is that if an operator reuses their own admin account for the exporter, the exporter will keep logging *them* out of the FMC web UI, and vice versa, intermittently and confusingly.

**Therefore: a dedicated API-only service account is required, not merely suggested.** This must appear (a) in `example.env` next to `FMC_USERNAME`, (b) in the README setup steps for the FMC backend, and (c) in the troubleshooting section as the explanation for "my FMC UI keeps logging me out" and "the exporter intermittently gets 401s".

#### 3.3.3 Device discovery

Unlike SCC, the FMC backend must know *which devices exist* before it can request health for them.

- Source: `GET /api/fmc_config/v1/domain/{domainUUID}/devices/devicerecords`, with `expanded=true` to get full objects rather than references.
- **Pagination is the client's job.** `offset`/`limit` query parameters, default page size **25**, maximum **1000**. There are **no paging headers** — the client must track offset itself and continue until a short page is returned. A 25-device default page size means a naive single-request implementation silently truncates at 25 devices; the implementation must page explicitly. Recommended `limit=1000` with an offset loop and a sanity cap on total pages.
- **Discovery runs on its own, slower cadence** (`FMC_DISCOVERY_INTERVAL_SECONDS`, default `900` = 15 min), independent of the metric poll interval. Device inventory changes on a timescale of days; re-enumerating it every 60 s wastes a meaningful slice of the request budget for nothing.
- Discovery results are cached; a discovery failure does not fail the metric poll — the previous device list is reused, and `ftd_exporter_discovery_errors_total` increments.
- `ftd_exporter_devices_discovered` is exported so operators can see the count the exporter believes in, which is the fastest way to spot a pagination truncation bug in the field.

#### 3.3.4 Health metric retrieval

**Primary endpoint:**

```
GET /api/fmc_config/v1/domain/{domainUUID}/health/aggregatemetrics
    ?filter=device_uuid:<uuid>;metric:<CPU|MEM|INTERFACE|DISK_STATS|CHASSIS_STATS>;timeRange:<5m|15m|30m|1h>
```

- `timeRange` uses the **same vocabulary as SCC** (`5m/15m/30m/1h`) — reassuring for a shared configuration variable.
- **One device per request.** There is no multi-device batch equivalent to SCC's per-FMC-UID call. For N devices and M metric families this is N×M requests per cycle.
- The filter is a **semicolon-delimited `key:value` string**, not standard query parameters. Values must be encoded carefully; this is a likely source of implementation bugs and deserves dedicated unit tests on the filter-builder function.

**Request volume, concurrency, and rate limits.** FMC's documented limits are **general and API-wide**, unlike SCC's per-endpoint limit:

| Limit | Value | Relevance |
|---|---|---|
| GET requests per minute per source IP | **300** | The binding budget for this backend |
| Concurrent connections per source IP | **10** | Must be respected by the client's connection pool |
| Concurrent non-GET requests per device | 1 | Not applicable — exporter never writes |
| Max request body | 2,048,000 bytes | Not applicable — GET only |

Design response:

- **`FMC_MAX_CONCURRENT_REQUESTS` defaults to `5`**, hard-capped at `10` by validation, and enforced by an explicit concurrency limiter feeding the `undici` Agent pool. Default 5 rather than 10 leaves headroom for the operator's other API consumers, which the exporter cannot see but must not starve.
- **A request-budget guard** tracks GETs issued in a rolling 60-second window and throttles to stay under 300, logging a warning if the configured fleet size and poll interval make the budget unachievable. Better to tell the operator at startup that 400 devices at 60 s cannot work than to discover it via 429s.
- **`POLL_INTERVAL_SECONDS` default remains `60`, but the floor is different from SCC's.** There is no 30 s per-endpoint restriction here; the constraint is aggregate throughput. The README documents this as **explicitly different tuning from the SCC backend** — same variable, different guidance, which is exactly the kind of thing that must be stated rather than left to inference.
- Worked example for sizing docs: 50 devices × 5 metric families = 250 requests per cycle. At a 60 s poll interval that is 250 requests/minute — **uncomfortably close to the 300/minute ceiling**. This is a real finding, and the guidance follows from it: for fleets above roughly 40 devices, either raise `POLL_INTERVAL_SECONDS` (e.g. 120 s) or reduce the enabled metric families via `FMC_METRIC_FAMILIES`. The exporter should compute this estimate at startup and warn when the projection exceeds ~70% of the budget.
- **`FMC_METRIC_FAMILIES`** (default `CPU,MEM,INTERFACE,DISK_STATS,CHASSIS_STATS`) lets operators trade coverage for request budget — and lets them drop `CHASSIS_STATS` entirely on all-appliance fleets where it returns nothing useful.

**Secondary/alternative endpoints, and why they are not v1 primary:**

- `GET /api/fmc_config/v1/domain/{domainUUID}/health/metrics` — the lower-level, explicitly **Prometheus-metric-named** endpoint (`cpu`, `mem`, `interface`, `asp_drops`, `disk_stats`, `critical_process`). Requires mandatory `startTime`/`endTime` (unix seconds) **and** `step` (seconds), returning a time series rather than a current value. Cisco's own guide does not fully enumerate the metric catalog (it says to "contact HM team"). This is more powerful and higher-resolution, but it forces the exporter to invent and manage a time-window cursor, which fits a pull-based "current value" exporter poorly. **Deferred to v1.1+ as an opt-in high-resolution mode**, not the v1 default.
- `GET /health/alerts` and `GET /health/events` — discrete alert/event streams with status values (green/yellow/red, or NORMAL/CRITICAL/WARNING), filterable by device/module/time. Good candidate for a per-module status gauge or an event-count metric. **Backlog** ([§4.6](#46-scope-table)) — needs a cardinality assessment first.
- `GET /health/metricconfiguration` — new in FMC 10.0 and **undocumented in Cisco's own guide**, which literally renders as `[DEV ERROR: Missing description]`. **Flagged as unknown; explicitly not designed around in v1.** See [§14](#14-open-questions-risks-implementation-phase-unknowns).
- `GET /health/ravpngateways`, `GET /health/tunnelstatuses`, `GET /health/tunnelsummaries` — the on-prem parallels to SCC's `raVpnSessionHealthMetrics` / `s2sVpnTunnelHealthMetrics`.
- `GET /devicehapairs/ftddevicehapairs` (supports a `liveStatus` query parameter for live cluster node status) — the parallel to SCC's `haHealthMetrics`.
- Chassis family under `/chassis/fmcmanagedchassis/{containerUUID}/...` (`faultsummary`, `interfacesummary`, `inventorysummary`) — parallel to SCC's `chassisStatsHealthMetrics`, with unclear overlap. See [§14](#14-open-questions-risks-implementation-phase-unknowns).
- `GET /devices/devicerecords/{containerUUID}/fpinterfacestatistics` — a **second, non-health path to interface statistics**. There appear to be two sources of interface data on standalone FMC (health family vs device-record family) and it is not established which is authoritative or richer. See [§14](#14-open-questions-risks-implementation-phase-unknowns).

#### 3.3.5 Known unknown: response body field names

**There are no example response bodies for the FMC health endpoints anywhere in Cisco's official guide (v10.0, published November 2025).** Endpoint paths, filter syntax, and parameter vocabularies are documented; response payload structures are not.

Consequences accepted deliberately:

- **This document does not invent FMC response field names.** Where SCC's schema is stated concretely ([Appendix B](#appendix-b-confirmed-scc-response-schema)) it is because it was verified against a live API call. For FMC, `CPU`/`MEM`/`DISK_STATS`/`INTERFACE` are now equally verified ([Appendix C](#appendix-c-confirmed-fmc-response-schema-partial)); fabricating plausible-looking field names for the remaining unverified groups would still be worse than admitting the gap.
- **`INTERFACE` on FMC is verified, and diverges from SCC's naming in ways that would have broken a naive port.** The wrapper key is `interfaceHealthMetricsList`, not SCC's `interfaceHealthMetrics`; the status fields are `currentLinkStatus`/`currentOperationalStatus`, not SCC's `linkStatus`/`operationalStatus`. See [Appendix C](#appendix-c-confirmed-fmc-response-schema-partial) for the full field-by-field comparison.
- **The `chassisStatsHealthMetrics`, `haHealthMetrics`, `raVpnSessionHealthMetrics`, and `s2sVpnTunnelHealthMetrics` groups remain experimental on *both* backends, not an FMC-specific gap.** Their field names come from Cisco's documentation only — confirmed absent (correctly, as keys) on live hardware on both SCC and FMC, but never observed populated with real chassis/HA/VPN data on either backend. Semantic versioning implications in [§13](#13-repository-hygiene-and-release-process).
- **Mitigation: a capture mode.** A documented one-shot debug mode (e.g. `--dump-raw`, writing raw upstream JSON to stdout) lets a customer or maintainer capture real FMC responses safely and contribute them as test fixtures without sharing credentials. This turns the unknown into a community-solvable problem and is a genuinely valuable OSS affordance. Raw dumps must pass through the same redaction path and the docs must warn that dumps may contain device names and topology detail.

#### 3.3.6 TLS and certificate trust

FMC ships with a **self-signed certificate by default**, and Cisco's guide simply instructs users to manually accept/trust it in a browser. There is **no documented mechanism on FMC's side for providing a proper CA bundle** — it is entirely a client-side trust problem.

Handled in [§9.6](#96-certificate-trust-for-on-prem-fmc). Summary: support an operator-supplied CA bundle (`FMC_CA_BUNDLE_PATH`) as the correct and documented path; provide `FMC_TLS_INSECURE_SKIP_VERIFY` as an explicitly-labeled, loudly-warned, default-`false` escape hatch for lab use only.

**Maturity note:** FMC's health/metrics endpoints have been present since FMC 7.1+ and are mature and stable, not beta. Building on them is safe; they are simply under-documented with respect to response bodies.

### 3.4 Adapter comparison summary

| Aspect | SCC / cdFMC | Standalone on-prem FMC |
|---|---|---|
| Auth mechanism | Static bearer token, `Authorization: Bearer` | Basic-auth login → tokens in **response headers**; `X-auth-access-token` on requests |
| Token lifetime | Non-expiring | **30 minutes**, max **3 refreshes**, then full re-auth |
| Auth state management | None | `FmcTokenManager` component required |
| Tenancy/scoping concept | Single tenant per token; FMC UID in path | **Domain UUID** in every config-API path |
| Devices per health request | **All devices in one call** | **One device per call** |
| Device discovery needed | No | **Yes**, with client-side pagination |
| Requests per poll cycle (50 devices) | 1 | ~250 (5 metric families) |
| Rate limit | **2 req/min on the health endpoint** | **300 GET/min per source IP**, **10 concurrent connections** |
| Poll interval default / floor | 60 s / hard floor 30 s | 60 s / throughput-bounded, sizing-dependent |
| TLS trust | Public CA, standard verification | **Self-signed by default**; operator CA bundle required |
| Response schema confidence | **Verified against live API call** | **Unverified — no example bodies published** |
| v1 status | Stable | **Experimental** |

---

## 4. Metric design

### 4.1 Naming convention

All metrics use the prefix **`ftd_`** for device health data and **`ftd_exporter_`** for the exporter's own operational metrics. Prometheus naming conventions are followed throughout:

- `snake_case` names, `ftd_<group>_<measurement>_<unit>`.
- Base units, with the unit as the final suffix (`_ratio`, `_bytes`, `_seconds`, `_rpm`, `_timestamp_seconds`). Per the [Prometheus naming conventions](https://prometheus.io/docs/practices/naming/)'s base-unit table, a percentage is `_ratio` with values **0–1**, never `_percent` with values 0–100 — a 2026-08-04 conventions audit found the CPU/memory/disk gauges using `_percent`/0–100 and converted them (division happens once, at the `collector.ts` render-time `set()` call site — see the "process learned" note below).
- `_total` suffix reserved strictly for monotonic counters, **checked by a registry-wide regression test** (`test/unit/self-metrics.test.ts`: every `# TYPE *_total` line must say `counter`). **The upstream data is almost entirely windowed averages, so most series are gauges** — labeling an average as a counter would break `rate()` semantics for users. The same 2026-08-04 audit found this exact rule violated twice in this file's own §11 (`ftd_exporter_devices_total`, `ftd_exporter_series_total`, both gauges) — both renamed to drop the suffix (`ftd_exporter_devices`, `ftd_exporter_series`).
- No metric name embeds a label value (no `ftd_cpu_lina_usage`; use `component="lina"`).

### 4.2 Metric catalog (SCC backend, v1)

Derived from the verified schema. `{d}` abbreviates the always-present label set `device_uid`, `device_name`.

**CPU** — three distinct series distinguished by a `component` label, per the live confirmation that these consistently break out into Lina (the ASA/FTD data-plane process), Snort (the IPS/inspection engine), and System (overall host). Collapsing them into one number would destroy the most operationally useful distinction in the payload.

```
# HELP ftd_cpu_usage_ratio Average CPU utilization over the sample window, 0-1.
# TYPE ftd_cpu_usage_ratio gauge
ftd_cpu_usage_ratio{device_uid="...",device_name="ftd-edge-01",component="lina"}   0.124
ftd_cpu_usage_ratio{device_uid="...",device_name="ftd-edge-01",component="snort"}  0.317
ftd_cpu_usage_ratio{device_uid="...",device_name="ftd-edge-01",component="system"} 0.22
```

Upstream Cisco fields are natively 0–100 (`linaUsageAvg: 19` means 19%); the exporter divides by 100 once, at the point the gauge is `set()` — see [§14](#14-open-questions-risks-implementation-phase-unknowns)'s naming-conventions-audit entry for why `_ratio`/0–1 was chosen over keeping the upstream shape verbatim.

**Memory** — identical shape, same rationale:

```
ftd_memory_usage_ratio{{d},component="lina|snort|system"}   gauge, 0–1
```

**Disk:**

```
ftd_disk_usage_ratio{{d}}                                   gauge, 0–1
```

**Interface** — labels `{d}` plus `interface` (hardware id), `interface_name` (human label, falls back to the hardware id when absent), `interface_type`:

| Metric | Type | Source field |
|---|---|---|
| `ftd_interface_input_bytes_avg` | gauge | `inputBytesAvg` |
| `ftd_interface_output_bytes_avg` | gauge | `outputBytesAvg` |
| `ftd_interface_input_packet_size_avg_bytes` | gauge | `inputPacketSizeAvg` |
| `ftd_interface_output_packet_size_avg_bytes` | gauge | `outputPacketSizeAvg` |
| `ftd_interface_input_errors_avg` | gauge | `inputErrorsAvg` |
| `ftd_interface_output_errors_avg` | gauge | `outputErrorsAvg` |
| `ftd_interface_drop_packets_avg` | gauge | `dropPacketsAvg` |
| `ftd_interface_buffer_overruns_avg` | gauge | `bufferOverrunsAvg` |
| `ftd_interface_buffer_underruns_avg` | gauge | `bufferUnderrunsAvg` |
| `ftd_interface_l2_decode_drops_avg` | gauge | `l2DecodeDropsAvg` |
| `ftd_interface_link_up` | gauge 1/0 | `linkStatus` |
| `ftd_interface_operational_up` | gauge 1/0 | `operationalStatus` |
| `ftd_interface_duplex_info` | gauge 1 + `duplex_mode` label | `duplexMode` (documented; not observed in the live sample — emitted only when present) |

**Unit ambiguity, stated rather than guessed:** it is not established whether `inputBytesAvg`/`outputBytesAvg` are bytes *per second* or total bytes averaged over the window. This document therefore keeps the neutral `_bytes_avg` suffix rather than asserting `_bytes_per_second`, and flags the question in [§14](#14-open-questions-risks-implementation-phase-unknowns) for empirical resolution. Renaming later is a breaking change, so guessing now would be the expensive option. The `_avg` suffix mirrors the upstream field name, which keeps the mapping auditable.

**All interfaces are exported, unconditionally.** The live sample confirmed that every interface appears — including fully unused ones (`Ethernet1/6` through `Ethernet1/8`, all DOWN, all-zero counters, several with no `interfaceName`). Filtering them would be wrong: "down interface with zero traffic" is signal, and suppressing it makes a genuinely removed interface indistinguishable from an idle one.

**Chassis** (conditional — chassis-based hardware only; confirmed entirely absent on a single-appliance FTD 1010):

```
ftd_chassis_fan_rpm{{d},fan="1".."4"}                         gauge
ftd_chassis_psu_fan_up{{d},psu="1"|"2"}                        gauge 1/0
ftd_chassis_psu_input_up{{d},psu="1"|"2"}                      gauge 1/0
ftd_chassis_psu_output_up{{d},psu="1"|"2"}                     gauge 1/0
```

Fans are collapsed into one metric with a `fan` label rather than four `fan1..fan4` metrics — standard Prometheus practice, and it makes `min by (device_name) (ftd_chassis_fan_rpm)` trivially expressible.

**HA** (conditional — only when the device is in an HA pair):

```
ftd_ha_node_status{{d},status="normal|error|warning|disabled|unknown"}   gauge 1/0 (state set)
ftd_ha_node_info{{d},node_type="primary|secondary"}                      gauge, always 1
```

**RA VPN** (conditional — only when RA VPN is configured):

```
ftd_ravpn_sessions_active_avg{{d}}                            gauge
ftd_ravpn_sessions_inactive_avg{{d}}                          gauge
ftd_ravpn_sessions_peak_concurrent{{d}}                       gauge
```

**Site-to-site VPN tunnels** (conditional — only when S2S VPN is configured; upstream array capped at 1000 entries):

```
ftd_s2s_tunnel_state{{d},tunnel_id="...",tunnel_name="...",state="up|down|unknown"}  gauge 1/0
```

Worst-case cardinality: 1000 tunnels × 3 states × devices. Acceptable for a firewall fleet, but **`ftd_s2s_tunnel_state` is the highest-cardinality series in v1** and the docs should say so. A `FTD_DISABLE_S2S_TUNNEL_METRICS` opt-out is a reasonable v1.1 addition if operators report cardinality pressure.

**Sample-window timestamps** — see [§4.5](#45-sample-window-timestamps).

### 4.3 Label strategy

| Label | Applied to | Notes |
|---|---|---|
| `device_uid` | **Every** `ftd_*` metric | Stable identifier; the join key |
| `device_name` | **Every** `ftd_*` metric | Human-readable; **mutable** — a rename creates a new series |
| `component` | CPU, memory | `lina` \| `snort` \| `system` |
| `interface` | Interface metrics | Hardware id, e.g. `Ethernet1/1`. Always present |
| `interface_name` | Interface metrics | Human label, e.g. `outside`. **Optional upstream** — falls back to the `interface` value |
| `interface_type` | Interface metrics | e.g. `Ethernet`, `Management` |
| `fan`, `psu` | Chassis metrics | Numeric index as a string |
| `status`, `state` | State-set metrics | Lowercased enum value |
| `node_type` | `ftd_ha_node_info` | `primary` \| `secondary` |
| `tunnel_id`, `tunnel_name` | S2S tunnel metrics | `tunnel_id` is the stable key |

Rules:

- **`device_uid` and `device_name` are both always present.** Carrying the mutable name alongside the stable UID is a small cardinality cost for a large usability win — dashboards and alerts are unreadable with UIDs alone, and requiring users to join against an info metric for every panel is hostile.
- **Enum values are lowercased** in labels (`UP` → `up`) for consistent PromQL matching. The `_info`-style metrics preserve semantic values as documented.
- **Deliberately absent:** anything per-user, per-session, per-flow, or per-source-IP. See [§4.7](#47-explicitly-excluded-from-scope).
- **No `instance`/`job` labels are set by the exporter** — those are the scraper's responsibility, and setting them would be overwritten or would conflict with `honor_labels` semantics.
- **Empty-string labels are never emitted.** If an optional label's value is absent and there is no fallback, the label is omitted entirely, because `interface_name=""` and a missing label behave differently in PromQL and the empty string is the more surprising of the two.

### 4.4 Representing status enums

Prometheus has no native enum type, and the wrong choice here is hard to undo. Three patterns were considered:

1. **Single numeric gauge with an encoded value** — `ftd_ha_node_status 2` where 2 means WARNING. **Rejected.** Values are meaningless without an out-of-band legend, arithmetic on them is nonsense, and every dashboard must hardcode the mapping.
2. **Boolean gauge per condition** — `ftd_interface_link_up 1|0`. Ideal for genuinely binary states.
3. **State-set: one series per possible value, exactly one of which is 1** — the pattern recommended by Prometheus's own documentation for enums.

**Decision:**

- **Binary UP/DOWN states → a single boolean gauge** named for the true condition: `ftd_interface_link_up`, `ftd_interface_operational_up`, `ftd_chassis_psu_input_up`, etc. Queries are trivial (`ftd_interface_link_up == 0` finds every down interface), and Grafana thresholds/stat panels work with no transformation.
- **Multi-valued enums → the state-set pattern**, with a label carrying the value and exactly one series at 1:

  ```
  ftd_ha_node_status{...,status="normal"}   1
  ftd_ha_node_status{...,status="error"}    0
  ftd_ha_node_status{...,status="warning"}  0
  ftd_ha_node_status{...,status="disabled"} 0
  ftd_ha_node_status{...,status="unknown"}  0
  ```

  This makes `ftd_ha_node_status{status="error"} == 1` a direct alerting expression, keeps every possible state visible in Grafana even when currently inactive, and requires no legend.
- **Purely informational attributes → an `_info`-suffixed gauge always equal to 1**, carrying the attributes as labels (`ftd_ha_node_info{node_type="primary"} 1`). The standard Prometheus info-metric convention, joinable via `group_left`.
- **Unrecognized enum values** map to `status="unknown"` (for state sets and `_info` labels alike — an `_info` gauge is still emitted, since it is informational rather than a health check, but the label value itself is bounded the same way) or are omitted (for booleans), and increment `ftd_exporter_unknown_enum_total{metric,value}` — so a new Cisco enum value shows up as a metric rather than as silently wrong data or an unbounded label. This is cheap insurance against an upstream API change, and applies uniformly across every enum-shaped field, informational or not — a 2026-08-04 audit found `ftd_ha_node_info`'s `node_type` label had been left minting the raw upstream value directly instead of falling back to `unknown` like every other enum here.

### 4.5 Sample-window timestamps

The API returns per-device `startTime`/`endTime` (ISO 8601) bounding the averaging window — confirmed present in live data. This exporter surfaces them:

```
ftd_health_window_start_timestamp_seconds{{d}}   gauge, unix seconds
ftd_health_window_end_timestamp_seconds{{d}}     gauge, unix seconds
```

Purpose: **staleness/freshness detection per device.** A device that has stopped reporting fresh health data — while the exporter itself is polling successfully and everything else looks green — is otherwise invisible, because the last-known gauge values simply persist. With this metric, the condition is a one-line alert:

```promql
time() - ftd_health_window_end_timestamp_seconds > 900
```

This distinguishes "the exporter is broken" (`ftd_exporter_up == 0`) from "this specific device stopped reporting" — genuinely different problems with different owners.

**Note on Prometheus timestamp semantics:** these are exported as *gauge values*, not as exposition-format explicit timestamps. Explicit timestamps in exposition format are a niche feature, are rejected by some scrapers when too far from scrape time, and interact badly with staleness handling. Values-as-gauges is the idiomatic and safe choice.

### 4.6 Scope table

Priority framing: **CPU, memory, disk, and interface are the baseline criteria** — they are the fundamental health signals operators expect and what defines a successful v1. HA, VPN, and chassis are additionally in v1 because on the SCC backend **they arrive in the same response payload at zero additional request cost**; not exporting data already in hand would be a strange omission.

| Metric group | Backend | v1 | Rationale / notes |
|---|---|---|---|
| CPU (lina/snort/system) | SCC + FMC | **Yes — priority** | Baseline. Same payload |
| Memory (lina/snort/system) | SCC + FMC | **Yes — priority** | Baseline. Same payload |
| Disk usage | SCC + FMC | **Yes — priority** | Baseline. Same payload |
| Interface stats (12 fields) | SCC + FMC | **Yes — priority** | Baseline. Largest series count |
| Interface link/operational status | SCC + FMC | **Yes** | Same payload; high operational value |
| Chassis fan RPM / PSU status | SCC + FMC | **Yes (conditional)** | Zero extra cost on SCC. **Chassis hardware only** — confirmed absent on appliances |
| HA node status / type | SCC + FMC | **Yes (conditional)** | Zero extra cost on SCC. **Only present in an HA pair** |
| RA VPN aggregate session counts | SCC + FMC | **Yes (conditional)** | Zero extra cost on SCC. **Only if RA VPN configured** |
| S2S VPN tunnel state | SCC + FMC | **Yes (conditional)** | Zero extra cost on SCC. **Only if S2S VPN configured.** Highest-cardinality v1 series |
| Sample-window timestamps | SCC (+FMC if available) | **Yes** | Enables per-device staleness alerting |
| Exporter self-metrics | Both | **Yes** | See [§11](#11-observability-of-the-exporter-itself) |
| **Smart License status** (`regStatus`, `authStatus`, `evalExpiresInDays`) | SCC `/license/smartlicenses` | **v1.1** | Directly actionable — license compliance alerting. Separate request, so a real (if small) cost. Strong candidate for the first post-v1 addition |
| **Device inventory / connectivity state** (`connectivityState`, `configState`, `conflictDetectionState`, `softwareVersion`, `serial`, `licenseStatus`, `complianceStatus`, `ftdPerformanceTier`, `redundancyMode`, `snortVersion`/`vdbVersion`/`geoDbVersion`/`sruVersion`) | SCC `/v1/inventory/devices` | **v1.1** | High value as an `ftd_device_info` metric plus connectivity gauges. Separate request; needs a cardinality-conscious split between info labels and gauges |
| **Certificate expiry** (`certificateExpiryDate`, `raVpnCertificateExpiryDate`) | SCC `/v1/inventory/devices` | **v1.1** | Excellent proactive alerting value as `ftd_certificate_expiry_timestamp_seconds`, queryable as days-remaining. Arrives free with the inventory call |
| **Health alerts/events as status gauges** | FMC `/health/alerts`, `/health/events` | **Backlog** | Natural per-module `up`/`down` gauge or event-count metric. Needs a cardinality assessment for module/severity combinations |
| **FMC-appliance-level health** (device UUID `0`) | FMC | **Backlog** | Distinct from managed-device health; needs its own label design to avoid conflation |
| **Skip metric requests to `isConnected: false` devices** | FMC | **v1.1 candidate** | `devicerecords`' `isConnected` flag is already parsed by discovery (`FmcDiscoveredDevice.isConnected`) but never consulted before the per-device/per-family fan-out — confirmed via the 2026-08-07 live smoke test, where 3 of 4 lab devices were disconnected and still generated a full family fan-out of `400 Device not connected.` responses every cycle, spending FMC request budget for no data. Not implemented in v1 because discovery runs on its own slower cadence (`FMC_DISCOVERY_INTERVAL_SECONDS`, default 900s) — pre-filtering on a snapshot that stale risks a false-negative skip of a device that reconnected since the last discovery run. Worth reconsidering for large fleets with many standby/disconnected devices, where the budget savings would be more significant. |
| **Fleet-wide aggregations** (30m/2h/6h/24h/7d rollups) | SCC `/v1/inventory/devices/health/metrics/aggregations` | **Backlog** | Pre-aggregated histograms, a different response shape. **Prometheus and Grafana already do this aggregation natively from the raw per-device metrics**, so the marginal value is low and the mapping work is nontrivial |
| **Chassis detail** (mode/connectivity/model/version) | SCC `/chassis/fmcmanagedchassis/{objectId}` | **Backlog** | Partially overlaps `chassisStatsHealthMetrics`; overlap unresolved ([§14](#14-open-questions-risks-implementation-phase-unknowns)) |
| **Secure Device Connector (SDC) status/heartbeat** | SCC `/v1/connectors/sdcs` | **Backlog** | Only relevant to on-prem-connector deployments. Genuinely useful for that subset |
| **High-resolution time-series mode** | FMC `/health/metrics`, cdFMC HealthMonitor `/health/metrics` \| `/health/events` | **v1.1+, opt-in** | Raw Prometheus-named series (`cpu`, `mem`, `interface`, `asp_drops`, `disk_stats`, `critical_process`) with `startTime`/`endTime`/`step` and regex filtering. More granular but needs window-cursor management; wrong default for a simple pull exporter |
| **FMC `/health/metricconfiguration`** | FMC | **Excluded from planning** | Undocumented in Cisco's own guide. Not designed around |
| **Per-session RA VPN detail** | SCC `/v1/vpnsessions` | **Explicitly excluded** | See [§4.7](#47-explicitly-excluded-from-scope) |
| **`/v1/tenants`** | SCC | **Excluded** | Explicitly **deprecated** in current Cisco docs. Building on it would be a known-dead-end |
| **Render-side metric-group filter** (operator opts a device/group out of rendering, independent of what upstream returns) | Both | **v1.1** | Raised by the 2026-08-04 naming-conventions audit as a plausible high-cardinality-fleet ask; no upstream API change needed, purely a collector.ts filter |
| **`ftd_manager_info` + version-gated field mapping** (labels the managing FMC/SCC version so a field-name divergence across Cisco releases is queryable rather than silently mismapped) | Both | **v1.1** | Motivated directly by [§14.1](#141-standalone-fmc-response-body-field-names--resolved-for-all-five-metric-families)'s undocumented-field-name risk — a version label lets a future mapping bug be correlated to a specific FMC release instead of discovered blind |
| **NTP sync status / clock drift** | FMC (endpoint unconfirmed) | **Backlog** | Cisco API feasibility unverified — no endpoint has been checked against a live appliance |
| **Temperature / voltage / power-alarm sensors** | FMC (endpoint unconfirmed) | **Backlog** | Cisco API feasibility unverified — plausible chassis-adjacent data, not confirmed to exist in any response schema checked so far |

### 4.7 Explicitly excluded from scope

**Per-session RA VPN detail (`GET /v1/vpnsessions`) will not be exported.** The endpoint returns individual session records with per-user identity, source IP, geolocation, and byte counts. Exporting it would mean one or more series per *active VPN user*, with labels containing usernames and IP addresses. Consequences:

- **Unbounded, churning cardinality.** Every connect/disconnect mints new series. A few thousand remote workers would generate cardinality comparable to a large Kubernetes fleet, from one exporter.
- **Prometheus is the wrong data model.** Session records are events with lifecycles, not gauges. They belong in a log/event store.
- **It turns a metrics endpoint into a PII surface.** Usernames and source IPs in `/metrics` — an endpoint conventionally treated as low-sensitivity and often broadly readable — is a privacy problem the exporter should not create.

**The aggregate `raVpnSessionHealthMetrics` counts are the correct metric** for the actual monitoring need ("how many users are connected, is it near capacity"), are already in v1, and cost nothing extra. Operators who need per-session forensics should query the API or use Cisco's own tooling.

### 4.8 Handling conditional and sparse metric groups

Confirmed behavior, not theory: in a live call against a single-appliance FTD 1010, `chassisStatsHealthMetrics`, `haHealthMetrics`, `raVpnSessionHealthMetrics`, and `s2sVpnTunnelHealthMetrics` were **all absent — the keys themselves were missing**, not present as null or empty. Several interface entries were also missing the optional `interfaceName`.

**Rule: when a group is absent, omit the series entirely. Never emit zero, and never emit `NaN`.**

Emitting `ftd_ha_node_status 0` for a standalone device would assert "measured, and it is not normal" when the truth is "not applicable". That difference matters enormously: it would light up HA alerts on every non-HA firewall in the fleet, and `count(ftd_ha_node_status)` would misreport the HA footprint. The same reasoning applies to chassis metrics on appliances and VPN metrics where VPN is not configured.

Implementation consequences:

- Every conditional group is **optional at the TypeScript type level** (`?:`), with `strict` and `exactOptionalPropertyTypes` enabled so the compiler enforces presence checks rather than trusting discipline.
- Presence is tested with explicit `undefined` checks, never truthiness — `0` is a legitimate value for nearly every numeric field, and `if (metrics.cpu.lina)` would silently drop a genuine 0% reading.
- **The renderer must clear prior state on every scrape.** `prom-client` gauges retain previously-set label combinations, so a device or interface that disappears would keep emitting its last value forever. The design uses a **custom collector** registered on the `Registry` whose `collect()` callback rebuilds series from the cache snapshot on each scrape, with `gauge.reset()` before repopulating. This makes disappearance behave correctly (the series vanishes, Prometheus marks it stale) and is the single most important correctness detail in the rendering layer.
- Absent groups are logged at `debug` only. A standalone appliance with no chassis, HA, or VPN is entirely normal and must not produce warnings — a warning that fires constantly on healthy systems trains operators to ignore logs.

Documentation must state, for each conditional group, the precise condition under which it appears — and pair it with the health-policy prerequisite from [§3.2.5](#325-health-policy-prerequisite), since "metric missing" has two quite different root causes (capability/configuration vs health policy) and operators need both in the troubleshooting flow.

---

## 5. Deployment: standalone process

> **This section is self-contained.** A user deploying as a bare process needs only this section plus [§8](#8-configuration-reference). Docker and Kubernetes are covered independently in [§6](#6-deployment-docker) and [§7](#7-deployment-kubernetes).

### 5.1 Packaging approach

Two options were considered:

| Option | Assessment |
|---|---|
| **Plain Node.js + npm** — `npm ci`, `npm run build`, `node dist/index.js` | **Recommended.** Maximum portability, one artifact for all platforms, trivially auditable by a customer's security team, no per-platform release matrix, no signing/notarization concerns |
| **Single-executable application** (Node 24 SEA) or `pkg`-style bundling | Rejected for v1. Requires a per-OS/per-arch build and release matrix, produces large binaries, complicates supply-chain verification, and on macOS raises code-signing and Gatekeeper issues. Genuinely nice for operators without Node; revisit as a convenience artifact in a later release, not the primary path |

**Decision: plain Node.js + npm as the supported standalone path.** Publishing to npm additionally enables `npx ftd-metrics-exporter` for evaluation.

**The absolute requirement making this work: no native addons, no `node-gyp`, no platform-conditional dependencies anywhere in the tree.** Both runtime dependencies (`prom-client`, `undici`) are pure JavaScript. This guarantees one artifact behaves identically on Windows, macOS, and Linux, with no compiler toolchain required at install time. CI must verify this (see [§13](#13-repository-hygiene-and-release-process)).

### 5.2 Prerequisites (all platforms)

- **Node.js 24 or later** (`engines.node: ">=24"`). Node 24 is required, not merely recommended — the design depends on native `.env` loading and current `fetch`/`undici` behavior. The process should check `process.version` at startup and exit with a clear message on an older runtime rather than failing obscurely.
- Outbound HTTPS (TCP 443) to the SCC regional endpoint, **or** HTTPS reachability to the on-prem FMC host.
- An inbound listener port for `/metrics` (default `10049`, configurable).

**On the port choice:** default `10049`, to be registered on the Prometheus project's [default port allocations](https://github.com/prometheus/prometheus/wiki/Default-port-allocations) list as part of the release process. Registering a port is a small piece of good OSS citizenship that prevents collisions with other exporters on shared hosts — `9100`, for instance, is `node_exporter`'s well-known port and would collide on any host running it, so it must not be reused here. The originally-chosen `9812` turned out to already be registered to the FreeRADIUS exporter (`semaphor-dk/freeradius_exporter`); a 2026-08-04 audit found the entire `9100`–`9999` range exhausted, with new exporters landing at `10001`+ — `10049` was the first free slot at audit time.

### 5.3 Install and run outline

Design-level; exact commands are implementation-doc material. The flow is identical on all three OSes, which is the point:

Two install paths, converging from step 4 onward — `npm install -g`/`npx` ships a pre-built `dist/` with nothing to compile, while cloning source requires the build step:

1. Install Node.js 24+.
2. Either `npm install -g ftd-metrics-exporter` (or `npx ftd-metrics-exporter` to try it without installing), **or** `git clone` a tagged release / download a release tarball and run `npm ci` then `npm run build` — TypeScript to `dist/`.
3. Create a `.env` file from `example.env` and populate the required variables ([§8](#8-configuration-reference)).
4. `ftd-metrics-exporter` (npm path) or `node dist/index.js` (source path) — reads `.env` from the working directory by default; `--env-file=/path/to/.env` overrides. Node itself also recognizes `--env-file`, so a missing/unreadable path fails with Node's own error and exit code 9 rather than the exporter's exit code 1.
7. Verify: `curl http://localhost:10049/metrics` returns exposition-format text including `ftd_exporter_up 1`.

### 5.4 Platform-specific notes

The **only** genuine platform differences are file permissions on `.env` and the service-supervision mechanism. Each is documented independently and completely in the README so a user never needs to read another platform's instructions.

**Linux**

- Restrict the secret file: `chmod 600 .env`, owned by the service user.
- Run under a **dedicated unprivileged service account** (e.g. `ftd-exporter`), never root. The default port 10049 is >1024, so no privileged binding is needed.
- Supervision: a **systemd unit** is the documented approach — `Restart=always`, `EnvironmentFile=` pointing at the `.env` (or `.env` loaded by the process), plus hardening directives (`NoNewPrivileges=yes`, `ProtectSystem=strict`, `PrivateTmp=yes`, `ProtectHome=yes`, `ReadWritePaths=` empty since the exporter never writes files). An example unit file is an implementation-phase deliverable.

**macOS**

- `chmod 600 .env`.
- Supervision: a **`launchd` property list** in `~/Library/LaunchAgents/` (per-user) or `/Library/LaunchDaemons/` (system-wide), with `KeepAlive` set. Example plist is an implementation-phase deliverable.
- Node installed via the official installer, Homebrew, or a version manager — all equivalent; the docs should not mandate one.

**Windows**

- POSIX `chmod` does not apply. The documented equivalent is **removing inherited permissions and granting read access only to the service account**, via `icacls` — with the concrete command in the implementation docs. Getting this right matters: a `.env` on Windows commonly inherits broad `Users` read access by default, which silently exposes the API token to every local account. This is a real difference from Unix, not a formality.
- Supervision: **Windows Service** via `sc.exe` with a wrapper, **NSSM**, or a **Task Scheduler** task with "run whether user is logged on or not". The docs should present one recommended path (Task Scheduler is dependency-free and built in) plus a note that NSSM is popular where true service semantics are wanted.
- Path handling in code must use `node:path` throughout and never assume `/` separators — relevant for `FMC_CA_BUNDLE_PATH` and the TLS cert/key paths.
- **No PowerShell-only or Windows-only tooling is required to run the exporter.** Any Windows-specific commands in the docs are for OS-level service and permission setup, not for the application.

---

## 6. Deployment: Docker

> **This section is self-contained.** A user deploying via Docker needs only this section plus [§8](#8-configuration-reference).

### 6.1 Image design

**Multi-stage build, single `Dockerfile`** at the repository root.

- **Stage 1 (builder):** full `node:26` image. Copies `package.json` + `package-lock.json`, runs `npm ci` (dev dependencies included), copies source, runs `npm run build`.
- **Stage 2 (runtime):** `node:26-slim`. Copies only `dist/` and production `node_modules` (`npm ci --omit=dev`). No TypeScript compiler, no source, no dev dependencies in the shipped image.

**Base image choice.** `node:26-slim` (Debian-slim) is the recommendation. Node 26 rather than 24 is a deliberate choice for the container image specifically — it matches the runtime version already in use on the implementer's own development machine, and `engines.node` in `package.json` (`>=24`) already permits it; nothing in the exporter depends on a 24-specific behavior.

| Candidate | Assessment |
|---|---|
| `node:26-slim` | **Recommended.** Debian-slim base, glibc-based, official, well-patched, no musl surprises, includes a shell for debugging. Smallest of the glibc options here, though "small" is relative: measured at ~350 MB for the bare base image and ~365 MB for this project's final built image on 2026-08-06 (Debian-slim images have grown substantially since the "~80 MB class" figure once quoted in this table, which is now stale — verified directly against a real `docker build`/`docker images` on `linux/amd64`, not assumed) |
| `node:26-alpine` | Smaller still (musl-based Alpine images are typically well under 100 MB), but musl libc introduces DNS-resolution and TLS edge-case differences that are a poor trade for a network-centric exporter. Not re-measured for this project — rejected on the DNS/TLS risk regardless of the exact size delta |
| `gcr.io/distroless/nodejs26` | Smallest attack surface and genuinely attractive. Rejected for v1 only because the absence of a shell makes customer-side troubleshooting materially harder for a tool people are deploying for the first time. Reasonable v1.1 alternative tag |
| Full `node:26` | Unnecessarily large for runtime |

### 6.2 Container hardening

Design requirements, all reflected in the Dockerfile and documented `docker run` invocation:

- **Runs as a non-root user.** An explicit `USER` directive with a fixed non-zero UID/GID (e.g. `10001`) — not the image's default `node` user, so the UID is predictable for volume permissions and Kubernetes `runAsUser`.
- **Read-only root filesystem supported.** The exporter never writes to disk (cache is in-memory only, logs go to stdout), so `--read-only` works with no `tmpfs` mounts required. This is a direct benefit of the no-persistent-cache decision in [§9.3](#93-encryption-at-rest-and-persistent-state).
- **`--cap-drop=ALL`** and **`--security-opt=no-new-privileges`** in the documented invocation.
- **`EXPOSE 10049`** for documentation value.
- **No secrets baked into the image, ever** — no `ENV` with credential values, no `COPY .env`. `.env` must be listed in `.dockerignore` alongside `node_modules`, `.git`, and `dist`, so a stray local `.env` cannot be accidentally embedded in a layer. This is a real and common accident and the `.dockerignore` is a load-bearing security control here.
- **A `HEALTHCHECK`** hitting `/healthz`.
- **Signal handling:** the process must handle `SIGTERM` for graceful shutdown (stop accepting connections, cancel in-flight polls, exit 0). Documented as `ENTRYPOINT ["node", "dist/index.js"]` in exec form so the process is PID 1 and receives signals directly, rather than being wrapped by a shell that swallows them.

### 6.3 Configuration injection

Two documented approaches, in order of preference:

1. **`--env-file .env`** — Docker reads the file on the host and injects the variables. **Recommended**: the file never enters the image or a volume, and the same `.env` works for the standalone path.
   ```
   docker run --rm --env-file .env -p 10049:10049 --read-only --cap-drop=ALL \
     ghcr.io/apilbeam101/ftd-metrics-exporter:1.0.0
   ```
2. **Individual `-e` flags** — acceptable for non-secret variables. **Documented with an explicit warning** that secrets passed via `-e` on the command line are visible in shell history and in `docker inspect`.

For a **file-valued** variable such as `FMC_CA_BUNDLE_PATH`, the CA bundle is mounted read-only into the container (`-v /host/ca.pem:/etc/ftd-exporter/ca.pem:ro`) and the variable set to the in-container path. Documented explicitly, since it is the one case where env vars alone are insufficient. The same pattern applies to `METRICS_TLS_CERT_PATH`/`METRICS_TLS_KEY_PATH` if the native TLS listener is used.

A `docker-compose.yml` example is a useful implementation-phase deliverable for users who prefer it, using `env_file:` and read-only mounts.

### 6.4 Publishing

- **Primary registry: GHCR** (`ghcr.io/apilbeam101/ftd-metrics-exporter`), built by CI on tagged releases (`.github/workflows/release.yml`). Chosen over Docker Hub, Quay, and ECR Public because Docker Hub's anonymous-pull limit (100 pulls/6h per IPv4/IPv6-/64) is a real failure mode for a NAT'd Kubernetes cluster — this exporter's primary deployment target — and GHCR needs no stored long-lived push credential (the release workflow authenticates with the ephemeral `GITHUB_TOKEN` via OIDC, not a PAT).
- **Docker Hub mirror**, published by the same release workflow, for discoverability only (`docker pull <name>` with no registry prefix resolves there). Mirroring is `continue-on-error`: a mirror failure must never fail a release whose primary GHCR/npm artifacts already published successfully. Documentation never points a Kubernetes deployment at the mirror — the anonymous rate limit makes it unsuitable as a cluster default.
- Tags: exact version (`1.2.3`), minor (`1.2`), major (`1`), and `latest`. Documentation recommends pinning to at least the minor tag in production, or a digest for the strongest guarantee.
- **Multi-architecture builds** (`linux/amd64`, `linux/arm64`) via Buildx — cheap here because there is nothing to compile, and it makes the image usable on ARM homelabs and Graviton alike.
- Build provenance/attestation and an SBOM published with the image; see [§9.7](#97-dependency-and-supply-chain-hygiene).
- **Monthly rebuild** (`.github/workflows/rebuild.yml`, 1st of the month) republishes the *moving* tags only (minor/major/`latest`) against the current `node:26-slim` base image, so Debian security patches reach consumers without a source release. Exact-version tags are never overwritten — pinning one is a genuine immutability guarantee. A companion **monthly scan** (`.github/workflows/scan.yml`) reports high/critical findings on the published image to the Security tab regardless of whether the rebuild ran; see [SECURITY.md](../SECURITY.md) for the full policy and why the scan is the load-bearing half of this cadence (a scheduled workflow in a public repo is auto-disabled after 60 days of inactivity, and a monthly cadence makes two missed runs enough to hit that window).

---

## 7. Deployment: Kubernetes

> **This section is self-contained.** A user deploying to Kubernetes needs only this section plus [§8](#8-configuration-reference).

### 7.1 Manifest set

Plain YAML manifests (a `deploy/kubernetes/` directory), with a Helm chart deferred to a later release. Rationale: plain manifests are readable, reviewable, and copy-pasteable, and they do not force the project to maintain a chart's values API before the configuration surface has stabilized. A chart is a good v1.1+ addition once the config surface is proven.

| Object | Purpose |
|---|---|
| `Namespace` | Optional; docs assume an existing namespace such as `monitoring` |
| `Secret` | All sensitive configuration — the Kubernetes equivalent of `.env` |
| `ConfigMap` | Non-sensitive configuration only (poll interval, log level, port, backend type) |
| `Deployment` | The exporter itself, **`replicas: 1`** (see [§7.3](#73-replica-count-and-why-it-is-1)) |
| `Service` | `ClusterIP` on port 10049, named port `metrics` |
| `ServiceMonitor` *or* `PodMonitor` | Optional, for Prometheus Operator users ([§7.5](#75-prometheus-operator-integration)) |
| `NetworkPolicy` | Optional but recommended; egress to the API endpoint, ingress from the scraper only |

### 7.2 Deployment specifics

- **Config from `Secret` + `ConfigMap` via `envFrom`**, so the container's environment is populated exactly as in the standalone and Docker paths. No `.env` file exists in the container. This uniformity across all three deployment methods is intentional — one configuration mechanism, three injection mechanisms.
- **`securityContext`** matching the container hardening in [§6.2](#62-container-hardening): `runAsNonRoot: true`, explicit `runAsUser`/`runAsGroup`, `allowPrivilegeEscalation: false`, `readOnlyRootFilesystem: true`, `capabilities.drop: [ALL]`, `seccompProfile.type: RuntimeDefault`. All of these work because the exporter writes nothing to disk and needs no capabilities.
- **Probes:**
  - `livenessProbe` → `GET /healthz` — process is alive and the HTTP server is responding. **Deliberately does not depend on upstream API health**, or a Cisco API outage would trigger an endless restart loop that fixes nothing and destroys the cache.
  - `readinessProbe` → `GET /readyz` — returns 200 once the first successful poll has populated the cache, so the Service does not route scrapes to a pod that would return an empty metrics page.
- **Resource requests/limits:** modest — this is a small Node process holding one JSON snapshot in memory. Starting point: `requests: 50m CPU / 128Mi memory`, `limits: 500m CPU / 256Mi memory`. Documented as a starting point to tune with fleet size, since a 1000-tunnel, 500-interface fleet will need more.
- **`prometheus.io/scrape` annotations** included as an alternative for users on annotation-based service discovery rather than the Operator.
- **A CA bundle for on-prem FMC** is mounted from its own `Secret` or `ConfigMap` as a read-only volume, with `FMC_CA_BUNDLE_PATH` pointing at the mount path. This is the one place a volume is required.

### 7.3 Replica count, and why it is 1

**`replicas: 1` is the documented and recommended configuration, and this is a deliberate design position rather than an oversight.**

- Each replica polls the upstream API independently. **Two replicas double the upstream request rate.** On the SCC backend, whose limit is 2 requests/minute, two replicas at a 60 s interval consume the *entire* budget and leave nothing for retries; three would exceed it outright.
- Two replicas also produce **duplicate time series** distinguished only by the `instance` label, which breaks naive `sum()`/`count()` aggregations and confuses dashboards.
- The exporter is **stateless with an in-memory cache**; a pod restart costs one poll interval of data, which is an acceptable and self-healing failure mode for health metrics that are themselves windowed averages.

If an operator genuinely needs HA, the correct approach is documented rather than left as an exercise: run two replicas, but **increase `POLL_INTERVAL_SECONDS` proportionally** so the aggregate rate stays within the upstream limit, and deduplicate at the Prometheus/Thanos layer. Leader election is noted as a possible future feature in [§14](#14-open-questions-risks-implementation-phase-unknowns), and it is the right long-term answer if HA demand materializes.

### 7.4 Secret management

- The bundled `Secret` manifest is a **template with placeholder values only** and must document that committing a populated `Secret` to Git — even base64-encoded, which is encoding and not encryption — defeats the entire credential-handling design.
- Documentation should point to established alternatives without mandating one: **External Secrets Operator**, **Sealed Secrets**, **SOPS**, or the cloud providers' CSI secret drivers. Users of GitOps will already have one of these; the docs' job is to name them so the "just commit it" path is visibly not the recommended one.
- Kubernetes `Secret` values are stored in etcd and should be protected by **etcd encryption-at-rest**, which is a cluster-level control the docs should mention as an operator responsibility.

### 7.5 Prometheus Operator integration

- A **`ServiceMonitor`** is the recommended primary, matching the `Service`'s `metrics` port. A **`PodMonitor`** alternative is provided for users who scrape pods directly.
- The `ServiceMonitor`'s `interval` is **independent of `POLL_INTERVAL_SECONDS`** — this is worth stating explicitly in the manifest comments, because it is exactly the point of the poll-cache-serve pattern and it is the thing new users most predictably get wrong ("I set the scrape interval to 5m to respect the rate limit"). A 30 s or 60 s scrape interval against a 60 s poll interval is perfectly reasonable and costs nothing upstream.
- If the exporter's native TLS listener is used, the `ServiceMonitor` needs `scheme: https` plus `tlsConfig`. Documented, but see [§9.2](#92-the-exporters-own-metrics-endpoint) — for most Kubernetes users, plain HTTP within the cluster plus a service mesh or ingress for TLS is the simpler and recommended posture.

---

## 8. Configuration reference

Every variable below appears in the checked-in **`example.env`** with a blank or placeholder value, a comment explaining what it is, and — for credentials — **precise instructions on where to obtain it**. `example.env` is the authoritative user-facing documentation for configuration; this table is the design specification for it.

**`.env` is gitignored. `example.env` contains no real values, ever.**

### 8.1 Core

| Variable | Purpose | Required | Default | Example / placeholder |
|---|---|---|---|---|
| `BACKEND_TYPE` | Which management API to poll. `scc` or `fmc` | **Yes** | — | `scc` |
| `METRICS_PORT` | TCP port for the `/metrics` listener | No | `10049` | `10049` |
| `METRICS_BIND_ADDRESS` | Interface to bind. `127.0.0.1` restricts to localhost | No | `0.0.0.0` | `0.0.0.0` |
| `POLL_INTERVAL_SECONDS` | Upstream poll cadence. **Not** the Prometheus scrape interval | No | `60` | `60` |
| `LOG_LEVEL` | `error` \| `warn` \| `info` \| `debug` | No | `info` | `info` |
| `LOG_FORMAT` | `json` (recommended) or `text` for human-readable local runs | No | `json` | `json` |
| `REQUEST_TIMEOUT_SECONDS` | Per-request total time budget | No | `30` | `30` |
| `ENABLE_DEFAULT_METRICS` | Whether to also expose `prom-client`'s Node.js/process default metrics alongside the `ftd_*` metrics | No | `true` | `true` |

*(`ENABLE_DEFAULT_METRICS` was originally documented only in [§11](#11-observability-of-the-exporter-itself) with no entry in this table — a documentation gap closed during Stage 4's implementation, not a new decision.)*

### 8.2 SCC backend (required when `BACKEND_TYPE=scc`)

| Variable | Purpose | Required | Default | Example / placeholder |
|---|---|---|---|---|
| `SCC_BASE_URL` | Regional API base URL. **Never defaulted** — the operator must state their region. `example.env` lists all regional values and notes legacy `edge.<region>.cdo.cisco.com` hosts as deprecated-but-functional | **Yes** | — | `https://api.eu.security.cisco.com/firewall` |
| `SCC_API_TOKEN` | Static bearer token. **Obtain via:** SCC UI → Settings → User Management → "+" → name the user → check "API Only User" → select **Read-only** (least privilege) → OK → **Generate API Token**. Shown **once** — copy immediately | **Yes** | — | *(blank)* |
| `SCC_FMC_UID` | UID of the cloud-delivered FMC whose managed devices are polled. **Obtain via:** the SCC inventory UI or `GET /v1/inventory/managers` | **Yes** | — | `00000000-0000-0000-0000-000000000000` |
| `SCC_TIME_RANGE` | Averaging window requested upstream: `5m` \| `15m` \| `30m` \| `1h`. **This value genuinely reaches the request** | No | `5m` | `5m` |

### 8.3 Standalone FMC backend (required when `BACKEND_TYPE=fmc`)

| Variable | Purpose | Required | Default | Example / placeholder |
|---|---|---|---|---|
| `FMC_HOST` | FMC hostname or IP. Hostname strongly preferred so certificate verification can succeed | **Yes** | — | `fmc.example.internal` |
| `FMC_USERNAME` | API service-account username. **Must be a dedicated API-only account** — Cisco documents that one account cannot be used via the UI and API simultaneously; sharing an account will silently log the human user out of the FMC UI and cause intermittent exporter 401s | **Yes** | — | `ftd-exporter-svc` |
| `FMC_PASSWORD` | Service-account password | **Yes** | — | *(blank)* |
| `FMC_DOMAIN_UUID` | Domain UUID to scope to. If unset, resolved from the access-token claims (Global domain) | No | *(from token)* | `e276abec-e0f2-11e3-8169-6d9ed49b625f` |
| `FMC_CA_BUNDLE_PATH` | **Recommended TLS path.** Path to a PEM CA bundle trusting FMC's certificate. FMC is self-signed by default and provides no CA bundle mechanism of its own, so this is operator-supplied | No | — | `/etc/ftd-exporter/fmc-ca.pem` |
| `FMC_TLS_INSECURE_SKIP_VERIFY` | **INSECURE ESCAPE HATCH — lab/test only.** Disables certificate verification for FMC requests. Defaults to `false`; setting `true` emits a loud warning on every startup. **Never use in production** — it permits undetectable interception of credentials and metrics | No | `false` | `false` |
| `FMC_MAX_CONCURRENT_REQUESTS` | Concurrency cap for per-device requests. Validated against FMC's documented 10-connection-per-source-IP limit | No | `5` | `5` |
| `FMC_DISCOVERY_INTERVAL_SECONDS` | Device-inventory refresh cadence, independent of the metric poll | No | `900` | `900` |
| `FMC_METRIC_FAMILIES` | Comma-separated subset of `CPU,MEM,INTERFACE,DISK_STATS,CHASSIS_STATS`. Reduce to lower request volume on large fleets | No | all five | `CPU,MEM,INTERFACE,DISK_STATS` |
| `FMC_TIME_RANGE` | Averaging window: `5m` \| `15m` \| `30m` \| `1h` | No | `5m` | `5m` |

### 8.4 Exporter TLS listener (optional — see [§9.2](#92-the-exporters-own-metrics-endpoint))

| Variable | Purpose | Required | Default | Example / placeholder |
|---|---|---|---|---|
| `METRICS_TLS_CERT_PATH` | PEM certificate (chain) for the `/metrics` HTTPS listener. Enables TLS when set together with the key | No | — | `/etc/ftd-exporter/tls/tls.crt` |
| `METRICS_TLS_KEY_PATH` | PEM private key. Must be readable only by the service account | No | — | `/etc/ftd-exporter/tls/tls.key` |
| `METRICS_TLS_MIN_VERSION` | Minimum TLS version. `TLSv1.2` or `TLSv1.3` only — earlier versions are not offered | No | `TLSv1.2` | `TLSv1.2` |
| `METRICS_TLS_CLIENT_CA_PATH` | Enables mutual TLS: only clients presenting a certificate signed by this CA may scrape | No | — | `/etc/ftd-exporter/tls/client-ca.pem` |

### 8.5 Validation rules

Enforced at startup, exiting non-zero with an actionable message on any violation:

- `BACKEND_TYPE` must be exactly `scc` or `fmc`.
- All variables required for the selected backend must be present and non-empty. **Variables for the *other* backend, if set, produce a warning** — a strong hint that the operator edited the wrong block of `example.env`, which is a predictable and otherwise-baffling mistake.
- `SCC_BASE_URL` must parse as a URL with an `https:` scheme. **Plain `http:` is rejected** for any upstream URL ([§9.1](#91-encryption-in-transit-upstream)).
- `POLL_INTERVAL_SECONDS` must be a positive integer, and **on the SCC backend must be ≥ 30** (the 2-req/min limit). A lower value is a startup **error**, not a silent clamp.
- `SCC_TIME_RANGE` / `FMC_TIME_RANGE` must be one of the four permitted values.
- `FMC_MAX_CONCURRENT_REQUESTS` must be 1–10 inclusive.
- Every path-valued variable must exist and be readable at startup — failing at startup beats failing on the first poll 60 seconds later.
- `METRICS_TLS_CERT_PATH` and `METRICS_TLS_KEY_PATH` must be set together or not at all.
- `FMC_TLS_INSECURE_SKIP_VERIFY=true` **and** `FMC_CA_BUNDLE_PATH` set together is a configuration error — the combination means the operator believes they configured trust when verification is in fact off, which is the most dangerous possible misconfiguration.
- Startup logs the effective configuration with **all secrets redacted** ([§9.4](#94-credential-handling-and-redaction)).

---

## 9. Security

The exporter holds credentials that grant read access to a customer's firewall management plane and emits data describing their network topology. It is deployed by third parties into environments the authors will never see. The posture below is therefore treated as a functional requirement, not a hardening checklist appended at the end.

### 9.1 Encryption in transit (upstream)

- **All upstream API calls use HTTPS. There is no configuration option to disable this.** `http:` URLs are rejected during configuration validation.
- **TLS 1.2 minimum**, TLS 1.3 preferred, set explicitly via the `undici` Agent's `connect.minVersion` rather than left to whatever the runtime default happens to be across Node versions.
- **Cipher suites:** Node's secure defaults are used, with no operator override exposed. Rationale: a cipher-list configuration knob is far more likely to be used to *weaken* a deployment (pasted from a stale internet answer) than to strengthen one, and Node's defaults already exclude the weak suites. No RC4, no 3DES, no export ciphers, no anonymous or NULL suites — none of which are reachable via defaults on Node 24.
- **Certificate verification is on by default for every backend**, including hostname verification. The single exception is the explicitly-labeled FMC escape hatch in [§9.6](#96-certificate-trust-for-on-prem-fmc).
- Redirects are **not** followed automatically for authenticated requests, so credentials cannot be replayed to an unexpected host by an upstream misconfiguration or an attacker-influenced `Location` header.

### 9.2 The exporter's own `/metrics` endpoint

The question — native TLS listener or reverse proxy? — has a genuine answer that depends on deployment, so the design supports both and states a default recommendation.

**Recommendation: for typical Prometheus/Alloy deployments, terminate TLS at a reverse proxy, ingress, or service mesh, and run the exporter's listener as plain HTTP bound appropriately.** Reasons:

- In Kubernetes, this is already how nearly every exporter is deployed. Certificate lifecycle (issuance, rotation, renewal) is solved by cert-manager or the mesh; duplicating it inside a small exporter means reimplementing rotation, reload-on-change, and chain handling — all of which are easy to get subtly wrong.
- Service meshes (Istio, Linkerd) provide **mutual** TLS transparently, which is stronger than what the exporter would offer natively, and the exporter's own TLS would then be redundant double encryption.
- It keeps the exporter's code and configuration surface small, which is itself a security property.

**However, native TLS is supported**, because the recommendation does not fit everyone:

- Standalone deployments on a VM with no proxy in front — a very common shape for this tool, given it is often run on a jump host near the firewall.
- Scrapes crossing an untrusted network segment where a proxy is not available.
- Environments where a policy mandates encryption at the application listener regardless of the transport path.

Native TLS design:

- Enabled by setting `METRICS_TLS_CERT_PATH` **and** `METRICS_TLS_KEY_PATH`. Implemented with `node:https` — a small change from `node:http` given no framework is in use, which is part of why the framework-free choice in [§2.7](#27-technology-choices) pays off here.
- **TLS 1.2 minimum** (`METRICS_TLS_MIN_VERSION`), Node's default cipher suites, no downgrade option.
- **Optional mutual TLS** via `METRICS_TLS_CLIENT_CA_PATH`, which is the strongest available access control for a scrape endpoint and is straightforward for Prometheus and Alloy to configure client-side.
- Certificate reload requires a restart in v1. Documented plainly. Hot reload on file change is a reasonable v1.1 addition.

**Landing page at `/`.** A minimal HTML page naming the exporter and linking `/metrics`, per the Prometheus [instrumentation guidelines](https://prometheus.io/docs/practices/instrumentation/#things-to-watch-out-for)'s own recommendation — added 2026-08-04 so a human hitting the bare host:port (rather than `/metrics` directly) gets something more useful than a 404.

**Authentication on `/metrics`.** No bearer-token or basic-auth scheme is built in for v1. `/metrics` exposes device names, interface names, and topology-adjacent data — sensitive enough that it should not be internet-exposed, but not credential material. Access control belongs at the network layer (bind address, `NetworkPolicy`, firewall rules) or at the proxy/mesh, and mTLS is available for those who want cryptographic client authentication. Documented explicitly in the README so the absence reads as a decision rather than an omission, with the guidance: **do not expose `/metrics` to untrusted networks**, and prefer binding to a specific interface via `METRICS_BIND_ADDRESS` on multi-homed hosts.

### 9.3 Encryption at rest, and persistent state

**Decision: the exporter writes nothing to disk. No cache files, no state files, no token files, no log files.**

- The metrics cache is **in-memory only**, held in a single object replaced atomically on each successful poll.
- FMC access and refresh tokens are **in-memory only**, never persisted. A restart simply re-authenticates.
- Logs go to **stdout**, leaving retention and storage encryption to the platform (journald, Docker, Kubernetes) where the operator's existing controls already apply.

This makes the encryption-at-rest question largely disappear rather than needing to be solved, which is the strongest available answer. It is also what permits `readOnlyRootFilesystem: true` and `--read-only` in the container deployments ([§6.2](#62-container-hardening), [§7.2](#72-deployment-specifics)) — a security benefit that falls directly out of the architecture.

**On a future persistent cache for crash recovery:** occasionally proposed so a restart does not lose the last snapshot. **Recommendation against it for v1.** The benefit is one poll interval of data on an infrequent event; the cost is a plaintext file on disk containing device inventory and topology, plus a new class of file-permission and cleanup bugs. If it is ever implemented, the requirements are non-negotiable and recorded here so they are not rediscovered: **no credential or token material in the file under any circumstances; field-level encryption (AES-256-GCM) for any sensitive content; restrictive file permissions created atomically; and an explicit opt-in flag.** Avoiding the problem entirely remains the better engineering.

### 9.4 Credential handling and redaction

**Sources of credentials — env vars only.**

- All secrets arrive via environment variables, populated from a gitignored `.env` (standalone), `--env-file` (Docker), or a `Secret` (Kubernetes).
- **No credential is ever committed to the repository.** `.gitignore` must include `.env`, `.env.*` (excluding `example.env`), `*.pem`, `*.key`, `*.crt`, and `*.p12`. `example.env` contains placeholders only.
- **A CI secret-scanning check** (`gitleaks` or GitHub's native secret scanning + push protection) runs on every pull request. This is not paranoia: prior-art reference files in this repo's gitignored `data/` directory have contained live credentials in plaintext. The failure mode is demonstrated, not hypothetical.
- Secrets are read from `process.env` once at startup into a frozen config object. `process.env` values are **not** cleared afterwards — doing so is unreliable in Node and provides no real protection, since anything able to read process memory can read the config object too. Not claiming a protection that does not exist is preferable to security theater.

**Never logged, under any level, including `debug`.**

- **A redacting serializer sits at the logger boundary** and is the only sanctioned path to output. Placing redaction at the boundary rather than at call sites is deliberate: relying on every future contributor to remember is a design defect, and a single forgotten `logger.debug({ config })` would leak a token.
- Redaction covers, by key name (case-insensitive) and by pattern: `SCC_API_TOKEN`, `FMC_PASSWORD`, `authorization`, `x-auth-access-token`, `x-auth-refresh-token`, `password`, `token`, `secret`, `apikey`, `bearer`. Matched values are replaced with `[REDACTED]`.
- **Request headers are never logged wholesale.** Only an explicit allowlist of non-sensitive headers is logged, so a newly added auth header cannot leak by default. Allowlist-not-denylist is the important detail here.
- **Error objects and stack traces are sanitized before logging.** This is the most commonly missed leak path: HTTP client libraries routinely attach the full request — headers included — to thrown errors, so an unhandled rejection can print a bearer token into the log. The design requires errors to pass through a normalizer that extracts only method, sanitized URL, status code, and message, and never serializes an error's arbitrary attached properties.
- **URLs are sanitized before logging** (query-string values redacted), because credentials sometimes end up in query parameters and because the FMC filter string embeds device UUIDs.
- **The startup configuration summary is generated from a redaction-aware formatter**, and there is no code path that prints the raw config object.
- **Unit tests assert redaction**, including a test that feeds a realistic error object carrying an `Authorization` header through the logger and asserts the token does not appear in the output. Redaction that is not tested is redaction that will regress.

**Rejected alternative: token-in-query-parameter authentication.** Some comparable exporters (e.g. `fortigate_exporter`) support passing the upstream API token as a URL query parameter, with their own documentation carrying explicit warnings against it (visible in server access logs, visible in browser history, visible to any intermediate proxy that logs full URLs). This design does not offer that option at all: both backends authenticate via header (`Authorization: Bearer` for SCC, a session token header for FMC), and there is no configuration path that would put a credential into a URL. Recorded here so the omission reads as a deliberate rejection, not an oversight.

### 9.5 Least-privilege API accounts

- **SCC: a Read-only API-only user is sufficient and recommended.** The exporter issues GETs exclusively. Edit-capable tokens work but grant unnecessary authority; `example.env` recommends Read-only explicitly.
- **FMC: a dedicated API-only service account is required**, both for least privilege and because of Cisco's documented UI/API session conflict ([§3.3.2](#332-authentication-and-the-fmctokenmanager)). Where the customer's FMC role model permits a read-only role, the docs recommend it; where it does not, the docs should say so plainly rather than implying a control that may not exist on the customer's version.
- **Token rotation:** SCC tokens never expire, so nothing forces hygiene. The docs recommend periodic manual rotation (e.g. every 90 days), clearly labeled as an operational best practice rather than an API requirement — and note that rotation is a zero-downtime operation for this exporter (update the secret, restart, done).
- **The exporter must never issue a non-GET request.** Enforced in the HTTP client layer, which exposes only a `get()` method, so a write is not merely discouraged but unrepresentable. This also means the exporter can never trip FMC's one-concurrent-write-per-device limit.

### 9.6 Certificate trust for on-prem FMC

FMC ships a **self-signed certificate** by default, and Cisco's own guide tells users to manually accept it. There is **no FMC-side mechanism for providing a proper CA bundle** — trust is entirely a client-side problem, and the exporter must solve it well.

**The correct path (recommended, documented first, and in every example): `FMC_CA_BUNDLE_PATH`.**

- The operator supplies a PEM file containing the FMC's certificate (if self-signed) or their internal CA chain (if issued by an internal PKI).
- Loaded into the TLS context as the trust anchor for FMC requests **only** — not into a global trust store. Scoping matters: `NODE_EXTRA_CA_CERTS` would trust that CA for every connection the process makes, and this is precisely why `undici` was chosen over global `fetch` in [§2.7](#27-technology-choices).
- **Full certificate and hostname verification remain active.** This is real verification against an operator-chosen anchor, not verification bypass — the security property is preserved, only the trust root changes.
- Because hostname verification applies, `FMC_HOST` should be the name in the certificate's SAN. The docs must call this out, since using an IP against a hostname-only certificate is the most likely cause of a puzzling verification failure, and the temptation is then to reach for the escape hatch.
- Documentation includes how to obtain the certificate for the bundle (`openssl s_client -connect <fmc>:443 -showcerts`), with a warning to verify the fingerprint out-of-band against the FMC UI before trusting it — otherwise the operator is trusting whatever answered, which is the very attack the bundle is meant to prevent.

**The escape hatch (explicitly insecure, lab/test only): `FMC_TLS_INSECURE_SKIP_VERIFY`.**

- Defaults to `false`.
- When `true`, the exporter logs a **loud multi-line warning at `error` severity on every startup**, naming the specific risk: FMC credentials and all metrics data are exposed to undetectable interception.
- Also surfaced as a metric — `ftd_exporter_tls_verification_disabled 1` — so it is **visible in the monitoring system itself** and alertable by a security team. This is the design's most useful anti-drift control: a warning in a startup log scrolls away in five minutes, whereas a metric persists and can be alerted on fleet-wide. It directly addresses the realistic failure mode where a lab setting quietly survives into production.
- `example.env` labels it unambiguously (`# INSECURE — lab/test only. Never set true in production.`), and the README documents the CA bundle path first and at greater length, so the secure path is the path of least resistance.
- **Setting it alongside `FMC_CA_BUNDLE_PATH` is a configuration error** ([§8.5](#85-validation-rules)) — that combination means the operator believes they have configured trust while verification is actually off.
- **It never applies to the SCC backend.** SCC uses public CA-issued certificates; there is no legitimate reason to disable verification, and offering the option would only create risk. The variable is deliberately named `FMC_`-prefixed for this reason.

### 9.7 Dependency and supply-chain hygiene

- **Minimal dependency count is a security control**, not an aesthetic preference: two runtime dependencies (`prom-client`, `undici`), both widely used and actively maintained, with `undici` being the same HTTP stack already inside Node.
- **`package-lock.json` is committed**, and CI uses `npm ci` exclusively so builds are reproducible and a compromised or drifted transitive version cannot slip in.
- **`npm audit` runs in CI**, failing the build on high or critical advisories in production dependencies.
- **Dependabot** (or Renovate) is enabled for dependency and GitHub Actions updates, with grouped minor/patch PRs to keep review load sane.
- **CI workflows pin actions to commit SHAs**, not floating tags — tag-mutation is a demonstrated attack path against GitHub Actions.
- **`npm publish --provenance`** for the npm package, and **build provenance attestation plus an SBOM** for the container image (`actions/attest-build-provenance`, verifiable with `gh attestation verify oci://ghcr.io/apilbeam101/ftd-metrics-exporter:<tag> -R apilbeam101/ftd-metrics-exporter`), so consumers can verify what they are running was built from the tagged source by the project's CI.
- **`.npmignore`/`files` in `package.json` is an allowlist**, so a stray local `.env` or fixture containing real data cannot be published in a tarball. Allowlist rather than denylist, for the same reason as the header logging rule.
- **No `postinstall` or other lifecycle scripts** in the published package. Lifecycle scripts are a well-known supply-chain vector, and a customer security team should be able to install this package with `--ignore-scripts` and have it work.
- **Fixtures committed for testing must be sanitized** — real device names, UIDs, and IPs from the live verification sample are replaced with synthetic values before being committed. Test data is a real and frequently overlooked leak path.

---

## 10. Grafana dashboard design

A companion dashboard is part of the deliverable, because "here are 40 metric names, good luck" is not a usable way to hand this off to an operator. The exact **JSON model is an implementation-phase deliverable**; this section specifies its structure and content.

### 10.1 Approach

- A single dashboard JSON at `dashboards/ftd-health.json`, importable via Grafana's UI or provisioned as a `ConfigMap`/sidecar.
- **Prometheus datasource templated as a `datasource` variable** (`${DS_PROMETHEUS}`) so it imports cleanly into any Grafana without hand-editing — a common friction point in shared dashboards.
- All queries are **PromQL**, built fresh around the operational questions that matter for FTD fleet health: current CPU/memory/disk pressure, interface error/drop rates, HA state, and VPN tunnel/session counts, expressed idiomatically for Prometheus-sourced data.
- **Template variables:** `device` (multi-select, from `label_values(ftd_cpu_usage_ratio, device_name)`, with an `All` option), `interface` (multi-select, dependent on `device`), and `job`/`instance` for multi-exporter setups.
- Panels must **degrade gracefully when conditional metric groups are absent** — a fleet of appliances with no chassis, HA, or VPN should not show a wall of "No data" errors. Rows for conditional groups use Grafana's row-level repeat/hide behavior or carry explicit "not applicable to this platform" panel descriptions. This follows directly from the sparse-group design in [§4.8](#48-handling-conditional-and-sparse-metric-groups) and is easy to get wrong.

### 10.2 Panel structure

**Row 1 — Fleet overview (collapsed detail, at-a-glance health)**

- Stat panels: total devices reporting, devices with an unhealthy signal, count of down interfaces fleet-wide, count of down S2S tunnels.
- **Exporter health**: `ftd_exporter_up`, time since last successful poll, poll error rate. Placed **first and prominently**, because a dashboard that looks green while the exporter is dead is the worst possible outcome and the most common exporter-dashboard failure.
- Table: per-device summary — name, system CPU %, system memory %, disk %, HA role/status, link-down count — with cell coloring by threshold. This is the single most useful panel for daily use and should be the visual anchor of the dashboard.

**Row 2 — CPU and memory**

- Timeseries: CPU by device, one series per `component` (`lina`/`snort`/`system`), repeated per selected device. Splitting Lina and Snort is the point — a Snort spike and a Lina spike mean different things and demand different responses.
- Timeseries: memory, same shape.
- Gauges: current system CPU % and memory % per device, thresholds at 70/85 (documented as defaults for operators to adjust).
- Top-N bar gauge: highest-CPU devices, for fleets too large to eyeball.

**Row 3 — Disk**

- Gauge per device: `ftd_disk_usage_ratio` (Grafana panel unit `percentunit`, which composes directly with a 0–1 ratio), thresholds at 0.75/0.90.
- Timeseries: disk usage trend, which is where slow-growth problems are visible.

**Row 4 — Interfaces**

- Timeseries: input/output throughput per interface (`ftd_interface_input_bytes_avg` / `ftd_interface_output_bytes_avg`), negative-Y styling for output to give the conventional mirrored throughput view.
- Timeseries: input/output errors and drops per interface. Errors and drops are separated from throughput deliberately — mixing them on one axis hides small-but-significant error counts under large byte values.
- Timeseries: buffer overruns/underruns and L2 decode drops. Low-level indicators worth their own panel, since they usually point at a physical or driver-level problem rather than a policy one.
- State-timeline: `ftd_interface_link_up` and `ftd_interface_operational_up` per interface — flap history at a glance, which a gauge cannot show.
- Table: current interface inventory and status, including down/unused interfaces (which are exported by design, [§4.2](#42-metric-catalog-scc-backend-v1)), with `interface`, `interface_name`, `interface_type`.
- Panel description notes the unit ambiguity from [§14](#14-open-questions-risks-implementation-phase-unknowns) until it is resolved, so nobody misreads the axis.

**Row 5 — High availability (conditional)**

- State-timeline: `ftd_ha_node_status` per device — the state-set representation from [§4.4](#44-representing-status-enums) maps directly onto this panel type, which is a large part of why that representation was chosen.
- Stat: current HA role per device, from `ftd_ha_node_info`.
- Panel description explains the row is empty for devices not in an HA pair, and that this is expected rather than a fault.

**Row 6 — VPN (conditional)**

- Timeseries: active/inactive RA VPN sessions per device, with peak concurrent overlaid.
- Stat: current active session count, with a threshold against the platform's session capacity (operator-configured, since capacity is model-dependent).
- Table/state-timeline: S2S tunnel state by `tunnel_name`, filtered to non-up by default so the panel shows problems rather than a wall of green.
- Stat: count of tunnels currently down — the number an operator actually wants at 3am.

**Row 7 — Chassis (conditional, chassis hardware only)**

- Timeseries: fan RPM by `fan` label.
- Stat panels: PSU input/output/fan status per PSU, colored red on 0.
- Description notes the row applies only to chassis-based platforms and is expected to be empty on appliances such as the FTD 1010.

**Row 8 — Data freshness and diagnostics**

- Timeseries: `time() - ftd_health_window_end_timestamp_seconds` per device — per-device staleness, which catches "this one device stopped reporting" while everything else looks fine. This panel is the reason the window timestamps are exported at all ([§4.5](#45-sample-window-timestamps)).
- Timeseries: exporter poll duration, poll error rate by reason, upstream request rate.
- Stat: `ftd_exporter_tls_verification_disabled` — a red indicator if any exporter instance is running with verification off ([§9.6](#96-certificate-trust-for-on-prem-fmc)).

### 10.3 Accompanying alert rules

A companion `alerts/ftd-health.yaml` of Prometheus alerting rules is a recommended implementation-phase deliverable, since the dashboard tells operators what to look at and alerts tell them when to look. Candidate rules:

| Alert | Expression sketch | Severity |
|---|---|---|
| `FtdExporterDown` | `ftd_exporter_up == 0` for 5m | critical |
| `FtdExporterStale` | `time() - ftd_exporter_last_successful_poll_timestamp_seconds > 300` | warning |
| `FtdDeviceMetricsStale` | `time() - ftd_health_window_end_timestamp_seconds > 900` | warning |
| `FtdHighCpu` | `ftd_cpu_usage_ratio{component="system"} > 0.85` for 15m | warning |
| `FtdHighMemory` | `ftd_memory_usage_ratio{component="system"} > 0.90` for 15m | warning |
| `FtdDiskNearFull` | `ftd_disk_usage_ratio > 0.90` | critical |
| `FtdInterfaceDown` | `ftd_interface_operational_up == 0` on a named interface for 5m | warning |
| `FtdInterfaceErrors` | `ftd_interface_input_errors_avg > 0` sustained | warning |
| `FtdHaNotNormal` | `ftd_ha_node_status{status="normal"} == 0` for 5m | critical |
| `FtdS2sTunnelDown` | `ftd_s2s_tunnel_state{state="down"} == 1` for 10m | warning |
| `FtdChassisPsuFailure` | `ftd_chassis_psu_input_up == 0 or ftd_chassis_psu_output_up == 0` | critical |
| `FtdExporterInsecureTls` | `ftd_exporter_tls_verification_disabled == 1` | warning |

Interface-down alerting should default to interfaces with a real `interface_name` (i.e. configured/named ones), since unused interfaces are legitimately down and would otherwise generate constant noise — a direct and predictable consequence of exporting all interfaces.

---

## 11. Observability of the exporter itself

Exporters that do not monitor themselves fail silently: the last-known gauge values persist, dashboards stay green, and nobody discovers the outage until someone needs the data. This is a common design miss and is treated here as a first-class requirement.

The exporter exposes its own metrics on the **same `/metrics` endpoint**, under the `ftd_exporter_` prefix:

| Metric | Type | Purpose |
|---|---|---|
| `ftd_exporter_up` | gauge 1/0 | 1 if the most recent poll cycle succeeded. The primary binary health signal. **Semantic note:** the conventional Prometheus `_up` metric means "was the last scrape of the *target* successful" — this exporter's own `up` means "did the last poll *cycle* succeed," a subtly different claim, since a healthy exporter serving a 10-minute-old cache still reports `up 1` if the poll itself hasn't failed yet, and conversely reports `up 0` while still serving a perfectly usable cached snapshot. `ftd_exporter_cache_age_seconds` and `ftd_exporter_last_successful_poll_timestamp_seconds` are the metrics that answer "how stale is what I'm actually serving," and should be read alongside `up`, not assumed redundant with it |
| `ftd_exporter_build_info` | gauge (=1) | Labels: `version`, `commit`, `node_version`, `backend`. Answers "what is actually running" in a support case |
| `ftd_exporter_last_successful_poll_timestamp_seconds` | gauge | Unix timestamp of last success. Staleness alerting |
| `ftd_exporter_cache_age_seconds` | gauge | Age of the served snapshot, computed at scrape time |
| `ftd_exporter_poll_duration_seconds` | histogram | Poll cycle latency. Reveals a degrading upstream before it fails outright |
| `ftd_exporter_poll_total` | counter | Total poll cycles attempted |
| `ftd_exporter_poll_errors_total` | counter | Labels: `reason` (`auth`, `rate_limited`, `timeout`, `network`, `http_5xx`, `parse`, `unknown`). Bounded label set, deliberately |
| `ftd_exporter_upstream_requests_total` | counter | Labels: `endpoint` (templated, **never** with UUIDs interpolated), `status_code` |
| `ftd_exporter_upstream_request_duration_seconds` | histogram | Labels: `endpoint`. Distinguishes "Cisco is slow" from "we are slow" |
| `ftd_exporter_devices` | gauge | Devices in the current snapshot. A sudden drop signals a discovery or pagination bug |
| `ftd_exporter_devices_discovered` | gauge | FMC backend: devices found by discovery. Compare against `_devices` to spot per-device failures |
| `ftd_exporter_discovery_errors_total` | counter | FMC backend: discovery failures |
| `ftd_exporter_series` | gauge | Series currently rendered. Cardinality tripwire, especially for S2S tunnels |
| `ftd_exporter_parse_errors_total` | counter | Labels: `group`. Schema drift in the upstream API becomes visible instead of silent |
| `ftd_exporter_unknown_enum_total` | counter | Labels: `metric`, `value`. Catches new Cisco enum values ([§4.4](#44-representing-status-enums)) |
| `ftd_exporter_fmc_token_refreshes_total` | counter | FMC backend: token refreshes |
| `ftd_exporter_fmc_token_reauths_total` | counter | FMC backend: full re-authentications (expected roughly every 2 hours given 30m × 4) |
| `ftd_exporter_fmc_token_expiry_timestamp_seconds` | gauge | FMC backend: current token expiry. Makes the token lifecycle debuggable rather than mysterious |
| `ftd_exporter_tls_verification_disabled` | gauge 1/0 | 1 if the insecure escape hatch is active. Security-visible and alertable ([§9.6](#96-certificate-trust-for-on-prem-fmc)) |
| `ftd_exporter_rate_limit_deferrals_total` | counter | Times a request was delayed by the internal limiter. Confirms rate-limit protection is working, and reveals over-aggressive configuration |

Notes:

- **Default Node.js process metrics** (`process_cpu_seconds_total`, `nodejs_heap_size_used_bytes`, etc.) are collected via `prom-client`'s `collectDefaultMetrics()`, gated behind `ENABLE_DEFAULT_METRICS` (default `true`). They are how a memory leak in the exporter itself would be caught.
- **`endpoint` labels use templated paths** (`/v1/inventory/managers/:fmcUid/health/metrics`), never interpolated UUIDs — interpolating identifiers into label values is a classic cardinality explosion.
- **`/healthz`** (process liveness) and **`/readyz`** (cache populated) are separate from `/metrics` so container orchestrators do not need to parse exposition format, and so a liveness probe never depends on upstream API health ([§7.2](#72-deployment-specifics)).

---

## 12. Testing strategy

Design-level; specific cases are implementation-phase work. The guiding principle: **the response-mapping layer is where the real complexity and risk live, and it is pure, so it should carry the bulk of the test weight.**

### 12.1 Unit tests

- **Response mapping (highest priority).** `SccHealthMetricsResponse → DeviceHealthSnapshot[]` and the snapshot→exposition renderer are pure functions tested against committed fixture JSON. Required cases, derived directly from confirmed live behavior:
  - The **full live sample** captured during research (sanitized), as the primary fixture.
  - **Every conditional group absent** — the FTD 1010 case. Asserts that no `ftd_ha_*`, `ftd_chassis_*`, `ftd_ravpn_*`, or `ftd_s2s_*` series are emitted at all, and specifically **not emitted as zero** ([§4.8](#48-handling-conditional-and-sparse-metric-groups)).
  - **Every conditional group present** — a synthetic chassis-based HA device with RA VPN and S2S tunnels.
  - **Interfaces with `interfaceName` absent** — asserts the fallback to the hardware `interface` id.
  - **All-zero interfaces** — asserts they are exported, not filtered.
  - **Genuine zero values** — asserts a real `0` CPU reading is emitted, not dropped by a truthiness check. This is the specific bug class the strict-undefined rule exists to prevent.
  - **Unknown enum values** — asserts mapping to `unknown` plus counter increment.
  - **Malformed or unexpected types** — asserts the affected device/group is skipped while the rest of the snapshot survives.
- **Configuration validation.** Every rule in [§8.5](#85-validation-rules), including the SCC 30 s floor, the mutually-exclusive TLS-trust error, and cross-backend variable warnings.
- **Redaction.** Asserts tokens, passwords, and auth headers never reach output — **including via a realistic error object with an attached `Authorization` header**, which is the leak path most likely to regress ([§9.4](#94-credential-handling-and-redaction)).
- **`FmcTokenManager`.** Uses a fake clock. Asserts proactive refresh timing, the **3-refresh ceiling triggering full re-auth**, single-flight behavior under concurrent callers, and 401-triggered re-auth-and-retry. This component's state machine is the most intricate logic in the project and is fully testable without a network.
- **Rate limiter and concurrency limiter.** Fake clock. Asserts the SCC 30 s minimum spacing holds even under retries, and that FMC concurrency never exceeds the configured cap.
- **FMC filter-string builder.** Asserts exact `device_uuid:<uuid>;metric:<name>;timeRange:<range>` construction and encoding — a small function with an unusual format and therefore a likely bug site.
- **`SCC_TIME_RANGE` propagation.** An explicit test that the configured value reaches the request query string — the class of bug where a variable is validated but its value is then never actually used.

### 12.2 Integration tests

- **Against a mock HTTP server**, not live Cisco infrastructure. Node's `node:http` is sufficient to stand up a fixture-serving stub; `undici`'s `MockAgent` is an even lighter option for client-level interception.
- Scenarios: full poll-cache-serve cycle end to end; `/metrics` output validated as parseable exposition format; `429` handling and backoff; `401` triggering FMC re-auth; upstream failure serving stale cache with `ftd_exporter_up 0`; FMC pagination across multiple pages (**including the >25-device case that a naive implementation truncates**); partial device failure producing a partial snapshot.
- **Series disappearance:** poll a snapshot with device B, then one without it, and assert B's series are gone from `/metrics` — the `gauge.reset()`/custom-collector behavior from [§4.8](#48-handling-conditional-and-sparse-metric-groups). Easy to get wrong, invisible in production until someone notices a decommissioned device still reporting.
- **TLS behavior:** a self-signed mock server verifies that a CA bundle enables success, that verification failure occurs without it, and that the insecure flag bypasses it — proving all three paths behave as designed.

### 12.3 What is explicitly not tested in CI

- **No live-credential tests, ever.** No CI job holds an SCC token or FMC password. Live verification is a manual, documented pre-release step run by a maintainer against their own infrastructure, with results recorded in the release checklist. Rationale: CI secrets in a public repository are a standing exfiltration target (particularly via pull requests from forks), and the value of live tests does not come close to justifying it.
- **No tests requiring specific hardware.** Chassis, HA, and VPN paths are covered by synthetic fixtures, since the maintainers may have no chassis-based device at all.

### 12.4 CI matrix and checks

- **OS matrix: `ubuntu-latest`, `macos-latest`, `windows-latest`** — non-negotiable given the cross-platform requirement (G4/G2). A Windows-only path-handling bug is otherwise found by a user, not by CI.
- **Node matrix: 24 and current**, so a runtime regression surfaces before a customer hits it.
- Checks: type-check (`tsc --noEmit`), lint, unit tests, integration tests, `npm audit`, secret scanning, license compliance of dependencies, and a **check that installation produces no native build step** (guarding the no-native-addons rule from [§5.1](#51-packaging-approach)).
- Docker image build (multi-arch) on pull requests, published only on tags.

---

## 13. Repository hygiene and release process

Called out because this project ships to third parties, who will judge whether to trust it partly on these signals. The **files themselves are implementation-phase deliverables**; this section specifies what must exist and why.

| Item | Requirement |
|---|---|
| `README.md` | Purpose; a quick-start per deployment method with **the three paths clearly separated so a user reads only theirs**; full configuration table; metric reference; troubleshooting (leading with the health-policy prerequisite and the FMC UI/API session conflict); security notes; **explicit statement that chassis, HA, and VPN metrics are experimental in v1 on both backends** |
| `LICENSE` | **Apache-2.0 recommended.** Permissive like MIT but adds an explicit patent grant and contribution terms, which matters for a tool in the network-security space that enterprises will vet. MIT is the fallback if the team prefers brevity. |
| `CONTRIBUTING.md` | Dev setup, how to run tests, coding standards, **how to contribute sanitized fixtures** (the mechanism for community-solving the FMC schema unknown, [§3.3.5](#335-known-unknown-response-body-field-names)), commit conventions, DCO or CLA decision |
| `CODE_OF_CONDUCT.md` | Contributor Covenant |
| `SECURITY.md` | Private vulnerability reporting (GitHub Security Advisories), supported-versions statement, response-time expectations. Essential for a tool that handles firewall credentials |
| `CHANGELOG.md` | Keep-a-Changelog format, maintained per release |
| `example.env` | Every variable, with purpose and acquisition instructions. **Placeholders only** ([§8](#8-configuration-reference)) |
| `.gitignore` | `.env`, `.env.*` (except `example.env`), `*.pem`, `*.key`, `*.crt`, `dist/`, `node_modules/` |
| `.dockerignore` | `.env`, `.git`, `node_modules`, `dist` — load-bearing, prevents baking a secret into an image layer |
| `.github/workflows/` | CI ([§12.4](#124-ci-matrix-and-checks)), release automation, Dependabot config, actions pinned to SHAs |
| Issue/PR templates | Bug report template requesting `ftd_exporter_build_info` labels, backend type, and **redacted** logs |
| `deploy/` | Kubernetes manifests, `docker-compose.yml`, systemd unit, launchd plist, Windows service notes |
| `dashboards/` | `ftd-health.json` ([§10](#10-grafana-dashboard-design)) |
| `alerts/` | `ftd-health.yaml` Prometheus rules ([§10.3](#103-accompanying-alert-rules)) |

**Versioning: strict semantic versioning**, with the public API defined explicitly as **metric names, metric labels, and environment variable names** — not the TypeScript interfaces. This is the right contract for an exporter, since that is what breaks users' dashboards and alerts.

- **Major:** renaming or removing a metric or label; renaming or removing an env var; raising the Node floor.
- **Minor:** new metrics, new optional env vars, new backend capabilities.
- **Patch:** bug fixes that do not change the metric surface.
- **The `chassisStatsHealthMetrics`, `haHealthMetrics`, `raVpnSessionHealthMetrics`, and `s2sVpnTunnelHealthMetrics` groups are documented as experimental in 1.x on both backends**, meaning their metric names may change in a minor release while their response mapping is validated against real deployments ([§3.3.5](#335-known-unknown-response-body-field-names)). Stating this up front is honest and preserves the ability to fix mistakes; discovering the need for it after 1.0 would be painful. CPU, memory, disk, and interface metrics are stable on both backends as of this verification.
- Pre-1.0 releases (`0.x`) during initial development, with 1.0 cut once the SCC backend is validated in at least one third-party deployment.
- Releases are **tagged, with GitHub Releases carrying changelog entries**, and CI publishes the npm package and container image with provenance ([§9.7](#97-dependency-and-supply-chain-hygiene)).

---

## 14. Open questions, risks, implementation-phase unknowns

Listed explicitly because pretending these are settled would be the most damaging thing this document could do. Items marked **must resolve** block a stable release of the affected backend.

### 14.1 Standalone FMC response body field names — **resolved for all five metric families**

**Cisco's official FMC REST API guide (v10.0, November 2025) contains no example response bodies for any health endpoint.** Paths, filter syntax, and parameter vocabularies are documented; payload structures are not.

- **Resolved by live verification (lab FMC, 10.0.0, four FTDv devices) for `CPU`, `MEM`, `DISK_STATS`:** field names are **identical to SCC** — `cpuHealthMetrics: { linaUsageAvg, snortUsageAvg, systemUsageAvg }`, `memoryHealthMetrics: { linaUsageAvg, snortUsageAvg, systemUsageAvg }`, `diskHealthMetrics: { totalDiskUsageAvg }`. See [Appendix C](#appendix-c-confirmed-fmc-response-schema-partial) for the full sanitized sample and wrapper shape, which differs from SCC's (single-device/single-family `items[]` wrapper vs SCC's flat per-device array).
- **Resolved by live verification for `INTERFACE`, once `hm_ifconfig` was enabled on the lab device's health policy:** the wrapper key is **`interfaceHealthMetricsList`, not `interfaceHealthMetrics`** — a genuine naming difference from SCC, not just an unconfirmed assumption. Per-interface fields are also **not** identical to SCC: FMC uses `currentLinkStatus`/`currentOperationalStatus` where SCC uses `linkStatus`/`operationalStatus`, and FMC additionally reports `duplexMode` populated (`"FULL"` observed on every interface) where SCC's Appendix B noted it as "documented; not observed in the live sample." See [Appendix C](#appendix-c-confirmed-fmc-response-schema-partial) for the full sample. **This is exactly the kind of asymmetry §14.1 existed to catch** — a naive adapter reusing SCC's field names verbatim against FMC would silently produce empty series.
- **`CHASSIS_STATS` returned empty on the lab devices** — expected, since they are FTDv (no chassis hardware) despite `hm_chassis_status_ftd` being enabled; this is capability-based absence, consistent with the SCC-side finding, not a schema gap. Still unresolved for chassis-based hardware.
- **Format deviation found:** `startTime`/`endTime` in the FMC response are **not ISO 8601** (`"2026-07-31 08:50:36.550 UTC"`), unlike the ISO 8601 format confirmed for SCC in [Appendix B](#appendix-b-confirmed-scc-response-schema). The FMC adapter's parser must not assume a shared timestamp format across backends.
- **Mitigations already in the design:** `chassisStatsHealthMetrics`, `haHealthMetrics`, `raVpnSessionHealthMetrics`, and `s2sVpnTunnelHealthMetrics` remain marked **experimental** in v1 ([§13](#13-repository-hygiene-and-release-process)) on both backends until captured with populated data; a `--dump-raw` capture mode lets third parties contribute fixtures without sharing credentials ([§3.3.5](#335-known-unknown-response-body-field-names)); the adapter boundary means this uncertainty cannot contaminate the now-verified `CPU`/`MEM`/`DISK_STATS`/`INTERFACE` mappings on either backend.
- **Open sub-question resolved:** FMC's `aggregatemetrics` response **does** break CPU and memory into Lina/Snort/System sub-components, matching SCC. No `component`-label asymmetry between backends for these two families.
- **Still open:** `haHealthMetrics`, `raVpnSessionHealthMetrics`, `s2sVpnTunnelHealthMetrics` field names on FMC were not captured — no device in the lab is configured for HA or VPN. §14.2 (which of FMC's two interface-stats sources is authoritative) is also still open — see below; it did not block resolving field names for the health-family path.

### 14.2 Which interface-statistics source on FMC is authoritative — **must resolve**

Two distinct paths return interface data on standalone FMC:

- `/health/aggregatemetrics` with `metric:INTERFACE` (health family)
- `/devices/devicerecords/{containerUUID}/fpinterfacestatistics` (device-record family)

It is unestablished which is richer, which is more current, whether they agree, or whether one is deprecated. **Resolution:** query both against a live FMC and compare field sets and freshness. Until then the design assumes the health family for consistency with the other metric groups, and this assumption is recorded as an assumption rather than a conclusion.

**Partial finding:** `GET /devices/devicerecords/{containerUUID}/fpinterfacestatistics?expanded=true` returned `400 Unsupported device` against the lab's FTDv devices, both before and after `hm_ifconfig` was enabled — the health-policy state has no bearing on this endpoint's availability. Whether this is an FTDv-specific limitation (i.e. the device-record family only supports appliance/chassis-based hardware) or something else entirely is not established from a single negative result on one platform type. The health family (`/health/aggregatemetrics`) remains the only one that has produced real interface data in this research, which strengthens — but does not by itself confirm — the design's working assumption. Still needs a comparison against chassis-based hardware where both paths are more likely to succeed.

### 14.3 Chassis data overlap on FMC and SCC

Unclear whether `/chassis/fmcmanagedchassis/{containerUUID}/...` (`faultsummary`, `interfacesummary`, `inventorysummary`) overlaps with, supersedes, or complements the `CHASSIS_STATS` health metric family — and likewise on SCC, whether `/chassis/fmcmanagedchassis/{objectId}` duplicates `chassisStatsHealthMetrics`. Affects whether the backlog chassis-detail item is worth building. **Resolution:** empirical comparison against chassis-based hardware, which the maintainers may not have — a good candidate for a community contribution request.

### 14.4 Interface byte-counter units and semantics

It is not established whether `inputBytesAvg`/`outputBytesAvg` are **bytes per second** or **total bytes averaged over the window**, nor whether the error/drop `*Avg` fields are rates or window-averaged absolute counts.

- **Impact:** metric naming (`_bytes_avg` vs `_bytes_per_second`) and dashboard axis units. Renaming later is a **breaking change** under the versioning policy, so the neutral `_avg` naming is deliberately conservative ([§4.2](#42-metric-catalog-scc-backend-v1)).
- **Resolution:** generate known traffic volumes against a test device and compare reported values across `5m` and `1h` `timeRange` values — if the value is unit-consistent across window sizes it is a rate; if it scales, it is a total.

### 14.5 FMC `/health/metricconfiguration` behavior — **resolved: not relevant to this exporter**

New in FMC 10.0 and **undocumented in Cisco's own guide**, whose description field renders literally as `[DEV ERROR: Missing description]`. The guessed path (`/health/metricconfiguration`) 404s on a live FMC; the real endpoint, found by pulling the live FMC's own Swagger spec (`GET /api/api-explorer/fmc.json`, unauthenticated-path but token-gated response), is `/api/fmc_config/v1/domain/{domainUUID}/integration/aiops/metricconfiguration` — under `integration/aiops/`, not `health/`.

- **Confirmed unrelated to health-policy metric collection or `/health/aggregatemetrics`.** It is part of Cisco's **AI Ops integration**: FMC runs an onboard Prometheus instance, and this API family (`aiops/configure`, `aiops/metricconfiguration`, `aiops/tsdbupload`, `aiops/tsdbupload/status`) controls whether that instance's TSDB blocks are periodically uploaded to a Cisco-cloud S3 bucket for remote AI Ops analysis — enable/disable, `tenantUuid`, `remoteWriteConfig`, per-device scoping via `deviceUuids`. Nothing here gates or reshapes what `/health/aggregatemetrics` returns.
- **Live `GET` on this lab FMC returned `405 Operation not supported`** even with the documented `offset`/`limit`/`expanded` parameters — consistent with a feature that requires cloud AI Ops enrollment/licensing this lab instance doesn't have, not a request-syntax issue.
- **No design impact.** Confirms the original "deliberately not designed around in v1" call was correct, for a more specific reason than assumed: it's a different feature area entirely, not an unexplored control surface over the metrics this exporter polls.

### 14.6 Whether SCC's health-policy gating produces absent groups or zero values

The design assumes a metric group not collected by health policy is **absent** (matching the confirmed capability-based absence in the live sample). It is not confirmed that policy-based non-collection behaves identically to capability-based absence — it is conceivable that policy-disabled metrics appear as zeros or nulls instead, which would be actively misleading. **Resolution:** disable a metric in a test device's health policy and observe. Material because zeros-for-not-collected would defeat the sparse-group correctness described in [§4.8](#48-handling-conditional-and-sparse-metric-groups).

**Resolved on the FMC side.** A lab FMC device's assigned "Device Health Policy" had the `hm_ifconfig` module (interface monitoring) disabled. Querying `INTERFACE` for that device returned `{"paging":{"count":0}}` — an empty result set, not zero-valued rows or an error. **Policy-disabled metrics are absent, not zero**, confirming the design's assumption.

**Resolved on the SCC side, with a propagation-delay caveat worth documenting.** CPU data collection was disabled in a live device's health policy and deployed in the SCC UI, which surfaced the warning *"Data collection for CPU module is disabled in the health policy, partial or no data may be shown."* Two live `GET`s against `/health/metrics` (5 minutes apart, respecting SCC's 2 req/min limit):

- **Immediately after deploy:** `cpuHealthMetrics` was still present with normal non-zero values (`linaUsageAvg`, `snortUsageAvg`, `systemUsageAvg` all populated) — the policy change had not yet propagated to the metrics API.
- **~5 minutes later:** `cpuHealthMetrics` was **absent as a key** entirely — not present as `null`, not zeroed — while `memoryHealthMetrics`, `diskHealthMetrics`, and `interfaceHealthMetrics` remained present and populated on the same device/response.

**Confirms the design's absence assumption on both backends**, but surfaces a real operational detail not previously documented: **a health-policy change is not immediately reflected in the metrics API on SCC.** There is a propagation window (observed: under 5 minutes) between deploying a policy change and the corresponding metric group disappearing from `/health/metrics`. This matters for anyone testing or troubleshooting policy-gated absence — checking immediately after a deploy risks a false negative ("it's still there, so gating must not work"). Worth a note in the troubleshooting section of the eventual README ([§13](#13-repository-hygiene-and-release-process)) alongside the existing health-policy prerequisite guidance ([§3.2.5](#325-health-policy-prerequisite)).

**Side finding while investigating this:** the health-policy configuration endpoint is `GET /api/fmc_config/v1/domain/{domainUUID}/policy/healthpolicies`, not `/health/healthpolicies` — the latter 404s. Worth noting for anyone building policy-aware tooling later; not itself part of the metrics-polling path.

### 14.7 Multi-target and multi-backend in one process

v1 runs one backend and one target per process ([§2.3](#23-backend-adapter-abstraction)). Whether operators need multiple FMC UIDs, multiple FMC hosts, or mixed backends in a single instance is unknown. **Deferred pending user feedback.** The adapter abstraction makes it additive rather than a rewrite, but it would require a config-file format (env vars scale poorly to N targets) and per-target rate-limit accounting.

**On the comparable-exporter pattern for this (`fortigate_exporter`'s stateless `/probe`):** that exporter (and the wider `blackbox_exporter`-style family) handles "one exporter process, many targets" by taking the target as a query parameter on a stateless `/probe` endpoint — Prometheus's own scrape config fans out to N targets, and the exporter dials whichever one is named per-request, with no server-side polling loop at all. **That pattern is directly incompatible with this exporter's architecture** and not a viable path here: the entire poll-cache-serve design ([§2.2](#22-the-core-architectural-pattern-poll-cache-serve)) exists specifically because SCC's 2-requests/minute limit cannot tolerate a live upstream call per scrape, and a stateless `/probe` is by definition a live call per scrape. The real gap this project has is **multi-*manager*** (more than one FMC UID or FMC host under one exporter process), not multi-target-per-scrape — and the correct-shaped solution, if built, is **cached multi-target**: the existing poll-cache-serve loop generalized to poll N managers on their own schedules into N cache entries, with `/metrics` still serving from cache and still making zero upstream calls in the request path. This is a variant of the "additive, not a rewrite" framing above, not a new architecture.

### 14.8 High availability and leader election

`replicas: 1` is recommended, since replicas multiply upstream request rate against hard limits ([§7.3](#73-replica-count-and-why-it-is-1)). If HA demand emerges, leader election (Kubernetes `Lease`) with only the leader polling and followers serving the shared cache — or a simpler active/standby — would be the approach. **Not v1.**

### 14.9 cdFMC native HealthMonitor endpoints as a higher-resolution path

The native cdFMC endpoints (`/v1/cdfmc/api/fmc_config/v1/domain/{domainUUID}/health/metrics` and `/health/events`) expose raw Prometheus-named series (`cpu`, `mem`, `interface`, `asp_drops`, `disk_stats`, `critical_process`) with explicit `startTime`/`endTime`/`step` and regex filtering — richer than the wrapper endpoint. Unknowns: their own rate limits, whether they are subject to the wrapper endpoint's 2/min limit, and whether the extra granularity justifies window-cursor management. **v1.1+ opt-in at most.**

### 14.10 Rate-limit behavior under error conditions

Whether SCC's 2-requests/minute limit counts failed requests (4xx/5xx) against the budget is not documented. The design conservatively assumes **it does** and counts every attempt, including retries. If it does not, the exporter is merely slightly more conservative than necessary — the correct direction to err.

### 14.11 Metric name stability commitment

Publishing metric names creates a compatibility contract: users build dashboards and alerts on them, and renames break those silently. Names already known to be at risk — the interface byte metrics' units ([§14.4](#144-interface-byte-counter-units-and-semantics)) and the chassis/HA/VPN groups on both backends (documentation-only field names, never observed populated). **Mitigation:** remain on `0.x` until the SCC surface is validated in a real third-party deployment, and document the still-experimental groups so their names can change in a minor release.

### 14.12 Legacy hostname deprecation timeline

Legacy `edge.<region>.cdo.cisco.com` hosts still work, but Cisco has not published an end-of-life date. An operator whose environment still points at one will have a working legacy URL that could break without warning. **Mitigation:** `example.env` and the README recommend the current `api.<region>.security.cisco.com` form and flag the legacy form as deprecated; a startup **warning when a legacy hostname is detected** is cheap and worth implementing, turning a future silent outage into a visible notice months in advance.

### 14.13 The `_percent`-vs-`_ratio` decision

A 2026-08-04 naming-conventions audit (checked against [prometheus.io/docs/practices/naming](https://prometheus.io/docs/practices/naming/)'s base-unit table) flagged `ftd_cpu_usage_percent`/`ftd_memory_usage_percent`/`ftd_disk_usage_percent` as non-compliant: the documented convention for a percentage is `_ratio` with values 0–1, not `_percent` with values 0–100. Both directions had real arguments:

- **For converting:** it is the documented convention; `_ratio` composes correctly with Grafana's `percentunit` panel unit with no manual `/100` in every query; it matches the comparable `fortigate_exporter` (`fortigate_cpu_usage_ratio`, 0–1); and it keeps this project's metric surface consistent with prometheus-community norms if that adoption path is ever pursued.
- **For keeping `_percent`:** upstream Cisco fields are natively 0–100 (`linaUsageAvg: 19` means 19%), so `_percent` keeps the mapping visually auditable against the raw API response, and avoids introducing a division that could itself have a unit bug.

**Decision: converted to `_ratio`, 0–1.** The division happens exactly once, at the `collector.ts` render-time `set()` call site, which is the same place every other unit-bearing field is already finalized — so it does not introduce a new class of bug, only a single well-tested arithmetic step. This was decided pre-1.0 (see [§13](#13-repository-hygiene-and-release-process)'s metric-surface stability contract), while the rename is still free.

---

## Appendix A: SCC vs standalone FMC endpoint comparison

| Capability | SCC / cdFMC | Standalone on-prem FMC |
|---|---|---|
| Auth: obtain credential | Static token from UI (Settings → User Management → API Only User → Generate API Token) | `POST /api/fmc_platform/v1/auth/generatetoken` with HTTP Basic auth; tokens returned in **response headers** |
| Auth: request header | `Authorization: Bearer <token>` | `X-auth-access-token: <token>` |
| Auth: refresh | N/A (non-expiring) | `POST /api/fmc_platform/v1/auth/refreshtoken` with both token headers; **30 min lifetime, max 3 refreshes** |
| Tenancy/scope in path | FMC UID | **Domain UUID** (Global + optional sub-domains) |
| All-device health, one call | **`GET /v1/inventory/managers/{fmcUid}/health/metrics?timeRange=`** | **Not available** |
| Per-device health | (included above) | `GET /health/aggregatemetrics?filter=device_uuid:<uuid>;metric:<CPU\|MEM\|INTERFACE\|DISK_STATS\|CHASSIS_STATS>;timeRange:<range>` — **one device, one family per request** |
| Low-level time-series metrics | `/v1/cdfmc/api/fmc_config/v1/domain/{domainUUID}/health/metrics` (Prometheus-named, requires time range + step) | `/api/fmc_config/v1/domain/{domainUUID}/health/metrics` (same shape; catalog not fully documented) |
| Device inventory | `GET /v1/inventory/devices`, `/v1/inventory/devices/{deviceUid}` | `GET /devices/devicerecords?expanded=true` (paginated) |
| HA status | `haHealthMetrics` in the health payload | `GET /devicehapairs/ftddevicehapairs` (`liveStatus` param) |
| RA VPN | `raVpnSessionHealthMetrics` in the health payload | `GET /health/ravpngateways` |
| S2S VPN tunnels | `s2sVpnTunnelHealthMetrics` in the health payload (max 1000) | `GET /health/tunnelstatuses`, `/health/tunnelsummaries` |
| Chassis | `chassisStatsHealthMetrics` in the health payload | `/chassis/fmcmanagedchassis/{containerUUID}/{faultsummary\|interfacesummary\|inventorysummary}` |
| Interface stats (alt. path) | — | `/devices/devicerecords/{containerUUID}/fpinterfacestatistics` (**overlap unresolved**, [§14.2](#142-which-interface-statistics-source-on-fmc-is-authoritative--must-resolve)) |
| Health alerts/events | — (wrapper payload only) | `GET /health/alerts`, `GET /health/events` |
| Licensing | `GET .../license/smartlicenses` (`regStatus`, `metadata.authStatus`, `evalExpiresInDays`) | `/api/fmc_platform/v1/...` licensing family |
| Fleet aggregations | `GET /v1/inventory/devices/health/metrics/aggregations` (30m/2h/6h/24h/7d) | — |
| On-prem connector status | `GET /v1/connectors/sdcs` | N/A |
| Deprecated / avoid | `GET /v1/tenants` (**deprecated**) | `GET /health/metricconfiguration` (**undocumented**) |
| Rate limit | **2 req/min on the health endpoint** | **300 GET/min per source IP; 10 concurrent connections** |
| Pagination | Not required for the health endpoint | `offset`/`limit`, default 25, max 1000, **no paging headers** |
| TLS | Public CA | **Self-signed by default**; client-side trust only |
| Response schema documented | Yes, and **verified live** | **No example bodies published** |

---

## Appendix B: confirmed SCC response schema

Verified against Cisco's current API documentation **and** a live authenticated `GET` against a real single-appliance FTD 1010 during research. Response is a **JSON array, one object per FTD device** managed by the given FMC UID.

**Root fields (always present):**

| Field | Type | Notes |
|---|---|---|
| `deviceUid` | string | Stable device identifier |
| `deviceName` | string | Human-readable name |
| `startTime` | string | ISO 8601 — start of the averaging window |
| `endTime` | string | ISO 8601 — end of the averaging window |

**`cpuHealthMetrics`** — `linaUsageAvg`, `snortUsageAvg`, `systemUsageAvg` (floats, 0–100 percent). Lina = ASA/FTD data-plane process; Snort = IPS/inspection engine; System = overall host. Confirmed to consistently break out into all three.

**`memoryHealthMetrics`** — `linaUsageAvg`, `snortUsageAvg`, `systemUsageAvg` (floats, 0–100 percent).

**`diskHealthMetrics`** — `totalDiskUsageAvg` (float, 0–100 percent).

**`chassisStatsHealthMetrics`** — **CONDITIONAL: absent entirely on non-chassis hardware** (confirmed absent on the FTD 1010 sample). Fields: `fan1RpmAvg`, `fan2RpmAvg`, `fan3RpmAvg`, `fan4RpmAvg`; `psu1FanStatus`, `psu1InputStatus`, `psu1OutputStatus`, `psu2FanStatus`, `psu2InputStatus`, `psu2OutputStatus` (string enum `UP`/`DOWN`).

**`interfaceHealthMetrics[]`** — array, one entry per interface. **Confirmed to include all interfaces, including down and unused ones with all-zero counters.**

| Field | Type | Notes |
|---|---|---|
| `interface` | string | Hardware id, e.g. `Ethernet1/1`. **Always present** |
| `interfaceName` | string | Human label, e.g. `outside`. **Optional — confirmed frequently absent** on unnamed/unused interfaces |
| `interfaceType` | string | e.g. `Ethernet`, `Management` |
| `linkStatus` | string enum | `UP` / `DOWN` |
| `operationalStatus` | string enum | `UP` / `DOWN` |
| `duplexMode` | string | Documented; **not observed** in the live sample |
| `inputBytesAvg`, `outputBytesAvg` | number | Units unresolved ([§14.4](#144-interface-byte-counter-units-and-semantics)) |
| `inputPacketSizeAvg`, `outputPacketSizeAvg` | number | |
| `inputErrorsAvg`, `outputErrorsAvg` | number | |
| `dropPacketsAvg` | number | |
| `bufferOverrunsAvg`, `bufferUnderrunsAvg` | number | |
| `l2DecodeDropsAvg` | number | |

**`haHealthMetrics`** — **CONDITIONAL: only present when the device is in an HA pair** (confirmed absent on the standalone sample). Fields: `nodeStatus` (`NORMAL`/`ERROR`/`WARNING`/`DISABLED`/`UNKNOWN`), `nodeType` (`PRIMARY`/`SECONDARY`).

**`raVpnSessionHealthMetrics`** — **CONDITIONAL: only present when RA VPN is configured** (confirmed absent). Fields: `activeRavpnSessionsAvg`, `inactiveRavpnSessionsAvg`, `peakConcurRavpnSessions`.

**`s2sVpnTunnelHealthMetrics[]`** — **CONDITIONAL: only present when site-to-site VPN is configured** (confirmed absent). Array, **max 1000 entries**. Fields: `tunnelId`, `tunnelName`, `tunnelState` (`TUNNEL_UP`/`TUNNEL_DOWN`/`UNKNOWN`).

**Error responses:** `400`, `401`, `403`, `405`, `500`.

**API spec versions at time of research:** `1.20.0` (SCC firewall-manager), `1.17.0` (cdFMC sub-API).

**Critical parsing note:** the four conditional groups above, plus per-interface `interfaceName`, were confirmed **absent as keys** — not present as `null` or empty. All must be optional at the type level, with presence tested via explicit `undefined` checks rather than truthiness (since `0` is a valid value for nearly every numeric field). See [§4.8](#48-handling-conditional-and-sparse-metric-groups).

---

## Appendix C: confirmed FMC response schema (partial)

Verified against a live authenticated FMC (v10.0.0, four FTDv devices, lab environment) during implementation-phase research. Device names/IPs/UUIDs below are placeholders — the actual capture used real lab values now excluded from the repository via `.gitignore`. Supersedes the "no example response bodies" gap noted in [§14.1](#141-standalone-fmc-response-body-field-names--partially-resolved).

**Auth response (`POST /api/fmc_platform/v1/auth/generatetoken`):** confirmed exactly as documented in [Appendix A](#appendix-a-scc-vs-standalone-fmc-endpoint-comparison) — `204 No Content`, tokens and `DOMAIN_UUID` in response headers (`X-auth-access-token`, `X-auth-refresh-token`, `DOMAIN_UUID`, `DOMAINS`), no response body.

**`GET /api/fmc_config/v1/domain/{domainUUID}/health/aggregatemetrics?filter=device_uuid:<uuid>;metric:CPU;timeRange:5m`:**

```json
{
  "links": { "self": "https://<fmc-host>/api/fmc_config/v1/domain/<domainUUID>/health/aggregatemetrics?offset=0&limit=25&filter=..." },
  "items": [
    {
      "startTime": "2026-07-31 08:50:36.550 UTC",
      "endTime": "2026-07-31 08:55:36.550 UTC",
      "cpuHealthMetrics": {
        "linaUsageAvg": 0.3,
        "snortUsageAvg": 0.29,
        "systemUsageAvg": 19
      },
      "links": { "self": "https://<fmc-host>/api/fmc_config/v1/domain/<domainUUID>/health/aggregatemetrics/<device-uuid>" },
      "name": "<device-name>",
      "id": "<device-uuid>",
      "type": "AggregateMetric"
    }
  ],
  "paging": { "offset": 0, "limit": 25, "count": 1, "pages": 1 }
}
```

`MEM` and `DISK_STATS` follow the identical wrapper shape, with `memoryHealthMetrics: { linaUsageAvg, snortUsageAvg, systemUsageAvg }` and `diskHealthMetrics: { totalDiskUsageAvg }` respectively in place of `cpuHealthMetrics`.

**Confirmed:**

- `cpuHealthMetrics` and `memoryHealthMetrics` **do** break out into `linaUsageAvg`/`snortUsageAvg`/`systemUsageAvg`, identical field names to SCC's `cpuHealthMetrics`/`memoryHealthMetrics` — resolves the open sub-question in [§14.1](#141-standalone-fmc-response-body-field-names--partially-resolved). No `component`-label asymmetry between backends for CPU/MEM.
- `diskHealthMetrics.totalDiskUsageAvg` — identical field name to SCC.
- **Wrapper shape differs from SCC.** FMC's `items[]` wraps one object per request (one device, one metric family), each carrying its own `startTime`/`endTime`/`links`/`name`/`id`/`type`, versus SCC's flat array of fully-populated multi-family device objects. The FMC adapter's mapping layer must not assume SCC's flatter shape.
- **`startTime`/`endTime` are not ISO 8601** — format observed as `"YYYY-MM-DD HH:mm:ss.SSS UTC"`. Differs from the ISO 8601 format confirmed for SCC in [Appendix B](#appendix-b-confirmed-scc-response-schema); the FMC adapter must parse this format explicitly rather than reusing an SCC date parser.
- **Policy-gated families return an empty result set, not zeros or an error.** A device whose assigned health policy has a given `hm_*` module disabled returns `HTTP 200` with `{"paging":{"count":0}}` and no `items` for that metric family — the same absence semantics as capability-based absence (e.g. `CHASSIS_STATS` on non-chassis hardware), not a distinct failure mode. See [§14.6](#146-whether-sccs-health-policy-gating-produces-absent-groups-or-zero-values).
- **`CHASSIS_STATS`** returned an empty result set on the lab's FTDv devices (`{"paging":{"count":0}}`) — expected, capability-based absence (no chassis hardware), consistent with the SCC-side finding for non-chassis appliances.

**`GET /api/fmc_config/v1/domain/{domainUUID}/health/aggregatemetrics?filter=device_uuid:<uuid>;metric:INTERFACE;timeRange:1h`**, captured once `hm_ifconfig` was enabled on the device's health policy:

```json
{
  "links": { "self": "https://<fmc-host>/api/fmc_config/v1/domain/<domainUUID>/health/aggregatemetrics?offset=0&limit=25&filter=..." },
  "items": [
    {
      "startTime": "2026-07-31 09:57:10.009 UTC",
      "endTime": "2026-07-31 10:57:10.009 UTC",
      "interfaceHealthMetricsList": [
        {
          "duplexMode": "FULL",
          "interfaceName": "<name>",
          "interfaceType": "GigabitEthernet",
          "currentLinkStatus": "UP",
          "currentOperationalStatus": "UP",
          "bufferOverrunsAvg": 0,
          "bufferUnderrunsAvg": 0,
          "dropPacketsAvg": 102813,
          "inputBytesAvg": 21474836,
          "inputErrorsAvg": 0,
          "inputPacketSizeAvg": 46,
          "l2DecodeDropsAvg": 0,
          "outputBytesAvg": 21474836,
          "outputErrorsAvg": 0,
          "outputPacketSizeAvg": 52,
          "interface": "GigabitEthernet0/0"
        }
      ],
      "links": { "self": "https://<fmc-host>/api/fmc_config/v1/domain/<domainUUID>/health/aggregatemetrics/<device-uuid>" },
      "name": "<device-name>",
      "id": "<device-uuid>",
      "type": "AggregateMetric"
    }
  ],
  "paging": { "offset": 0, "limit": 25, "count": 1, "pages": 1 }
}
```

**Confirmed, and genuinely different from SCC's Appendix B schema — not just an unverified assumption that happened to match:**

- **Wrapper key is `interfaceHealthMetricsList`, not `interfaceHealthMetrics`.** A mapping layer written by analogy with SCC's naming would silently produce zero interface series against FMC.
- **`currentLinkStatus`/`currentOperationalStatus`**, not SCC's `linkStatus`/`operationalStatus`.
- **`duplexMode` was populated (`"FULL"`) on every interface**, whereas SCC's Appendix B notes it as "documented; not observed in the live sample" — the field exists and has real values on at least one backend.
- **All interfaces were present, including ones with all-zero counters** (e.g. `V999`, `HA-Link`, `State-Link` on this lab device carried little to no traffic) — matches SCC's confirmed behavior of including down/unused interfaces rather than omitting them.
- **Per-field names otherwise match SCC**: `bufferOverrunsAvg`, `bufferUnderrunsAvg`, `dropPacketsAvg`, `inputBytesAvg`, `inputErrorsAvg`, `inputPacketSizeAvg`, `l2DecodeDropsAvg`, `outputBytesAvg`, `outputErrorsAvg`, `outputPacketSizeAvg`, `interface`, `interfaceName`, `interfaceType` are all identical to the SCC field list in [Appendix B](#appendix-b-confirmed-scc-response-schema).
- **`fpinterfacestatistics` (the alternative device-record path for §14.2) returned `400 Unsupported device`** on this FTDv, independent of the `hm_ifconfig` policy state — inconclusive on which source is authoritative in general, but the health family is now the only one that has produced real data in this research.

**Not yet captured:** `haHealthMetrics`, `raVpnSessionHealthMetrics`, and `s2sVpnTunnelHealthMetrics[]` field names on FMC — no device in the lab is configured for HA or VPN. These remain provisional per [§3.3.5](#335-known-unknown-response-body-field-names).

**Side finding:** the health-policy configuration endpoint is `GET /api/fmc_config/v1/domain/{domainUUID}/policy/healthpolicies` (confirmed), not `/health/healthpolicies` as might be guessed by analogy with `/health/aggregatemetrics` (404s). Not part of the metrics-polling path, but relevant to any future policy-aware tooling or troubleshooting documentation.
