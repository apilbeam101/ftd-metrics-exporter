# IMPLEMENTATION_PLAN.md

**Project:** `ftd-metrics-exporter` — Prometheus exporter for Cisco FTD health metrics
**Status:** Implementation roadmap. Pre-implementation as of writing (repo contains `DESIGN.md`, `.gitignore`, and gitignored local research material only).
**Authority:** [`DESIGN.md`](DESIGN.md) is the source of truth for architecture, metric names, label names, configuration variable names, and every decision already settled. This document sequences the *build*; it does not re-decide anything. Where this plan and `DESIGN.md` appear to disagree, `DESIGN.md` wins and this plan is wrong.

---

## 0. How to use this document

Each stage below is written so that a fresh session can pick it up cold. Every stage has:

- **Goal / outcome** — the capability that exists when the stage is done, stated as something you can *do*.
- **Scope** — concrete files, modules, and interfaces, with `DESIGN.md` section references.
- **Dependencies** — earlier stages, plus external facts outside the implementer's control.
- **Testing steps** — named test scenarios, not "write tests."
- **Risks** — including the specific `DESIGN.md` §14 open questions the stage touches.
- **Where later adjustment is likely** — what is provisional and expected to be revisited.

A stage is **done** when its tests are green on all three CI platforms (once Stage 14 exists) and its "outcome" statement is demonstrably true.

---

## 1. Ordering rationale and dependency graph

### 1.1 The central sequencing decision: fixtures and pure mapping first

`DESIGN.md` §12 states the guiding principle plainly: *"the response-mapping layer is where the real complexity and risk live, and it is pure, so it should carry the bulk of the test weight."* The build order follows from that.

**Stages 1–3 (domain model → response mapping → metrics rendering) are built and fully tested before any network code exists.** This is not an aesthetic preference:

- The verified payload shapes are already in hand — a live SCC capture and a live FMC capture (v10.0.0, four FTDv devices), documented in `DESIGN.md` Appendix B and Appendix C, with the raw responses sitting in the gitignored `.scratch/` directory awaiting sanitization. The riskiest logic in the project can therefore be written against real data on day one.
- The two backends' payloads genuinely diverge (`interfaceHealthMetricsList` vs `interfaceHealthMetrics`; `currentLinkStatus` vs `linkStatus`; a non-ISO-8601 timestamp format on FMC; an `items[]` single-family wrapper vs a flat multi-family array). `DESIGN.md` §14.1 calls this out as *"exactly the kind of asymmetry §14.1 existed to catch."* Discovering that divergence with a live FMC in the loop, an adapter half-written, and a token manager misbehaving would be materially harder than discovering it against two committed fixture files.
- Building the renderer early forces the `gauge.reset()` / custom-collector disappearance semantics (`DESIGN.md` §4.8 — *"the single most important correctness detail in the rendering layer"*) to be solved while it is cheap to test, rather than bolted on after the poller exists.

The consequence is that by end of Stage 3 the project can already turn a JSON file into a byte-exact `/metrics` page, with no `undici`, no config loader, and no server. That is the correct thing to have first.

### 1.2 Dependency graph

```
Stage 0  Scaffolding / toolchain
   │
   ├──────────────┬──────────────────┬──────────────────────────┐
   ▼              ▼                  ▼                          ▼
Stage 1        Stage 4           Stage 5                    (Stage 14 CI can
Domain model   Config loader     Logger + redaction          start early and
+ fixtures     + validation      (independent)                grow per stage)
   │              │                  │
   ▼              │                  │
Stage 2           │                  │
Response mapping  │                  │
(SCC + FMC, pure) │                  │
   │              │                  │
   ▼              │                  │
Stage 3           │                  │
Metrics rendering │                  │
+ self-metrics    │                  │
   │              │                  │
   └──────┬───────┴──────────────────┘
          ▼
      Stage 6  HttpClient / TLS / retry / limiters
          │
          ├───────────────────────┬───────────────────────┐
          ▼                       ▼                       │
      Stage 7                 Stage 8                     │
      SCC adapter             FMC adapter                 │
      (+ HealthBackend        (FmcTokenManager,           │
       interface, shared)      discovery, fan-out,        │
          │                    budget guard)              │
          └───────────┬───────────┘                       │
                      ▼                                   │
                  Stage 9  Poller + cache + self-metric wiring
                      │                                   │
                      ▼                                   │
                  Stage 10  HTTP server, /healthz, /readyz, TLS listener
                      │                                   │
                      ▼                                   │
                  Stage 11  Entrypoint, lifecycle, --dump-raw ◄┘
                      │
                      ▼
                  Stage 12  Integration test suite
                      │
          ┌───────────┼───────────┐
          ▼           ▼           ▼
   Stage 13A/B/C   Stage 14    Stage 15
   Packaging       Hygiene/CI  Dashboard + alerts
   (Standalone/
    Docker/K8s,
    independently
    machine-gated)
          └───────────┼───────────┘
                      ▼
                  Stage 16  0.x live validation → 1.0 gate
```

### 1.3 What can be parallelized

| Can run in parallel | Why |
|---|---|
| **Stage 1/2/3** and **Stage 4** and **Stage 5** | The mapping/rendering path is pure and needs neither config nor logging. The config loader needs no domain types beyond the `BackendKind` union. The logger is standalone. Three people (or three sessions) can work these concurrently after Stage 0. |
| **Stage 7 (SCC adapter)** and **Stage 8 (FMC adapter)** | `DESIGN.md` §2.3/§3.1 frames them as genuinely separate components behind a narrow interface, explicitly *"rather than one parameterized client."* Once `HealthBackend`, `HttpClient`, and the mappers exist, the two adapters share nothing but the interface. Stage 7 is roughly a day's work; Stage 8 is the largest single stage in the project. Starting them together is the biggest available schedule win. |
| **Stage 13A (standalone)**, **Stage 13B (Docker)**, **Stage 13C (Kubernetes)**, **Stage 14 (hygiene/CI)**, **Stage 15 (dashboard/alerts)** | All consume a finished metric surface but not each other. 13A's Windows leg needs only the implementer's own machine; 13A's Linux leg and all of 13B/13C need a second test machine (e.g. an Ubuntu VM) and are naturally sequenced by when that machine is available, not by any dependency between them. Stage 15 in particular only needs the metric *names*, which are frozen at Stage 3. |
| **Stage 14 incrementally, from Stage 0 onward** | Do not save CI for the end. Stand up type-check + unit tests on the OS matrix at Stage 0 and add checks as stages land. A Windows path bug found at Stage 6 is cheap; found at Stage 14 it is a rework. |

### 1.4 What must be strictly sequential

- **Stage 1 → 2 → 3.** The domain model gates the mappers; the mappers gate the renderer.
- **Stage 6 → 7/8.** Both adapters need the `get()`-only client, the TLS-scoped `undici` Agent, and the limiters. Do not let either adapter grow its own HTTP path — `DESIGN.md` §9.5 requires that a non-GET be *unrepresentable*, which only holds if there is exactly one client.
- **Stage 7/8 → 9 → 10 → 11.** The poller needs at least one working adapter; the server needs the cache; the entrypoint needs everything.
- **Stage 12 after 11.** Integration tests exercise the assembled process.
- **Stage 16 last, and partly not under the implementer's control.** See §3.

---

## 2. Definition of done for v1

### 2.1 Goal-by-goal (`DESIGN.md` §1.3)

| Goal | Done when |
|---|---|
| **G1** — Prometheus exposition on `/metrics` | `promtool check metrics` (or an equivalent parser assertion) passes against the rendered output from every committed fixture; a real Prometheus and a real Alloy `prometheus.scrape` both ingest it unmodified. |
| **G2** — Both backends behind one interface | `BACKEND_TYPE=scc` and `BACKEND_TYPE=fmc` both produce populated `DeviceHealthSnapshot[]` through the same `HealthBackend` interface; the renderer contains zero backend-specific code (enforceable as a lint/grep check: no `scc`/`fmc` string in `src/metrics/`). |
| **G3** — Comprehensive coverage | CPU, memory, disk, interface (12 fields + link/operational status) verified against live data on **both** backends. HA, VPN, chassis mapped, unit-tested against synthetic fixtures, and shipped **labeled experimental** — see §3 for why they cannot be more than that in v1. |
| **G4** — Identical on bare process, Docker, Kubernetes | All three paths documented self-contained; CI green on `ubuntu-latest`/`macos-latest`/`windows-latest`; multi-arch image published; a CI check proves the install produces no native build step. |
| **G5** — Zero credentials in repo | `example.env` has placeholders only; `.env` gitignored; secret scanning green on every PR; sanitized fixtures committed with no real device names, UIDs, or IPs. |
| **G6** — Modern security posture | TLS 1.2 floor set explicitly on the `undici` Agent; upstream `http:` rejected at config validation; CA-bundle trust scoped per-backend (not global); insecure flag defaults false, warns loudly, and is visible as `ftd_exporter_tls_verification_disabled`. |
| **G7** — Single-language toolchain | `package.json` runtime deps are exactly `prom-client` and `undici`; devDeps are TypeScript, types, and one lint/format tool; no Python, no native addons anywhere in the lock file. |
| **G8** — Rate limits respected by design | SCC 30 s minimum inter-request spacing enforced in the adapter under a fake clock, *including across retries*; FMC concurrency capped ≤ 10 and the rolling 300/min budget guard proven under test; startup warning fires when projected request volume exceeds ~70% of budget. |
| **G9** — Self-observable | Every metric in `DESIGN.md` §11 present and asserted by test; upstream failure demonstrably yields `ftd_exporter_up 0` + growing `ftd_exporter_cache_age_seconds` while last-good data continues to serve. |

### 2.2 The 0.x → 1.0 gate (`DESIGN.md` §13)

The project ships as **`0.x` until the SCC surface has been validated in at least one third-party deployment** — i.e. an SCC tenant that is not the maintainers'. Everything in Stages 0–15 can be complete, correct, and released as `0.y.z` without that. Cutting `1.0` additionally requires:

1. Third-party SCC validation (external — §3).
2. `DESIGN.md` §14.4 resolved (interface byte-counter units), because the metric names depend on it and a rename after 1.0 is a major bump (`DESIGN.md` §14.11).
3. HA/VPN/chassis still permitted to be experimental *in* 1.x — `DESIGN.md` §13 explicitly allows their names to change in a minor release. They are **not** a 1.0 blocker; the README must say so.

---

## 3. What is gated on external verification

This section exists so nobody burns time trying to close an item that cannot be closed from a laptop.

### 3.1 Fully buildable and testable with fixtures/mocks alone — no external access required

- Stage 0 scaffolding, Stage 4 config validation, Stage 5 logger/redaction.
- Stage 1–3: domain model, both response mappers, the renderer, `gauge.reset()` disappearance semantics, enum/state-set representation, sparse-group omission.
- Stage 6: TLS trust scoping, retry/backoff, concurrency limiter, SCC spacing guard, FMC budget guard — all under a fake clock and a self-signed local mock server (`DESIGN.md` §12.2 explicitly designs for this).
- Stage 8's `FmcTokenManager` state machine in full: proactive refresh at 80% of lifetime, the 3-refresh ceiling, single-flight acquisition, 401 re-auth-and-retry. `DESIGN.md` §12.1 notes this is *"the most intricate logic in the project and is fully testable without a network."*
- FMC pagination including the >25-device truncation case, using a mock that serves 40 synthetic devices.
- Stage 9–12 end to end, against `undici`'s `MockAgent` or a `node:http` fixture server.
- Stage 13A–C/14/15 artifacts (Dockerfile, manifests, dashboard JSON, alert rules). The dashboard can be validated against fixture-derived metrics loaded into a local Prometheus. Stage 13B/13C's actual *execution* (not just artifact authorship) needs Docker and a Kubernetes cluster respectively — see Stage 13's environment table for what is genuinely testable from a laptop alone versus what needs a second machine.

### 3.2 Requires a live on-prem FMC (maintainer lab — available, per Appendix C)

- Confirmation that discovery pagination behaves as documented against a real inventory.
- Confirmation of the FMC timestamp format across families (`"YYYY-MM-DD HH:mm:ss.SSS UTC"` observed).
- Token lifecycle behavior against the real endpoint: whether refresh really returns a fresh pair, whether the ceiling is exactly 3, and how the UI/API session conflict manifests (`DESIGN.md` §3.3.2).
- Empirical fleet-size request-budget behavior.
- **Already resolved by the lab** and needing no repeat: CPU/MEM/DISK_STATS/INTERFACE field names, the `items[]` wrapper shape, policy-disabled families returning `{"paging":{"count":0}}` rather than zeros, and `/health/metricconfiguration` being irrelevant (it is `integration/aiops/metricconfiguration`; `DESIGN.md` §14.5).

### 3.3 Requires a live SCC tenant

- Validation that `SCC_TIME_RANGE` reaching the query string produces the expected window (the unit test proves propagation; only live data proves effect).
- Empirical answer to `DESIGN.md` §14.10 — whether failed requests count against the 2/min budget. Until answered, the design conservatively counts every attempt, which is the safe direction to err.
- The health-policy propagation delay documented in §14.6 (observed under 5 minutes) — worth confirming a second time before it goes in the README as a number.
- **The 1.0 gate itself:** a *third-party* SCC deployment, not the maintainers'.

### 3.4 Requires hardware or configuration the maintainers may never have — genuinely blocked

These are the items to design around rather than wait on:

| Blocked item | `DESIGN.md` ref | Consequence for the plan |
|---|---|---|
| **Chassis-based hardware** (populated `chassisStatsHealthMetrics`) | §14.1, §14.3, Appendix B/C | Chassis mapping is written from documentation only. Confirmed *absent* on both an FTD 1010 (SCC) and FTDv (FMC) — absence semantics are verified, populated field names are not. Ships experimental. |
| **A device in an HA pair** (`haHealthMetrics`) | §14.1 | Same. Field names (`nodeStatus`, `nodeType`) are documentation-only on both backends. Ships experimental. |
| **RA VPN and S2S VPN configured** (`raVpnSessionHealthMetrics`, `s2sVpnTunnelHealthMetrics`) | §14.1 | Same. Ships experimental. `ftd_s2s_tunnel_state` is also the highest-cardinality series in v1 and has never been observed at real scale. |
| **Which FMC interface-stats source is authoritative** | §14.2 — marked **must resolve** | `fpinterfacestatistics` returned `400 Unsupported device` on FTDv regardless of health-policy state. The health family is the only one that has produced real interface data. v1 uses the health family as a *recorded assumption*, not a conclusion. Needs chassis/appliance hardware where both paths might succeed. |
| **Interface byte-counter units** | §14.4 | Needs a device you can push known traffic volumes through, then compare `5m` vs `1h` values. Blocks 1.0 naming, not the build. |
| **Legacy `edge.<region>.cdo.cisco.com` EOL date** | §14.12 | Cisco has published none. Mitigation is a startup warning on legacy-hostname detection (Stage 4); nothing more can be done. |

**Mitigation for all of §3.4: the `--dump-raw` capture mode (Stage 11).** `DESIGN.md` §3.3.5 designs this specifically to turn these blockers into community-solvable problems — an operator with chassis hardware or an HA pair can contribute a sanitized fixture without ever sharing credentials. Treat shipping `--dump-raw` plus the `CONTRIBUTING.md` fixture-contribution instructions as the *actual* resolution path for §14.1's remaining gaps, not as a nice-to-have.

---

# Stage 0 — Project scaffolding and toolchain

### Goal / outcome

`npm ci && npm run build && npm test` succeeds on a clean checkout on Windows, macOS, and Linux, producing `dist/` from an empty-but-compiling source tree. `tsc --noEmit` enforces `strict` **and** `exactOptionalPropertyTypes`, so the sparse-group presence rules from `DESIGN.md` §4.8 become compiler-enforced rather than discipline-enforced from the very first file. A stub `node dist/index.js` starts, prints one JSON log line, and exits 0.

### Scope

- `package.json` — `"type": "module"`, `"engines": { "node": ">=24" }`, `"files"` as an **allowlist** (`DESIGN.md` §9.7), no lifecycle scripts of any kind (`DESIGN.md` §9.7 — a customer must be able to install with `--ignore-scripts`). Scripts: `build`, `typecheck`, `lint`, `format`, `test`, `test:unit`, `test:integration`.
- `tsconfig.json` — target/lib matching Node 24, `module: nodenext`, `strict: true`, `exactOptionalPropertyTypes: true`, `noUncheckedIndexedAccess: true`, `verbatimModuleSyntax`, `outDir: dist`, `declaration: false` (this is a program, not a library).
- Lint/format: `biome` (one devDependency) per `DESIGN.md` §2.7, or `eslint`+`prettier` if the implementer prefers — the design explicitly leaves this open.
- Directory skeleton (empty index files where useful):
  ```
  src/{config,log,http,domain,backends/{scc,fmc},metrics,poller,server}/
  test/{unit,integration,fixtures/{scc,fmc}}/
  ```
- `src/index.ts` stub with the **Node version check** required by `DESIGN.md` §5.2 — parse `process.version`, exit non-zero with a clear message on < 24 rather than failing obscurely later.
- `src/version.ts` — build-info constants (version, commit, node version), populated at build time or read from `package.json`.
- Baseline `.gitignore` additions per `DESIGN.md` §13: `.env`, `.env.*` except `example.env`, `*.pem`, `*.key`, `*.crt`, `*.p12`, `dist/`, `node_modules/`. The existing file already covers `.env`, `node_modules/`, `dist/`, `/data/`, `/.scratch/` — extend, don't replace, and **keep `/data/` and `/.scratch/` ignored** (`data/` contains prior-art/reference material, including live plaintext credentials, that must never reach the public repo).
- Minimal `README.md` placeholder and `LICENSE` (Apache-2.0 per `DESIGN.md` §13) so the repo is never license-null.

### Dependencies

None external. Node 24+ installed locally.

### Testing steps

- `npm run typecheck` passes on the empty tree.
- One trivial `node:test` file exists and runs via `node --test`, proving the test runner wiring (`DESIGN.md` §2.7 chooses `node:test` + `node:assert`).
- Manual: run the stub on Windows and confirm no path-separator assumptions (`DESIGN.md` §5.4 — *"Path handling in code must use `node:path` throughout"*).
- Verify `npm ci` output contains no `node-gyp`/build-step lines. Codify this as the CI check `DESIGN.md` §5.1/§12.4 requires; a crude but effective form is asserting the install log has no `gyp` invocation and the lock file has no `os`/`cpu`-conditional or `hasInstallScript` entries.

### Risks

- **`exactOptionalPropertyTypes` friction.** It is the right setting for §4.8 correctness but is genuinely annoying with object literals built incrementally. Expect to construct snapshot objects functionally (build the whole literal at once, conditionally spreading optional groups) rather than mutating. Decide this convention now; retrofitting it across the mappers later is tedious.
- **ESM + `node:test` + TypeScript combination.** Node 24 can type-strip, but the shipped artifact is `tsc`-built per `DESIGN.md` §2.7. Decide early whether tests run against `src/` (type-stripped, fast) or `dist/` (what ships). Recommend running unit tests against `src/` and at least one integration smoke test against `dist/`, so a build-output bug cannot hide.
- Lint tool choice churn — pick one and move on; `DESIGN.md` §2.7 marks it as implementer preference.

### Where later adjustment is likely

- `files`/`.npmignore` allowlist will need extending as `deploy/`, `dashboards/`, `alerts/` appear (Stages 13/15) — decide then whether those ship in the npm tarball or only in the Git repo. Recommend Git-only, tarball minimal.
- `version.ts` population mechanism will likely change once CI release automation exists (Stage 14).

---

# Stage 1 — Domain model and sanitized fixtures

### Goal / outcome

The exporter's own vocabulary exists as types, and the repository contains a committed, **sanitized**, real-world fixture corpus covering every case `DESIGN.md` §12.1 requires — so that Stage 2's mappers can be written test-first against real payloads rather than imagined ones.

### Scope

- `src/domain/snapshot.ts` — `DeviceHealthSnapshot` exactly as specified in `DESIGN.md` §2.3, with every conditional group optional at the type level. Plus `ChassisStats`, `InterfaceStats`, `HaStats`, `RaVpnStats`, `S2sTunnelStats`.
  - Critical: `InterfaceStats` keeps status as the **original upstream string** (`"UP"`), not a boolean. `DESIGN.md` §3.2.6 is explicit — *"String enums are mapped to numeric gauges at render time, not at parse time; the snapshot keeps the original string so the renderer can decide representation."*
- `src/domain/enums.ts` — the canonical enum vocabularies and their lowercased label forms: link/operational `UP|DOWN`; HA `NORMAL|ERROR|WARNING|DISABLED|UNKNOWN`; HA node type `PRIMARY|SECONDARY`; tunnel `TUNNEL_UP|TUNNEL_DOWN|UNKNOWN` → `up|down|unknown`; PSU `UP|DOWN`. Plus the "unrecognized value → `unknown` + counter" contract from `DESIGN.md` §4.4.
- `src/backends/scc/schema.ts` and `src/backends/fmc/schema.ts` — types describing the *upstream* payloads, per Appendix B and Appendix C respectively. Keep these separate from the domain model; that separation is the whole point of `DESIGN.md` §2.3.
- **Fixture sanitization and commitment.** The raw captures currently in the gitignored `.scratch/` must be sanitized before anything is committed (`DESIGN.md` §9.7 — *"Fixtures committed for testing must be sanitized… Test data is a real and frequently overlooked leak path"*). Real device names, real UUIDs, real FMC IP/port, and the real domain UUID must all be replaced with synthetic values — the exact real values themselves must never appear in this (committed) plan or in any committed script; they belong only in the gitignored `.scratch/`. A small, committed sanitizer script (or a documented manual procedure in `CONTRIBUTING.md`) is worth building, since Stage 11's `--dump-raw` will make third parties do the same thing.

  Fixture corpus to commit under `test/fixtures/`:

  | Fixture | Source | Purpose |
  |---|---|---|
  | `scc/full-live.json` | sanitized live SCC capture (1 device, 9 interfaces, CPU/MEM/DISK/INTERFACE present; chassis/HA/VPN keys absent) | primary SCC fixture; also *is* the "all conditional groups absent" case |
  | `scc/cpu-group-absent.json` | sanitized SCC recheck capture (health policy disabled CPU; `cpuHealthMetrics` key gone, others intact) | proves policy-gated absence is per-group, not per-device (`DESIGN.md` §14.6) |
  | `scc/all-groups-present.json` | **synthetic** — chassis + HA + RA VPN + S2S tunnels populated, per Appendix B field names | the only way to test the experimental groups (§3.4) |
  | `scc/interface-name-absent.json` | derived — interfaces without `interfaceName` | fallback-to-hardware-id assertion (`DESIGN.md` §4.3) |
  | `scc/zero-values.json` | derived — genuine `0` CPU, all-zero interfaces | the truthiness-bug test (`DESIGN.md` §12.1) |
  | `scc/malformed.json` | synthetic — wrong types, missing required fields, unparseable timestamps, unknown enum values | per-device/per-group skip behavior |
  | `scc/s2s-1000-tunnels.json` | synthetic, generated | worst-case cardinality (`DESIGN.md` §4.2) |
  | `fmc/cpu.json`, `fmc/mem.json`, `fmc/disk-stats.json` | sanitized live FMC captures | `items[]` wrapper + confirmed field names |
  | `fmc/interface.json` | sanitized live FMC capture (9 interfaces, `interfaceHealthMetricsList`, `currentLinkStatus`) | the naming-divergence fixture |
  | `fmc/empty-family.json` | live capture: `{"links":{},"paging":{"offset":0,"limit":0,"count":0,"pages":0}}` | policy-gated / capability absence — **200 with no `items`, not an error** |
  | `fmc/device-not-connected.json` | live capture: `{"error":{"category":"FRAMEWORK","messages":[{"description":"Device not connected."}],"severity":"ERROR"}}` | per-device failure → partial snapshot |
  | `fmc/unsupported-device.json` | live capture: `400 Unsupported device` | `fpinterfacestatistics` negative result (§14.2 evidence) |
  | `fmc/devicerecords-page1.json` … `page2.json` | sanitized live capture + synthetic extension to > 25 devices | pagination, including the naive-truncation case |
  | `fmc/auth-headers.json` | recorded header set from `generatetoken` (`X-auth-access-token`, `X-auth-refresh-token`, `DOMAIN_UUID`, `DOMAINS`), token values replaced | token manager + domain resolution |
  | `fmc/all-groups-present.json` | **synthetic** — HA/VPN/chassis for FMC, flagged provisional | untestable otherwise (§3.4) |

- `test/fixtures/README.md` documenting, per fixture: whether it is **live-verified** or **synthetic/provisional**, and what it is meant to prove. This matters — a future contributor must not mistake the synthetic HA fixture for evidence of real field names.

### Dependencies

- Stage 0.
- The raw captures in `.scratch/` (present). If they are ever lost, the SCC ones require a live tenant and the FMC ones a lab FMC to re-capture — so sanitize and commit them *early*, as the first substantive commit. This is the single most time-sensitive item in the plan.

### Testing steps

- A guard test that walks `test/fixtures/**` and asserts none of the known real identifiers appear (real device names, the lab IP/port, the real domain UUID, the real device UUIDs). This is cheap and prevents a leak regression when fixtures are added later.
- A schema-shape test per fixture: parse it, assert it structurally matches the corresponding `schema.ts` type via a narrow runtime check. Catches a mangled sanitization pass.
- Type-level tests (`// @ts-expect-error` assertions) proving `exactOptionalPropertyTypes` rejects assigning `undefined` to an optional group — i.e. that the compiler really is enforcing §4.8.

### Risks

- **Over-sanitization destroying signal.** Replacing `Ethernet1/1` with `iface-1` would silently discard the interface-naming shape the mappers depend on. Sanitize identities (device names, UUIDs, hostnames, IPs) and *not* structural values (interface hardware ids, types, counter values). Write this rule down in `CONTRIBUTING.md`.
- **Under-sanitization.** The FMC captures embed the lab host and domain UUID inside `links.self` strings, not just top-level fields. Sanitize recursively, then have the guard test verify it.
- **Synthetic fixtures encoding a guess as if it were fact** — the chassis/HA/VPN case. Mitigate with the fixture README's live-vs-synthetic marking and a naming convention (e.g. a `provisional-` prefix) so it is impossible to confuse them at the call site.

### Where later adjustment is likely

- The synthetic HA/VPN/chassis fixtures will be **replaced wholesale** the first time real data arrives via `--dump-raw`, on either backend. Expect their field names to be wrong in at least one place — Appendix C's `interfaceHealthMetricsList` discovery is the precedent.
- `DeviceHealthSnapshot` will need a decision, deferred to Stage 2, on how FMC's per-family `startTime`/`endTime` collapse into one `windowStart`/`windowEnd`. Leave room for that.

---

# Stage 2 — Response mapping and normalization (pure, no I/O)

### Goal / outcome

Given any committed fixture, a pure function returns a `DeviceHealthSnapshot[]` with correct sparse-group semantics, correct interface-name fallback, correct enum preservation, and correct per-device/per-group error isolation — for **both** backends, with their divergent field names handled explicitly rather than by accident. Nothing in this stage touches the network, the clock, the filesystem, or a logger.

This is the highest-value stage in the plan and should carry the most tests (`DESIGN.md` §12).

### Scope

- `src/backends/scc/map.ts` — `mapSccResponse(payload: unknown): { snapshots: DeviceHealthSnapshot[]; parseErrors: ParseError[]; unknownEnums: UnknownEnum[] }`.
  - Per `DESIGN.md` §3.2.6: `undefined` checks not truthiness checks, no default-to-zero anywhere, `interfaceName` → `interface` fallback, no interface filtering, ISO 8601 timestamp parsing with unparseable values *dropped with a warning rather than fatal*.
  - Returns diagnostics (parse errors, unknown enums) as **data**, not by calling a logger or a metrics counter. Keeping the function pure is what makes it exhaustively testable; the adapter layer translates the returned diagnostics into `ftd_exporter_parse_errors_total{group}` and `ftd_exporter_unknown_enum_total{metric,value}`.
- `src/backends/fmc/map.ts` — two-part, because FMC's shape is fundamentally different:
  1. `mapFmcFamilyResponse(family, payload)` — handles one `items[]` wrapper for one device and one metric family. Must use the **verified FMC names**: `interfaceHealthMetricsList` (not `interfaceHealthMetrics`), `currentLinkStatus`/`currentOperationalStatus` (not `linkStatus`/`operationalStatus`). CPU/MEM/DISK field names *are* identical to SCC and can share a helper — but do that via an explicitly-named shared helper, not by defaulting to SCC's parser, so the divergences stay visible in the code.
  2. `mergeFmcFamilies(deviceUid, deviceName, familyResults[])` — assembles the N per-family results for one device into one `DeviceHealthSnapshot`.
- `src/backends/fmc/time.ts` — an explicit parser for FMC's `"YYYY-MM-DD HH:mm:ss.SSS UTC"` format (`DESIGN.md` §14.1: *"the FMC adapter's parser must not assume a shared timestamp format across backends"*). Do **not** hand this string to `new Date()` and hope; parse it deliberately and reject anything that does not match.
- `src/backends/fmc/empty.ts` (or inline) — recognize the `{"links":{},"paging":{"count":0}}` empty-result shape as **absence, not error** (`DESIGN.md` §14.6, Appendix C). This must produce an omitted group, not a parse error, or every appliance fleet will show phantom parse errors for `CHASSIS_STATS` forever.
- `src/backends/shared/interfaces.ts` — the interface-entry mapper parameterized by field-name variant, so the SCC/FMC status-field divergence lives in exactly one place with both variants named.
- A decision to record in code comments and in this plan: **window-timestamp merge policy for FMC.** Each family response carries its own `startTime`/`endTime`, and they will differ. Recommended v1 rule: take the *latest* `endTime` and its paired `startTime` across the families successfully fetched for that device, since `DESIGN.md` §4.5's purpose is staleness detection and the newest window is the correct answer to "has this device stopped reporting." Document it as a choice; it is not specified in `DESIGN.md`.

### Dependencies

- Stage 1 (domain model + fixtures).
- Nothing external. This stage is fully completable offline.

### Testing steps

Directly from `DESIGN.md` §12.1, plus the FMC-specific cases Appendix C makes necessary:

**SCC mapper (`test/unit/scc-map.test.ts`)**

1. `full-live.json` → 1 snapshot, 9 interfaces, CPU/MEM/DISK populated with exact expected floats.
2. `full-live.json` → asserts `snapshot.chassis`, `.ha`, `.raVpn`, `.s2sTunnels` are all `undefined` — and specifically **not** objects with zero values.
3. `cpu-group-absent.json` → `snapshot.cpu` is `undefined` while `memory`, `disk`, `interfaces` are populated. Per-group absence, not per-device.
4. `all-groups-present.json` → all five conditional groups mapped, with exact field-by-field assertions against Appendix B names.
5. `interface-name-absent.json` → interfaces missing `interfaceName` get `interfaceName === interface` (e.g. `Ethernet1/2`), and the hardware id is never lost.
6. `zero-values.json` → a genuine `0` CPU reading survives as `0`, not dropped. **Name this test after the bug class** (`cpu lina 0 is emitted, not swallowed by truthiness`) so its purpose survives refactors.
7. All-zero interfaces present in output, not filtered.
8. `malformed.json` → per-device skip: a device with a broken `cpuHealthMetrics` still yields its `memory`/`disk`/`interfaces`; a device with a broken root (missing `deviceUid`) is skipped entirely while sibling devices survive; `parseErrors` names the affected group.
9. Unparseable `startTime` → `windowStart` undefined, a diagnostic emitted, and the rest of the snapshot intact (not fatal, per §3.2.6).
10. Unknown enum (`linkStatus: "FLAPPING"`) → recorded in `unknownEnums`, not crashed on.
11. `s2s-1000-tunnels.json` → 1000 tunnel entries mapped; used later as the cardinality tripwire input for Stage 3.

**FMC mapper (`test/unit/fmc-map.test.ts`)**

12. `fmc/cpu.json` → lina/snort/system extracted from the `items[0].cpuHealthMetrics` path; `deviceUid` from `items[0].id`, `deviceName` from `items[0].name`.
13. `fmc/interface.json` → **9 interfaces read from `interfaceHealthMetricsList`**, with a test that explicitly asserts the mapper produces zero interfaces when handed a payload using SCC's `interfaceHealthMetrics` key. This is the regression test for the exact bug `DESIGN.md` §14.1 warns about (*"a naive adapter reusing SCC's field names verbatim against FMC would silently produce empty series"*).
14. `fmc/interface.json` → link/operational status read from `currentLinkStatus`/`currentOperationalStatus`; a companion test asserting SCC's `linkStatus` key on an FMC payload yields *absent*, not a false `UP`.
15. `duplexMode: "FULL"` is mapped (it is populated on FMC, unobserved on SCC).
16. FMC timestamp parsing: `"2026-07-31 09:57:10.009 UTC"` → correct epoch. Plus negative cases: an ISO 8601 string, an empty string, a garbage string — each rejected cleanly.
17. `fmc/empty-family.json` → group omitted, **`parseErrors` empty**. Assert no diagnostic is produced; this is normal.
18. `mergeFmcFamilies` → CPU success + MEM success + INTERFACE empty + CHASSIS empty produces one snapshot with `cpu`, `memory`, no `interfaces`, no `chassis`, and the window timestamps from the newest successful family.
19. `mergeFmcFamilies` → all families failed for a device → no snapshot emitted for that device (it does not appear as an empty shell).
20. Cross-backend equivalence: an SCC payload and an FMC payload describing the *same* logical device state produce **identical** `DeviceHealthSnapshot` objects for CPU/MEM/DISK/INTERFACE. This is the strongest available proof of `DESIGN.md` G2 and it belongs here, not in the adapters.

### Risks

- **The naming-divergence class of bug is the headline risk.** Appendix C proves two divergences already exist between the backends for interface data. There are likely more in the groups that have never been observed populated. Mitigation: never let one backend's mapper fall through to the other's field names, and keep test 13/14 (the "wrong key yields nothing" tests) as permanent guards.
- **Truthiness bugs.** `if (m.cpu.lina)` drops a real `0`. `exactOptionalPropertyTypes` helps but does not prevent it. Test 6 is the guard; consider a lint rule banning truthiness checks on `number | undefined`.
- **Silent coercion.** `Number(undefined)` is `NaN`, and `NaN` in exposition format is valid-but-wrong. Reject non-numbers explicitly rather than coercing; assert in tests that no snapshot field is ever `NaN`.
- **§14.1 (HA/VPN/chassis field names)** — the mapping for these groups is written from Cisco documentation only, on *both* backends. It may simply be wrong. This is unavoidable; the mitigations are the experimental label, `--dump-raw`, and keeping these groups' code isolated so a correction is local.
- **§14.6 propagation delay** — if someone tests policy-gated absence against a live SCC tenant immediately after deploying a policy change, they will see the group still present and conclude gating does not work. Note this in the test file comments, not just the README.

### Where later adjustment is likely

- **HA/VPN/chassis mapping is provisional on both backends** and expected to change in a minor release per `DESIGN.md` §13.
- The FMC window-timestamp merge policy is a v1 judgement call and may need to become per-family timestamps if operators find the merged value misleading. Note that changing it would *not* change any metric name, only values — so it is a patch-level change, which is a good reason to make the choice now and move on.
- If §14.2 resolves toward `fpinterfacestatistics` being authoritative, a second FMC interface mapper appears alongside this one. Structure `map.ts` so the interface family is a separable unit.

---

# Stage 3 — Metrics rendering layer

### Goal / outcome

A `DeviceHealthSnapshot[]` renders to a Prometheus exposition-format string containing exactly the metric names, labels, and types specified in `DESIGN.md` §4.2/§4.5/§11 — and, critically, **a device or interface that disappears from the snapshot disappears from the output**, with no stale series and no zeros for absent groups. The full metric surface (the project's versioned public API, per `DESIGN.md` §13) is frozen at the end of this stage.

### Scope

- `src/metrics/registry.ts` — a `prom-client` `Registry`. Decide and document whether `collectDefaultMetrics()` targets the same registry (gated by `ENABLE_DEFAULT_METRICS`, default `true`, per `DESIGN.md` §11).
- `src/metrics/collector.ts` — **the custom collector.** Per `DESIGN.md` §4.8 this is the single most important correctness detail in the layer: on each scrape it reads the cache snapshot, calls `reset()` on every device gauge, and repopulates from the snapshot. Verify against the installed `prom-client` version which mechanism is actually available and correct — a `collect` callback on each metric, or a registry-level collector registration — and pin the choice with a test rather than an assumption.
- `src/metrics/device-metrics.ts` — declarations for every `ftd_*` metric in `DESIGN.md` §4.2:
  - `ftd_cpu_usage_ratio{device_uid,device_name,component}` (0-1; a 2026-08-04 naming-conventions audit converted these three from `_percent`/0-100 — see `DESIGN.md` §14.13)
  - `ftd_memory_usage_ratio{...,component}`
  - `ftd_disk_usage_ratio{...}`
  - the 13 `ftd_interface_*` series with `interface`, `interface_name`, `interface_type` labels
  - `ftd_chassis_fan_rpm{fan}`, `ftd_chassis_psu_{fan,input,output}_up{psu}`
  - `ftd_ha_node_status{status}` as a **state set** (one series per possible value, exactly one at 1), `ftd_ha_node_info{node_type}` always 1
  - `ftd_ravpn_sessions_{active_avg,inactive_avg,peak_concurrent}`
  - `ftd_s2s_tunnel_state{tunnel_id,tunnel_name,state}` state set
  - `ftd_health_window_{start,end}_timestamp_seconds` as gauge **values**, not exposition-format explicit timestamps (`DESIGN.md` §4.5)
- `src/metrics/enum-render.ts` — the §4.4 representation rules: binary UP/DOWN → single boolean gauge named for the true condition; multi-valued → state set with all values emitted; informational → `_info` gauge = 1; unrecognized → `status="unknown"` plus `ftd_exporter_unknown_enum_total`. Enum label values lowercased (`DESIGN.md` §4.3).
- `src/metrics/self.ts` — every `ftd_exporter_*` metric from `DESIGN.md` §11, declared here even where nothing yet increments them, so Stages 6–11 wire into existing declarations rather than inventing names ad hoc. Notably `ftd_exporter_build_info{version,commit,node_version,backend}`, `ftd_exporter_cache_age_seconds` (**computed at scrape time**, so it is a collect-callback gauge not a set-on-poll gauge), `ftd_exporter_series` (renamed from `_series_total` by the 2026-08-04 naming-conventions audit — a gauge must never carry a `_total` suffix), and the bounded `reason` label set for `ftd_exporter_poll_errors_total`.
- `docs/METRICS.md` (or a README section) — the generated/maintained metric reference. Worth generating from the declarations so it cannot drift.

Rules to enforce mechanically here:

- **Empty-string labels are never emitted** (`DESIGN.md` §4.3) — omit the label entirely.
- **Absent groups emit nothing** — not zero, not `NaN` (`DESIGN.md` §4.8).
- `endpoint` labels on self-metrics use **templated paths**, never interpolated UUIDs (`DESIGN.md` §11).

### Dependencies

- Stage 1 and 2 (types + mapper output to render).
- `prom-client` installed.
- Nothing external.

### Testing steps

1. **Golden-output tests.** Render each SCC and FMC fixture's mapped snapshot and compare against a committed expected exposition-format file. Golden files are the right tool here because the metric surface is the public API — an accidental rename becomes a visible diff. Keep them small enough to review.
2. **Exposition-format validity.** Parse the rendered output with a strict parser (or shell out to `promtool check metrics` where available) for every fixture, including the 1000-tunnel one. Asserts `HELP`/`TYPE` ordering, label escaping, and numeric formatting.
3. **Series disappearance (the §4.8 test).** Render snapshot A containing devices `a` and `b`; then render snapshot B containing only `a`; assert **no** `device_uid="b"` series appear in the second output. Repeat at interface granularity: an interface removed from a device must vanish. `DESIGN.md` §12.2 calls this *"easy to get wrong, invisible in production until someone notices a decommissioned device still reporting."*
4. **Absent-group non-emission.** For the SCC live fixture, assert the rendered text contains zero occurrences of `ftd_ha_`, `ftd_chassis_`, `ftd_ravpn_`, `ftd_s2s_` — and explicitly assert that `ftd_ha_node_status` does not appear with value `0` anywhere.
5. **State-set completeness.** With HA present, assert all five `status=` series exist and exactly one is `1`.
6. **Boolean naming.** `linkStatus: "DOWN"` → `ftd_interface_link_up 0` (present, valued zero) — distinguish this from group absence, which emits nothing. This distinction is subtle and worth an explicitly-named test.
7. **Interface-name fallback in labels.** Assert `interface_name="Ethernet1/2"` when upstream had no `interfaceName`, and that no series carries `interface_name=""`.
8. **Zero-value emission.** A genuine `0` renders as `0`, not omitted.
9. **Unknown enum.** `linkStatus: "FLAPPING"` → boolean omitted (per §4.4: booleans omit on unrecognized), `ftd_exporter_unknown_enum_total{metric="ftd_interface_link_up",value="flapping"}` incremented.
10. **Timestamp gauges.** Window start/end render as unix-second gauge values matching the fixture's parsed dates, on both an ISO 8601 (SCC) and a `" UTC"`-suffixed (FMC) input.
11. **Cardinality tripwire.** Render the 1000-tunnel fixture and assert `ftd_exporter_series` matches an independently computed count. Also record the rendered byte size in the test output as an informal budget signal.
12. **`reset()` correctness under concurrency.** Two overlapping `collect()` calls (a real possibility with two scrapers) must not interleave a `reset()` with another render's population. Assert stability, and if the chosen `prom-client` mechanism cannot guarantee it, render to a string under a mutex or build a fresh registry per scrape.

### Risks

- **`gauge.reset()` correctness is the top risk in this stage**, exactly as `DESIGN.md` §4.8 says. Two specific traps: (a) resetting only some metrics, so most series refresh correctly and one stale family lingers — test 3 must cover every metric family, not just CPU; (b) resetting *self*-metrics along with device metrics, which would zero counters on every scrape. Keep device metrics and self metrics separately resettable, and add a test that a counter survives a scrape.
- **`prom-client` API-surface uncertainty.** The custom-collector mechanism differs across major versions. Pin the version, and let test 12 fail loudly if an upgrade changes semantics.
- **Interleaved scrape/poll.** A poll replacing the cache mid-render must not produce a half-old, half-new page. `DESIGN.md` §2.2 specifies an *atomic* cache replacement (swap an immutable object reference), which makes this safe — but only if the renderer reads the reference **once** at the top of `collect()` and uses that snapshot throughout. Assert this in a test that swaps the cache during a render.
- **§14.4 (interface byte units)** is baked into names here: `ftd_interface_input_bytes_avg`. If §14.4 resolves to "per second," the name should have been `..._bytes_per_second`, and changing it post-1.0 is a major bump (`DESIGN.md` §14.11). The neutral `_avg` suffix is the deliberate hedge; do not "improve" it.
- **§14.11 more broadly** — everything named in this stage is a compatibility contract from the moment it is published. Treat the golden files as a change-detection mechanism and require an explicit changelog entry whenever one changes.

### Where later adjustment is likely

- **`ftd_interface_*_bytes_avg` naming**, pending §14.4.
- **All chassis/HA/VPN metric names**, explicitly permitted to change in a minor release while `0.x`/experimental (`DESIGN.md` §13).
- **A `FTD_DISABLE_S2S_TUNNEL_METRICS` opt-out**, flagged in `DESIGN.md` §4.2 as a reasonable v1.1 addition if cardinality pressure is reported. Structure the collector so a family can be switched off without surgery.
- Histogram bucket boundaries for `ftd_exporter_poll_duration_seconds` and `ftd_exporter_upstream_request_duration_seconds` — the defaults will be wrong for a 250-request FMC cycle. Expect to retune once Stage 8 produces real timings. Bucket changes are not a metric rename, so this is safe to iterate on.

---

# Stage 4 — Configuration loader and validation

### Goal / outcome

The process **exits non-zero with a single actionable message** on any invalid configuration combination — before it opens a socket, before it authenticates, before the first poll — and a valid environment produces a frozen, fully-typed config object. Every rule in `DESIGN.md` §8.5 is enforced and individually tested. Startup logs an effective-configuration summary with every secret redacted.

Runs in parallel with Stages 1–3.

### Scope

- `src/config/types.ts` — a discriminated union on `BACKEND_TYPE`, so that `config.backend.kind === 'fmc'` narrows to a type where `FMC_HOST` is non-optional. This makes "required for the selected backend" a compile-time property in the adapters, not a runtime hope.
- `src/config/load.ts` — read `process.env`; load `.env` via Node's native `process.loadEnvFile()` (`DESIGN.md` §2.4, §2.7 — **no `dotenv`**). Honor `--env-file`. **Process-environment values must win over `.env` contents** — this is what makes the Docker and Kubernetes paths work with no `.env` present.
- `src/config/validate.ts` — every rule from `DESIGN.md` §8.5:
  - `BACKEND_TYPE` exactly `scc` or `fmc`.
  - All variables required by the selected backend present and non-empty.
  - Variables belonging to the *other* backend, if set → **warning** (the "edited the wrong block of `example.env`" hint).
  - `SCC_BASE_URL` parses as a URL with `https:`. **`http:` rejected** (`DESIGN.md` §9.1).
  - `POLL_INTERVAL_SECONDS` a positive integer; **≥ 30 on the SCC backend**, a startup **error** not a silent clamp.
  - `SCC_TIME_RANGE`/`FMC_TIME_RANGE` ∈ `{5m,15m,30m,1h}`.
  - `FMC_MAX_CONCURRENT_REQUESTS` 1–10 inclusive.
  - Every path-valued variable exists and is readable **at startup**.
  - `METRICS_TLS_CERT_PATH` and `METRICS_TLS_KEY_PATH` set together or not at all.
  - `FMC_TLS_INSECURE_SKIP_VERIFY=true` **together with** `FMC_CA_BUNDLE_PATH` → **error** (`DESIGN.md` §8.5/§9.6 — the most dangerous possible misconfiguration).
  - `METRICS_TLS_MIN_VERSION` ∈ `{TLSv1.2, TLSv1.3}` only.
  - **Legacy SCC hostname detection** → warning, per `DESIGN.md` §14.12: if `SCC_BASE_URL` matches `edge.*.cdo.cisco.com`, warn that the host is deprecated-but-functional and recommend the `api.<region>.security.cisco.com` form. Cheap, and turns a future silent outage into months of advance notice.
  - **Close a gap in §8:** `ENABLE_DEFAULT_METRICS` appears in `DESIGN.md` §11 (default `true`) but is missing from the §8 configuration tables. Add it to the loader, to `example.env`, and to the config reference. Flag this as a documentation fix, not a new decision.
- `src/config/redact-summary.ts` — the redaction-aware effective-config formatter. `DESIGN.md` §9.4 requires that **no code path prints the raw config object**; a good enforcement is to make the config type carry secrets in a branded wrapper whose `toJSON`/`toString` returns `[REDACTED]`, so an accidental interpolation is safe by construction.
- `Object.freeze` (deep) the result.
- **`example.env`** — the authoritative user-facing configuration doc (`DESIGN.md` §8, §13). Every variable with purpose and acquisition instructions. Must include verbatim: the SCC token-generation click-path with **Read-only API Only User** recommended (`DESIGN.md` §3.2.2); the full regional base-URL table with the legacy form marked deprecated (§3.2.1); the FMC **dedicated API-only service account requirement** with the UI/API session-conflict explanation next to `FMC_USERNAME` (§3.3.2); the `# INSECURE — lab/test only. Never set true in production.` label on `FMC_TLS_INSECURE_SKIP_VERIFY` (§9.6). Placeholders only, ever.

The repo already has a partial local `.env` (gitignored) covering the core and SCC blocks — useful as a smoke-test input, but `example.env` must be written fresh from `DESIGN.md` §8 to guarantee completeness.

### Dependencies

- Stage 0. Stage 5's redaction is ideally available for the summary formatter; if Stages 4 and 5 run in parallel, define the redaction interface first and let both sides code against it.
- Nothing external.

### Testing steps

`DESIGN.md` §12.1 requires *every* §8.5 rule tested. One test per rule, named after the rule:

1. Missing `BACKEND_TYPE` → non-zero exit, message names the variable.
2. `BACKEND_TYPE=SCC` (wrong case) → error. Decide and test whether case is normalized or rejected; rejecting is more predictable.
3. `BACKEND_TYPE=scc` with `SCC_API_TOKEN` missing → error naming `SCC_API_TOKEN`.
4. `BACKEND_TYPE=scc` with `FMC_HOST` also set → **warning**, still starts.
5. `SCC_BASE_URL=http://...` → error mentioning HTTPS is mandatory.
6. `SCC_BASE_URL=not-a-url` → error.
7. `POLL_INTERVAL_SECONDS=15` with `BACKEND_TYPE=scc` → error citing the 2-req/min limit. Same value with `BACKEND_TYPE=fmc` → **accepted** (the floor is backend-specific; `DESIGN.md` §3.3.4).
8. `POLL_INTERVAL_SECONDS=0` / `-5` / `abc` / `60.5` → error for each.
9. `SCC_TIME_RANGE=10m` → error listing the four valid values.
10. `FMC_MAX_CONCURRENT_REQUESTS=0` and `=11` → error; `=10` → accepted.
11. `FMC_CA_BUNDLE_PATH=/nonexistent` → startup error, not a first-poll failure.
12. `METRICS_TLS_CERT_PATH` without `METRICS_TLS_KEY_PATH` → error.
13. `FMC_TLS_INSECURE_SKIP_VERIFY=true` + `FMC_CA_BUNDLE_PATH` set → error. **Name this test after the security property**, since it is the most consequential validation rule in §8.5.
14. `FMC_TLS_INSECURE_SKIP_VERIFY=true` alone → accepted, and the loud multi-line `error`-severity warning is emitted (`DESIGN.md` §9.6).
15. `FMC_METRIC_FAMILIES=CPU,MEM` → parsed to two families; `=CPU,BOGUS` → error naming the invalid family; whitespace and casing handled.
16. Legacy hostname `https://edge.eu.cdo.cisco.com/api/rest` → warning, still starts, and the adapter still constructs correct paths (§14.12, §3.2.1 — the base URL is an **opaque prefix**).
17. Process env overrides `.env` for the same key.
18. Defaults: with only the required variables set, `METRICS_PORT=10049`, `METRICS_BIND_ADDRESS=0.0.0.0`, `POLL_INTERVAL_SECONDS=60`, `LOG_LEVEL=info`, `LOG_FORMAT=json`, `REQUEST_TIMEOUT_SECONDS=30`, `FMC_DISCOVERY_INTERVAL_SECONDS=900`, `FMC_MAX_CONCURRENT_REQUESTS=5`, `ENABLE_DEFAULT_METRICS=true`.
19. **Redaction of the summary:** the effective-config output contains neither the `SCC_API_TOKEN` value nor the `FMC_PASSWORD` value, using realistic token-shaped strings.
20. **Multiple simultaneous errors** report all of them, not just the first. An operator fixing one variable per restart cycle is a bad experience.
21. Windows-specific: `FMC_CA_BUNDLE_PATH=C:\certs\ca.pem` resolves and reads correctly (`DESIGN.md` §5.4).

### Risks

- **Hand-rolled validation growing past its budget.** `DESIGN.md` §2.7 chooses hand-rolled at ~100 lines and explicitly names `zod` as an acceptable deviation if validation grows. With ~25 variables, conditional requirements, and cross-field rules, it will be closer to 250 lines. That is still fine, but if it starts sprouting a mini-schema DSL, take the documented `zod` off-ramp rather than building one badly.
- **Error-message quality.** This is the operator's first contact with the tool. A message must name the variable, state what was wrong, and state what is valid. Consider asserting on message *content* in tests, not just on exit code.
- **Secret leakage via the summary path.** The branded-secret-wrapper approach is worth the small friction; test 19 is the guard.
- **§14.12** — the legacy-hostname warning depends on a hostname pattern Cisco could change. Keep the pattern in one named constant.
- **The SCC `POLL_INTERVAL_SECONDS` floor of 30** is derived from the 2/min limit assuming one request per cycle. If retries also count (`DESIGN.md` §14.10, conservatively assumed **yes**), 30 s is already tight. Consider whether the *validated* floor should stay 30 (per §8.5, which is authoritative) while the *default* stays 60 and the docs recommend 60. Do not change the floor; do make sure the retry budget in Stage 6 cannot exceed the limit at a 30 s interval.

### Where later adjustment is likely

- New optional variables are a **minor** version bump (`DESIGN.md` §13) — expect `FTD_DISABLE_S2S_TUNNEL_METRICS`, high-resolution-mode flags, and possibly per-backend timeout overrides.
- The FMC request-budget **warning threshold** (~70%) will need tuning against real fleet sizes (Stage 8/16).
- If §14.7 (multi-target) ever lands, env vars stop scaling and a config file appears. The frozen-typed-object boundary is what makes that additive; keep the loader's output shape independent of its input mechanism.

---

# Stage 5 — Logger with boundary redaction

### Goal / outcome

A single sanctioned output path exists, and a token cannot reach stdout even if a future contributor logs an entire error object or an entire config object. Structured JSON, one object per line, with `backend` and (where applicable) `device_uid` on every line. A `text` mode exists for human-readable local runs.

Runs in parallel with Stages 1–4.

### Scope

- `src/log/logger.ts` — hand-rolled, ~60–100 lines, per `DESIGN.md` §2.6's recommendation (holding runtime dependencies at two). Levels `error|warn|info|debug` from `LOG_LEVEL`; `json` (default) and `text` from `LOG_FORMAT`; base fields (`backend`, `version`) bound once at construction; child loggers for per-device context.
- `src/log/redact.ts` — **the redaction serializer, applied at the logger boundary, not at call sites** (`DESIGN.md` §9.4 — call-site redaction is *"a design flaw, not a coding standard"*). Redacts by case-insensitive key name and by pattern: `SCC_API_TOKEN`, `FMC_PASSWORD`, `authorization`, `x-auth-access-token`, `x-auth-refresh-token`, `password`, `token`, `secret`, `apikey`, `bearer` → `[REDACTED]`. Recursive, cycle-safe, depth-limited.
- `src/log/error-normalize.ts` — **the most commonly missed leak path**, per `DESIGN.md` §9.4: HTTP clients attach the full request (headers included) to thrown errors, so an unhandled rejection can print a bearer token. Errors must pass through a normalizer extracting **only** method, sanitized URL, status code, and message — and **never** serializing arbitrary attached properties. Walk `cause` chains with the same rule.
- `src/log/sanitize-url.ts` — redact query-string *values* while keeping keys, because credentials sometimes land in query params and because the FMC filter string embeds device UUIDs (`DESIGN.md` §9.4).
- **Header allowlist, not denylist** (`DESIGN.md` §9.4): request headers are never logged wholesale; only an explicit allowlist of non-sensitive names, so a newly added auth header cannot leak by default.

### Dependencies

- Stage 0. Nothing external.

### Testing steps

1. **The §9.4 canonical test:** construct a realistic `undici`-shaped error carrying `headers: { authorization: 'Bearer eyJ...' }` (and a nested `cause` with the same), pass it through `logger.error`, and assert the token string does not appear anywhere in the output. `DESIGN.md` §9.4 names this specifically as *"the leak path most likely to regress."*
2. Log the frozen config object at `debug` → no `SCC_API_TOKEN` value, no `FMC_PASSWORD` value in output.
3. Redaction by key name at depth: `{a:{b:{authorization:'x'}}}` → redacted.
4. Redaction is case-insensitive: `Authorization`, `AUTHORIZATION`, `x-Auth-Access-Token` all redacted.
5. **Redaction does not corrupt legitimate data:** a device named `token-gateway-01` is not mangled. This is the false-positive risk of pattern-based redaction and worth an explicit test.
6. URL sanitization: `?filter=device_uuid:abc;metric:CPU` → values redacted, keys retained; the sanitized form is still useful for debugging.
7. Cycles and non-serializable values (`BigInt`, functions, `Symbol`) do not throw and do not lose the log line.
8. Level filtering: at `LOG_LEVEL=info`, `debug` lines are absent; at `debug`, per-request URLs appear but **response bodies never do** (`DESIGN.md` §2.6).
9. JSON output is one valid JSON object per line, newline-terminated, with no interleaving under rapid concurrent writes.
10. `LOG_FORMAT=text` produces human-readable output and applies **the same redaction** — a text-mode bypass would be a real bug.
11. Header allowlist: an unlisted header (`x-new-auth-thing`) is absent from output entirely, not redacted-but-named. Proves allowlist semantics.

### Risks

- **Redaction bypass via a path nobody thought of** — `console.log` used directly somewhere, an unhandled rejection printed by Node's default handler, or a thrown error's `stack` containing a serialized request. Mitigations: a lint rule banning `console.*` outside the logger module; explicit `process.on('unhandledRejection')` / `uncaughtException` handlers that route through the normalizer (Stage 11); test 1 covering the stack case.
- **Over-redaction hiding the debugging value of logs** — see test 5. Redact values, keep keys and structure.
- **Performance** at `debug` on a 250-request FMC cycle: deep-cloning every logged object per line is measurable. Redact lazily during serialization rather than pre-cloning.
- If redaction complexity outgrows the hand-rolled budget, `DESIGN.md` §2.6 names `pino` (with its `redact` path-matching) as the considered-and-declined alternative. Reopening that is a legitimate, pre-authorized deviation — but it adds a dependency tree, so weigh it against §2.7's two-dependency selling point.

### Where later adjustment is likely

- The redaction key/pattern list grows every time a new upstream header appears. Keep it in one exported constant with a comment pointing at `DESIGN.md` §9.4.
- Log-line schema (field names) will settle after Stage 9 produces real poll-cycle summaries. Log field names are *not* part of the versioned public API (`DESIGN.md` §13 defines that as metrics + labels + env vars), so this is safe to iterate on — worth stating in `CONTRIBUTING.md` so nobody treats log fields as a contract.

---

# Stage 6 — HTTP client, TLS policy, retry, and limiters

### Goal / outcome

A single `HttpClient` exposing **only `get()`** — so a write request is unrepresentable, per `DESIGN.md` §9.5 — with per-backend TLS trust scoped to that backend's `undici` Agent (never a global trust store), a TLS 1.2 floor set explicitly, bounded total-time budgets via `AbortSignal`, classified errors, jittered bounded retries, a concurrency cap, an SCC minimum-spacing guard, and an FMC rolling-window request-budget guard. All of it testable with a fake clock and a local self-signed server.

### Scope

- `src/http/agent.ts` — `undici` `Agent` factory. Per `DESIGN.md` §2.7/§9.1:
  `connect: { ca, minVersion: 'TLSv1.2', rejectUnauthorized: !insecureSkipVerify }`, `connectTimeout`, and `connections` sized to the concurrency cap. One Agent per backend; **never** `NODE_EXTRA_CA_CERTS`, whose process-wide scope is precisely why `undici` was chosen over global `fetch` (`DESIGN.md` §9.6).
- `src/http/client.ts` — `get(url, { headers, timeoutMs, endpointTemplate })`. Responsibilities: attach the `AbortSignal` total-time budget (default 30 s from `REQUEST_TIMEOUT_SECONDS`); **do not follow redirects for authenticated requests** (`DESIGN.md` §9.1 — credentials must not be replayable to an attacker-influenced `Location`); record `ftd_exporter_upstream_requests_total{endpoint,status_code}` and `ftd_exporter_upstream_request_duration_seconds{endpoint}` using the **templated** endpoint label, never an interpolated UUID (`DESIGN.md` §11).
- `src/http/errors.ts` — the six-class taxonomy from `DESIGN.md` §2.5 (fatal config / auth-recoverable / auth-likely-fatal / rate-limited / transient / schema-parse) mapped to a discriminated error union carrying the `reason` label value for `ftd_exporter_poll_errors_total`.
- `src/http/retry.ts` — max 3 attempts, exponential backoff with **full jitter**, base 500 ms, cap 8 s, retrying only transient classes and `429`; honor `Retry-After` when present (`DESIGN.md` §2.5, §3.2.4).
- `src/http/limiter.ts` — a promise-based concurrency limiter enforcing `FMC_MAX_CONCURRENT_REQUESTS`, feeding the Agent pool. Increments `ftd_exporter_rate_limit_deferrals_total` when it defers.
- `src/http/spacing.ts` — the SCC **monotonic-clock** minimum-spacing guard: ≥ 30 s between requests per FMC UID, *"implemented in the adapter itself… not merely documented as advice"* (`DESIGN.md` §3.2.4). Use `performance.now()`/`process.hrtime`, not `Date.now()`, so a wall-clock adjustment or NTP step cannot let a burst through.
- `src/http/budget.ts` — the FMC rolling-60-second GET counter, throttling to stay under 300 (`DESIGN.md` §3.3.4). Counts **every attempt including retries**, per the conservative reading of `DESIGN.md` §14.10.
- `src/http/clock.ts` — an injectable clock interface. Every limiter/retry test depends on this; retrofitting it is painful.

### Dependencies

- Stage 0; Stage 4 for config shape; Stage 5 for error normalization at log time; Stage 3 for the self-metric declarations to increment.
- `undici` installed.
- A locally generated self-signed certificate for the TLS tests. Generate at test time (in-process, or via a committed test-only key pair) — note `.gitignore` excludes `*.pem`/`*.key`/`*.crt`, so committing test certs requires either a deliberate negative ignore rule or in-test generation. **Prefer in-test generation**; a committed private key in a security-focused repo is a bad look even when harmless, and it will trip secret scanning (Stage 14).

### Testing steps

**TLS (`DESIGN.md` §12.2 requires all three paths proven)**

1. Local `node:https` server with a self-signed cert. Request **without** a CA bundle → verification failure with a recognizable error class.
2. Same server **with** `FMC_CA_BUNDLE_PATH` pointing at that cert → success, **and hostname verification still active** (`DESIGN.md` §9.6 — this is real verification against an operator-chosen anchor, not a bypass).
3. Same server with `FMC_TLS_INSECURE_SKIP_VERIFY=true` → success.
4. **Trust scoping (the §9.6 correctness test):** with the FMC CA bundle loaded, a request to a *different* self-signed host through the **SCC** Agent must still **fail**. This is the test that proves the CA did not leak into a global trust store, and it is the single most important test in this stage.
5. Hostname mismatch: cert with SAN `fmc.example.internal`, request to `127.0.0.1` → fails even with the CA bundle loaded. Confirms the documented footgun in `DESIGN.md` §9.6 behaves as described, so the troubleshooting text is accurate.
6. TLS 1.1-only server → connection refused by the client's `minVersion: 'TLSv1.2'`.

**Retry / backoff**

7. Fake clock: `503`, `503`, `200` → exactly 3 attempts, success returned, delays within the jittered `[0, min(cap, base·2^n)]` envelope.
8. `503` × 4 → gives up after 3 attempts with a transient-class error.
9. `400`, `401`, `403` → **no retry** (not transient).
10. `429` with `Retry-After: 5` → waits ~5 s (fake clock), retries once, and increments `poll_errors_total{reason="rate_limited"}`.
11. `429` with no `Retry-After` → falls back to jittered backoff.
12. `AbortSignal` total-time budget fires mid-request → timeout-class error, socket destroyed, no leak. Assert with an intentionally slow mock server.
13. **Retries respect the SCC limit** (`DESIGN.md` §3.2.4 point 4): with the spacing guard active, a poll plus its retries cannot exceed 2 requests in any rolling 60 s window. Assert by driving a failing endpoint for 5 fake minutes and counting attempts.

**Limiters**

14. Concurrency: 50 queued requests with cap 5 → observed in-flight count never exceeds 5; all complete; deferral counter increments.
15. Concurrency cap 10 accepted; 11 rejected at config validation (Stage 4 cross-check).
16. SCC spacing: two `get()` calls back-to-back → the second is delayed to ≥ 30 s. With a **monotonic** clock, jumping the wall clock backwards mid-test does not release it early.
17. FMC budget: drive 400 requests in a fake minute → throttled below 300, deferrals counted, no request dropped.
18. Budget guard counts failed attempts too (§14.10's conservative assumption) — assert 100 × `500` responses consume 100 units of budget.

**Client surface**

19. `HttpClient` has **no** `post`/`put`/`patch`/`delete`. Enforce with a type-level test plus a grep-style lint check that `undici.request` is called with `method: 'GET'` in exactly one place.
20. A `302` with a `Location` on an authenticated request → **not followed**; surfaced as an error or a non-2xx result. Assert the `Authorization` header was never sent to the redirect target.
21. `endpoint` label is templated: a request to `/v1/inventory/managers/<uuid>/health/metrics` records `endpoint="/v1/inventory/managers/:fmcUid/health/metrics"`.

### Risks

- **TLS trust-scoping bugs are the marquee risk here.** It is easy to construct one shared Agent, or to fall back to global `fetch` for "just this one call," and silently widen trust process-wide. Test 4 is the guard; also assert in a test that `process.env.NODE_EXTRA_CA_CERTS` is never written by the exporter.
- **`undici` Agent lifecycle.** Agents must be closed on shutdown (Stage 11) or the process will not exit cleanly. Also verify `connections` interacts sanely with the external limiter — double-limiting is fine (the outer one binds), but a *smaller* Agent `connections` value than the limiter cap would silently serialize requests and make the FMC backend mysteriously slow.
- **Fake-clock fidelity.** `undici` has internal timers; a naive fake clock can deadlock a test. Prefer injecting the clock into *our* retry/limiter code and using real (very short) timeouts for `undici`'s own paths.
- **§14.10 (do failed requests count against SCC's limit?)** — unknown. The design assumes yes. If wrong, the exporter is merely slightly conservative, *"the correct direction to err."* Keep the assumption in one named constant with a comment so it is trivially flipped.
- **Retry storms.** A misconfigured retry that ignores the spacing guard would burn the entire SCC budget in seconds and look like an auth failure. Test 13 exists for exactly this.
- **`Retry-After` parsing** — it can be seconds *or* an HTTP date. Handle both; a date-format `Retry-After` parsed as seconds yields an absurd delay.

### Where later adjustment is likely

- **Retry/backoff constants** (3 attempts, 500 ms base, 8 s cap) will be tuned once real upstream latency distributions exist — a 250-request FMC cycle behaves very differently from SCC's single call. These are not part of the public API, so tuning is a patch.
- **`FMC_MAX_CONCURRENT_REQUESTS` default of 5** is a deliberately conservative guess leaving headroom for the operator's other API consumers (`DESIGN.md` §3.3.4). Real fleets may want 8; the hard cap of 10 stays.
- The budget-guard warning threshold (~70% of 300/min) is provisional pending Stage 16.
- If a zero-dependency posture ever becomes a hard requirement, `DESIGN.md` §2.7 names a `node:https` wrapper as the acceptable fallback. Keeping all `undici` usage behind `HttpClient` is what makes that swap局 local — worth preserving as an invariant.

---

# Stage 7 — `HealthBackend` interface and SCC adapter

### Goal / outcome

With a valid SCC configuration, `fetchSnapshot()` performs exactly **one** upstream GET, respects the 30 s spacing floor, and returns mapped `DeviceHealthSnapshot[]` — and the configured `SCC_TIME_RANGE` is provably present in the request query string.

Can be built in parallel with Stage 8.

### Scope

- `src/backends/types.ts` — the `HealthBackend` interface verbatim from `DESIGN.md` §2.3: `kind`, `init()`, `fetchSnapshot()`, `close()`. Keep it exactly this narrow; every additional method is a place for one backend's model to leak into the other.
- `src/backends/scc/adapter.ts`:
  - `init()` — near-trivial. Static non-expiring bearer token read once (`DESIGN.md` §3.2.2): no token endpoint, no refresh, no expiry tracking. Optionally validate the token shape (non-empty, no surrounding whitespace — a pasted token with a trailing newline is a predictable support case).
  - `fetchSnapshot()` — `GET {SCC_BASE_URL}/v1/inventory/managers/{SCC_FMC_UID}/health/metrics?timeRange={SCC_TIME_RANGE}` with `Authorization: Bearer <token>`, through the spacing guard, then `mapSccResponse`.
  - **`SCC_BASE_URL` is an opaque prefix** (`DESIGN.md` §3.2.1) — append only the endpoint-relative suffix so a legacy `.../api/rest` base URL keeps working. Do not parse, normalize, or region-detect it beyond the deprecation warning from Stage 4.
  - Translate mapper diagnostics into `ftd_exporter_parse_errors_total{group}` / `ftd_exporter_unknown_enum_total{metric,value}`.
- `src/backends/scc/errors.ts` — map the documented `400/401/403/405/500` responses (`DESIGN.md` §3.2.3, Appendix B) onto the §2.5 taxonomy. Notably `401`/`403` with a valid-looking token → *"auth — likely fatal"*: a loud actionable error, keep running, **do not hot-loop**, backoff applies, `ftd_exporter_up 0`.

### Dependencies

- Stages 1, 2, 3 (types, mapper, metrics), 4 (config), 5 (logging), 6 (client).
- **Blocked externally only for live confirmation** (§3.3). Everything here is fully buildable and testable against `undici` `MockAgent`.

### Testing steps

1. **The dead-config test** (`DESIGN.md` §3.2.3, §12.1 — called out twice so it is not forgotten). Configure `SCC_TIME_RANGE=1h`; assert the intercepted request URL contains `timeRange=1h`. Parameterize over all four valid values. This directly targets a known configuration-bug class: validating a variable and then hardcoding a default (here, `5m`) regardless of what was configured.
2. URL construction with a **current** base URL → `https://api.eu.security.cisco.com/firewall/v1/inventory/managers/<uid>/health/metrics?timeRange=5m`.
3. URL construction with a **legacy** base URL (`https://edge.eu.cdo.cisco.com/api/rest`) → `.../api/rest/v1/inventory/managers/<uid>/health/metrics?timeRange=5m`. Proves the opaque-prefix treatment (`DESIGN.md` §3.2.1).
4. Base URL with and without a trailing slash → identical result, no `//`.
5. `Authorization: Bearer <token>` header present and exactly once; the token appears in **no** log line at any level.
6. `fetchSnapshot()` against the sanitized live fixture → 1 snapshot, 9 interfaces, matching Stage 2's expectations end to end.
7. **Exactly one upstream request per `fetchSnapshot()`** — assert the intercept count. This is the property the whole poll-cache-serve design rests on.
8. Two `fetchSnapshot()` calls in quick succession → the second is deferred ≥ 30 s by the spacing guard (fake clock).
9. `401` → auth-likely-fatal class, one loud log, **no immediate retry loop**; a subsequent call is not fired within the backoff window.
10. `429` with `Retry-After` → honored; `poll_errors_total{reason="rate_limited"}` increments.
11. `500` → retried per policy, then transient-class failure.
12. Malformed JSON body with a `200` status → parse-class error; no crash.
13. A `200` with an empty array → zero snapshots, **not** an error. A tenant with no devices is valid.
14. `close()` destroys the Agent; no open handles keep the process alive (assert with `process._getActiveHandles`-style checks or a test that the process exits).

### Risks

- **Base-URL concatenation bugs** across the legacy/current split — tests 2–4 cover it, but note the two forms differ in path prefix *and* host, so any "helpful" normalization is a bug generator. Concatenate and stop.
- **§14.12** — the legacy host could stop working without notice. Nothing to do beyond the Stage 4 warning.
- **§14.10** — spacing-guard accounting must include retries; verified in Stage 6 test 13, worth re-asserting at adapter level.
- **§3.2.5 health-policy gating** is the *"single most likely support question."* It is not an adapter bug, but the adapter is where it manifests as a missing group. Ensure absent groups log at `debug` only (`DESIGN.md` §4.8 — a warning that fires constantly on healthy systems trains operators to ignore logs) and that README troubleshooting leads with it (Stage 14).
- Token with trailing whitespace producing a confusing `401` — trim and/or warn.

### Where later adjustment is likely

- `DESIGN.md` §4.6 lists Smart License status, device inventory/connectivity, and certificate expiry as **v1.1** additions on this backend, each a separate request. Structure the adapter so a second endpoint is an additive method, not a rewrite of `fetchSnapshot()`.
- §14.9 (cdFMC native HealthMonitor endpoints) as an opt-in high-resolution mode is v1.1+ at most.
- The spacing constant (30 s) and the retry budget interact with §14.10; both may relax if Cisco documents that failures are free.

---

# Stage 8 — Standalone FMC adapter (`FmcTokenManager`, discovery, fan-out)

### Goal / outcome

With a valid FMC configuration, the adapter authenticates via Basic auth, resolves the domain UUID, discovers devices with correct client-side pagination, fans out N×M `aggregatemetrics` requests under the concurrency and budget limits, and assembles a `DeviceHealthSnapshot[]` in which **partial success is success** — 48 of 50 devices returning data publishes 48 and records 2 failures (`DESIGN.md` §2.5). Token lifecycle is managed proactively and is fully covered by fake-clock tests.

This is the largest stage. Budget accordingly. Can be built in parallel with Stage 7.

### Scope

- `src/backends/fmc/token-manager.ts` — the `FmcTokenManager` (`DESIGN.md` §3.3.2), the most intricate state machine in the project:
  - `POST /api/fmc_platform/v1/auth/generatetoken` with **HTTP Basic auth header**, *not* a JSON body. Response is **204 with no body**; tokens arrive as **response headers** `X-auth-access-token` / `X-auth-refresh-token`, alongside `DOMAIN_UUID` and `DOMAINS` (confirmed in Appendix C).
  - `POST /api/fmc_platform/v1/auth/refreshtoken` requires **both** token headers and returns a new pair.
  - 30-minute lifetime; **proactive refresh at ~80% (≈24 min), never lazily on a 401**.
  - **Refresh counter; at 3, discard both tokens and do a full `generatetoken`.**
  - **Single-flight acquisition** — one shared in-flight promise so N concurrent device requests never trigger N logins. With `FMC_MAX_CONCURRENT_REQUESTS=5` and 250 requests per cycle this is not theoretical.
  - On an unexpected `401`, force re-auth and retry the failed request **exactly once**.
  - Emits `ftd_exporter_fmc_token_refreshes_total`, `..._reauths_total`, `..._token_expiry_timestamp_seconds`.
  - **Never logs token material**; tokens live in memory only (`DESIGN.md` §9.3).
  - Note: `POST` is required here, which sits awkwardly with Stage 6's GET-only client (`DESIGN.md` §9.5). Resolve deliberately: give the token manager a **narrow, private, auth-only** transport that can issue exactly these two `POST`s to exactly these two paths, and keep the general `HttpClient` GET-only. Document the exemption in a code comment referencing §9.5, and add a test that the auth transport rejects any other path or method.
- `src/backends/fmc/domain.ts` — domain resolution in the documented order (`DESIGN.md` §3.3.1): explicit `FMC_DOMAIN_UUID` → the `DOMAIN_UUID` response header / access-token claims → `GET /api/fmc_platform/v1/info/domain` as an enumeration fallback. Appendix C confirms the header is present, which is simpler and more reliable than decoding token claims — prefer it, keep claim-decoding as the fallback.
- `src/backends/fmc/discovery.ts` — `GET /api/fmc_config/v1/domain/{domainUUID}/devices/devicerecords?expanded=true` with **explicit client-side pagination**: `offset`/`limit`, default page size 25, max 1000, **no paging headers**, so track offset and continue until a short page (`DESIGN.md` §3.3.3). Use `limit=1000` with an offset loop and a sanity cap on total pages. Runs on its own slower cadence (`FMC_DISCOVERY_INTERVAL_SECONDS`, default 900); results cached; a discovery failure reuses the previous list and increments `ftd_exporter_discovery_errors_total`; exports `ftd_exporter_devices_discovered`.
- `src/backends/fmc/filter.ts` — the filter-string builder producing exactly `device_uuid:<uuid>;metric:<FAMILY>;timeRange:<range>` (`DESIGN.md` §3.3.4). A semicolon-delimited `key:value` string, **not** standard query parameters — `DESIGN.md` §12.1 flags it as *"a small function with an unusual format and therefore a likely bug site"* deserving dedicated tests.
- `src/backends/fmc/adapter.ts` — orchestration: ensure token → ensure device list → for each device × each enabled family in `FMC_METRIC_FAMILIES`, issue one GET through the limiter and budget guard → per-family map → merge per device → return snapshots. Per-device and per-family failures are isolated.
- `src/backends/fmc/sizing.ts` — the **startup request-budget projection and warning** (`DESIGN.md` §3.3.4): compute `devices × families × (60 / pollInterval)` requests/minute and warn when it exceeds ~70% of 300. The worked example in the design (50 devices × 5 families at 60 s = 250/min, *"uncomfortably close to the 300/minute ceiling"*) is the case to reproduce in a test. *"Better to tell the operator at startup that 400 devices at 60 s cannot work than to discover it via 429s."*
- **Document the device-UUID-`0` footgun** in code comments and README (`DESIGN.md` §3.3.1): UUID `0` means "the FMC appliance itself" in some health filters. v1 does not query it. Consider asserting in the discovery path that a device with id `0` is never enqueued.

### Dependencies

- Stages 1–6. Stage 7 is *not* a dependency (parallel).
- FMC fixtures from Stage 1, including the `Device not connected.` and empty-family captures.
- **Externally gated for live confirmation only** (§3.2). The lab FMC has already resolved the field-name questions that would otherwise block this stage — that is why Stage 8 is buildable now rather than blocked.
- HA/VPN/chassis families on FMC remain **unresolvable** (§3.4) and ship as provisional mappings behind the experimental label.

### Testing steps

**`FmcTokenManager` (fake clock — `DESIGN.md` §12.1 says this is fully testable without a network)**

1. `init()` → one `generatetoken` with a correct Basic auth header; tokens extracted from response headers; `DOMAIN_UUID` captured; **no body parsed** (assert it works against a genuinely empty 204).
2. Advance to 24 min (80% of 30) → exactly one proactive `refreshtoken`, carrying **both** token headers; no request was allowed to fail first.
3. Advance through 3 refreshes, then further → the 4th acquisition is a full `generatetoken`, **not** a refresh; `reauths_total` increments; the refresh counter resets.
4. **Single flight:** 20 concurrent `getToken()` calls with no valid token → exactly **one** `generatetoken` request. Repeat mid-refresh: 20 calls during an in-flight refresh → one refresh.
5. Unexpected `401` on a device request → forced re-auth, the failed request retried **once**, and a second consecutive `401` does **not** loop.
6. `generatetoken` returning `401` (bad credentials) → auth-likely-fatal, loud log, no hot loop.
7. `generatetoken` returning a response **missing** `X-auth-access-token` → clear error naming the missing header (a plausible reverse-proxy-strips-headers failure).
8. `ftd_exporter_fmc_token_expiry_timestamp_seconds` tracks the actual expiry across refresh and re-auth.
9. Token material appears in **no** log output across all of the above (feed the manager's own errors through the logger).
10. The auth transport rejects a non-`generatetoken`/`refreshtoken` path and any non-`POST` method (the §9.5 exemption boundary).

**Discovery**

11. Single page of 4 devices (sanitized live fixture) → 4 devices; `devices_discovered` = 4.
12. **The >25 truncation case** (`DESIGN.md` §12.2 names it explicitly): a mock serving 40 devices across pages → all 40 discovered. Then assert that a single-request implementation would have returned 25 — i.e. the test must fail if the offset loop is removed.
13. Exactly-`limit`-sized final page (e.g. 1000 devices in exactly one full page) → loop terminates via a following empty page rather than hanging or double-counting. This off-by-one is the classic pagination bug when there are no paging headers.
14. Page-count sanity cap → loop aborts with an error rather than spinning forever on a misbehaving server.
15. Discovery failure after a prior success → previous device list reused, `discovery_errors_total` increments, the metric poll **still succeeds**.
16. Discovery cadence: with `FMC_DISCOVERY_INTERVAL_SECONDS=900` and `POLL_INTERVAL_SECONDS=60`, 15 poll cycles trigger exactly **one** discovery (fake clock). This is a real request-budget property, not a nicety.
17. `expanded=true` present; device id and name extracted; a device with `id: "0"` is never enqueued for health requests.

**Filter builder**

18. Exact string equality: `device_uuid:395e114a-cc97-11ed-a71f-c6cf66a8f073;metric:CPU;timeRange:5m`. No stray spaces, no trailing semicolon, correct ordering.
19. All five families and all four time ranges produce well-formed strings.
20. Encoding: the filter is a query-parameter *value* containing `:` and `;` — assert the final URL encodes it in a form the live FMC accepts (Appendix C's captured `links.self` shows the accepted form; use it as the reference).
21. A UUID containing unexpected characters is rejected or encoded, never silently truncated at a delimiter.

**Adapter orchestration**

22. 4 devices × 5 families → exactly 20 requests; concurrency never exceeds the cap.
23. **Partial success:** device 3 returns `Device not connected.` for all families → 3 snapshots returned, `parse_errors`/failure counters reflect device 3, and `ftd_exporter_devices` (3) differs from `devices_discovered` (4) — which `DESIGN.md` §11 designs as the way to spot per-device failures.
24. Per-family partial: CPU succeeds, INTERFACE returns the empty-result shape → snapshot has `cpu`, no `interfaces`, and **no parse error**.
25. `FMC_METRIC_FAMILIES=CPU,MEM` → 8 requests for 4 devices, and no `CHASSIS_STATS` request is issued at all.
26. `CHASSIS_STATS` empty on all devices (the FTDv reality) → no chassis series and **no warnings** (`DESIGN.md` §4.8).
27. Mid-cycle token expiry: the token expires after request 7 of 20 → one re-auth, request 7 retried, all 20 eventually succeed, **exactly one** login.
28. Sizing warning: 50 devices × 5 families at 60 s → startup warning fires with the projected 250/min figure. 10 devices × 5 families at 60 s → no warning.
29. Budget throttling: 400 devices × 5 families → requests deferred to stay under 300/min, cycle takes longer, no `429`s provoked.
30. Interface data flows end to end from `interfaceHealthMetricsList` with `currentLinkStatus` through to rendered `ftd_interface_link_up` — the cross-layer version of Stage 2's naming-divergence test.

### Risks

- **Token refresh races** are the highest-risk implementation detail here. Specific hazards: (a) a refresh completing while 5 requests hold the *old* token → they `401` and each trigger a re-auth, potentially blowing past the refresh ceiling; (b) two concurrent refreshes each incrementing the counter, hitting 3 prematurely; (c) a refresh that fails leaving the manager with neither token and no recovery path. Mitigations: strict single-flight (test 4), refresh-count increments only inside the single-flight critical section, and an explicit "no tokens" state that always triggers `generatetoken`.
- **The Cisco UI/API session conflict** (`DESIGN.md` §3.3.2): one account cannot be used via UI and API simultaneously — *"doing so silently logs the other session out."* If the implementer tests with their own admin account, they will see random `401`s and mysterious UI logouts and will likely misdiagnose it as a token-manager bug. **Use a dedicated API-only service account for all lab testing**, and put this at the top of the FMC troubleshooting docs.
- **Pagination truncation** — silent, and the field symptom is "the exporter only sees 25 devices." `ftd_exporter_devices_discovered` exists specifically as the field tripwire (`DESIGN.md` §3.3.3). Tests 12–13 are the CI guard.
- **Request-volume blowups.** A bug that re-discovers on every poll, or retries aggressively per device, can multiply the request count enough to trip 300/min and get the exporter's source IP throttled — degrading the operator's *other* API consumers too. Test 16 and the budget guard are the defenses.
- **§14.1 remaining gaps** — HA/VPN/chassis field names on FMC were never captured (no HA or VPN device in the lab). These mappings are provisional; ship them experimental and behind the same absence semantics so they are harmless when absent.
- **§14.2 (which interface source is authoritative)** — marked **must resolve**. v1 uses the health family. `fpinterfacestatistics` returned `400 Unsupported device` on FTDv regardless of policy state. Record the assumption in a code comment at the interface-fetch site so a future implementer knows it is an assumption.
- **The `POST` exemption for auth** could erode `DESIGN.md` §9.5's "a write is unrepresentable" property if the auth transport becomes a general-purpose escape hatch. Test 10 plus a narrow type signature (path restricted to a two-member union) keeps it contained.
- Timestamp-format regression: FMC's `" UTC"` format must not be handed to an ISO parser (§14.1). Stage 2 test 16 covers the parser; add an adapter-level assertion that window timestamps are plausible (within a few hours of now) so a silently-wrong parse surfaces.

### Where later adjustment to expect

- **HA/VPN/chassis on FMC**: the `/devicehapairs/ftddevicehapairs`, `/health/ravpngateways`, `/health/tunnelstatuses|tunnelsummaries`, and `/chassis/fmcmanagedchassis/...` paths (`DESIGN.md` §3.3.4, Appendix A) are the on-prem parallels to SCC's in-payload groups. Whether v1 fetches them at all, versus relying on `CHASSIS_STATS` in the health family, is a live question — each is an extra request per device against a 300/min budget. Recommend v1 uses only the `aggregatemetrics` families and treats the dedicated HA/VPN endpoints as v1.1, documented as such.
- **`FMC_MAX_CONCURRENT_REQUESTS` default (5)** and the **budget warning threshold (~70%)**, pending real fleet observation.
- **Discovery interval default (900 s)** — fine for stable fleets, possibly too slow for environments that onboard devices frequently.
- If §14.2 resolves toward the device-record path, an alternative interface source appears as an opt-in.

---

# Stage 9 — Poller, cache, and self-metric wiring

### Goal / outcome

A running poller fetches on its own timer with startup jitter and escalating failure backoff, atomically replaces an in-memory cache, and drives every `ftd_exporter_*` metric. An upstream outage produces `ftd_exporter_up 0` with a growing `ftd_exporter_cache_age_seconds` while the **last-good snapshot continues to serve** — never a gap.

### Scope

- `src/poller/cache.ts` — the `MetricsCache`: a single immutable `{ snapshots, fetchedAt }` object replaced by reference assignment (`DESIGN.md` §2.2). Readers take the reference once. **In-memory only, never written to disk** (`DESIGN.md` §9.3) — this is what enables `readOnlyRootFilesystem` in Stages 13.
- `src/poller/poller.ts` — a `setTimeout` loop (not `setInterval`, so a slow cycle cannot overlap itself) at `POLL_INTERVAL_SECONDS`:
  - **Startup jitter** of 0–10% of the interval before the first poll, so restarted replicas do not thunder against one FMC (`DESIGN.md` §2.5).
  - **Poll-level escalating backoff** on whole-cycle failure: 2×, 4×, … capped at 10 minutes, reset immediately on recovery (`DESIGN.md` §2.5).
  - **Partial success is success** — publish what came back, record the failures.
  - One `info` line per cycle summarizing devices, duration, and outcome (`DESIGN.md` §2.6).
  - Never overlap cycles; if a cycle is still running when the timer fires, skip and log.
- `src/poller/self-metrics.ts` — wire the recorder: `ftd_exporter_up`, `poll_total`, `poll_errors_total{reason}`, `poll_duration_seconds`, `last_successful_poll_timestamp_seconds`, `devices`, `series`, `build_info`, `tls_verification_disabled`. `cache_age_seconds` is **computed at scrape time**, not set on poll (`DESIGN.md` §11).
- Graceful cancellation: an in-flight poll must be abortable via `AbortSignal` for shutdown (Stage 11).

### Dependencies

- Stage 3 (metrics), Stage 6 (client), and at least one of Stage 7/8.

### Testing steps

1. Fake clock: 5 cycles at a 60 s interval → 5 upstream fetch calls, cache updated each time, `poll_total` = 5.
2. Startup jitter: over many constructions, the first poll delay is within [0, 6 s] for a 60 s interval and is not always identical.
3. `setTimeout` semantics: a cycle taking 90 s at a 60 s interval → cycles do not overlap; the next fires after completion; a skip is logged.
4. **Stale-serve behavior** (the §2.2 core property): cycle 1 succeeds, cycles 2–4 fail → the cache still holds cycle 1's snapshot, `ftd_exporter_up` is `0`, `cache_age_seconds` grows monotonically, and `last_successful_poll_timestamp_seconds` still points at cycle 1. Assert the rendered `/metrics` still contains device series — *"a 90-second-old CPU average is still useful; a gap is not."*
5. Recovery: cycle 5 succeeds → `up` returns to `1`, backoff factor resets to 1× immediately.
6. Escalating backoff: 4 consecutive failures → delays follow 2×, 4×, 8×, capped at 600 s.
7. Atomic replacement: swap the cache mid-render (Stage 3 test 12's counterpart at this layer) → the rendered page is wholly old or wholly new, never spliced.
8. `poll_errors_total{reason}` uses only the bounded label set from `DESIGN.md` §11 (`auth`, `rate_limited`, `timeout`, `network`, `http_5xx`, `parse`, `unknown`) — assert an unmapped error lands in `unknown` rather than minting a new label value. Unbounded `reason` values would be a cardinality bug in the *exporter's own* metrics.
9. `devices` reflects the snapshot count and **drops** when devices disappear (the §11 discovery/pagination tripwire).
10. `series` matches an independent count of rendered series.
11. `cache_age_seconds` is computed at scrape time: advance the fake clock without polling and assert the value grows between two scrapes with no poll in between.
12. Abort: cancel mid-poll → the cycle stops, the cache is unchanged, no unhandled rejection.
13. `build_info` carries version, commit, node version, and the active backend.

### Risks

- **Serving stale data indefinitely is intentional** (`DESIGN.md` §2.2) and will look like a bug to a reviewer. Comment it at the code site and make sure the README explains the alerting story (`ftd_exporter_up`, `cache_age_seconds`) — otherwise an operator will "fix" it by emptying the cache and break `rate()` continuity for everyone.
- **Timer drift and unref'd handles** — an unref'd timer lets the process exit silently; a ref'd one blocks shutdown. Get this right in Stage 11 and assert process exit in a test.
- **Overlapping cycles on the FMC backend** are a real hazard: a 250-request cycle can plausibly exceed 60 s, and two overlapping cycles would double the request rate against a 300/min budget. Test 3 is the guard; consider also logging a warning when a cycle exceeds the interval, since it means the configuration is under-sized (`DESIGN.md` §3.3.4's sizing guidance).
- **Backoff interacting with the SCC spacing guard** — both delay requests, and double-delaying is safe, but assert that recovery is not needlessly slow (backoff resets *immediately* on success per §2.5).
- **§14.10** again: if failures consume SCC budget, escalating poll backoff is doing double duty as budget protection. That is fine and intended.

### Where later adjustment is likely

- Backoff cap (10 min) and escalation factor may need tuning against real outage patterns.
- Histogram buckets for `poll_duration_seconds` — a single-request SCC cycle and a 250-request FMC cycle have wildly different distributions. Consider backend-specific bucket sets; not a metric rename, so patch-safe.
- If §14.8 (HA/leader election) is ever built, the poller is where leadership gating attaches. Keep the "should I poll now" decision in one place.

---

# Stage 10 — HTTP server, `/metrics`, `/healthz`, `/readyz`

### Goal / outcome

`curl http://localhost:10049/metrics` returns valid exposition format rendered from cache with **no upstream call in the request path**, and scrape latency is bounded and tiny regardless of upstream state. `/healthz` reports process liveness independent of upstream health; `/readyz` returns 200 only after the first successful poll. Optional native TLS and mTLS work when configured.

### Scope

- `src/server/server.ts` — `node:http`, or `node:https` when `METRICS_TLS_CERT_PATH` + `METRICS_TLS_KEY_PATH` are set (`DESIGN.md` §2.7, §9.2 — the framework-free choice is what makes this a two-line difference). Bind to `METRICS_BIND_ADDRESS`:`METRICS_PORT`. `METRICS_TLS_MIN_VERSION` (TLS 1.2 floor); `METRICS_TLS_CLIENT_CA_PATH` → `requestCert` + `rejectUnauthorized` for mTLS.
- `src/server/routes.ts` — exactly three routes plus a 404:
  - `GET /metrics` → `registry.metrics()`, correct `Content-Type`.
  - `GET /healthz` → 200 while the process is alive and serving. **Deliberately independent of upstream health** (`DESIGN.md` §7.2 — otherwise a Cisco outage triggers an endless restart loop that fixes nothing and destroys the cache). This is a correctness requirement, not a simplification.
  - `GET /readyz` → 200 once the cache has been populated by a successful poll; 503 before that, so a Kubernetes Service does not route scrapes to a pod that would serve an empty page.
  - Any other method or path → 404/405. No body parsing, no middleware, no routing library.
- Sensible server hardening: `headersTimeout`, `requestTimeout`, `keepAliveTimeout` set explicitly; a modest max header size.
- **No authentication on `/metrics` in v1** (`DESIGN.md` §9.2) — a decision, not an omission. It must be documented as such in the README, with the guidance to not expose `/metrics` to untrusted networks and to prefer `METRICS_BIND_ADDRESS` scoping on multi-homed hosts.

### Dependencies

- Stage 3 (registry), Stage 9 (cache + readiness signal), Stage 4 (config).

### Testing steps

1. `GET /metrics` → 200, correct `Content-Type`, body parses as exposition format.
2. **No upstream call on scrape:** with a `MockAgent` that fails any request, scrape 20 times → 20 successes, zero upstream requests. This is the poll-cache-serve contract (`DESIGN.md` §2.2) and deserves an explicitly named test.
3. Scrape latency bounded: with the upstream mock configured to hang, `/metrics` still responds in single-digit milliseconds.
4. **N scrapers cost 1 upstream request** (`DESIGN.md` §2.2): 10 concurrent scrapes during one poll interval → still one upstream fetch.
5. `/healthz` → 200 even while `ftd_exporter_up` is `0`. Name the test after the restart-loop hazard.
6. `/readyz` → 503 before the first successful poll, 200 after.
7. `/readyz` stays 200 after a later poll failure (readiness reflects "cache populated," not "upstream healthy") — decide this explicitly and test it; flapping readiness would pull the pod out of the Service and lose the stale-serve benefit the whole design is built on.
8. Unknown path → 404; `POST /metrics` → 405.
9. `METRICS_BIND_ADDRESS=127.0.0.1` → not reachable from a non-loopback address.
10. TLS listener: with cert+key configured, HTTPS works and plain HTTP does not.
11. TLS 1.1 client → rejected by the `TLSv1.2` floor.
12. mTLS: with `METRICS_TLS_CLIENT_CA_PATH` set, a client with a valid cert succeeds and a client with none is rejected.
13. Port already in use → clear startup error and non-zero exit, not a silent failure.
14. Windows: binding and `curl`ing works identically (CI matrix).

### Risks

- **`/healthz` accidentally depending on upstream health** is the classic exporter mistake and `DESIGN.md` §7.2 calls it out specifically. Test 5 is the guard. Same for `/readyz` flapping (test 7).
- **TLS file reading at startup vs. at first connection** — read and validate at startup (Stage 4 already requires path readability), so a bad key fails fast.
- **Certificate reload requires a restart in v1** (`DESIGN.md` §9.2). Documented plainly; not a bug.
- **`registry.metrics()` under concurrent scrapes** interacts with the Stage 3 `reset()` mechanism. Two simultaneous scrapes must not corrupt each other (Stage 3 test 12).
- **Unbounded connection accumulation** from a misbehaving scraper — hence the explicit server timeouts.

### Where later adjustment is likely

- TLS **hot reload on file change** is flagged as a reasonable v1.1 addition (`DESIGN.md` §9.2).
- Bearer/basic auth on `/metrics` is deliberately absent; if operator demand appears, it is additive.
- `/readyz` semantics may need refinement once real Kubernetes rollouts are observed.

---

# Stage 11 — Entrypoint, lifecycle, and `--dump-raw`

### Goal / outcome

`node dist/index.js` is a well-behaved long-running process: it validates config and exits non-zero on failure, checks the Node version, logs a redacted config summary, starts the server and poller in the right order, handles `SIGTERM`/`SIGINT` with a graceful shutdown that exits 0, and routes unhandled rejections through the redacting logger. `--dump-raw` produces sanitized raw upstream JSON on stdout for fixture contribution.

### Scope

- `src/index.ts` — startup sequence, in this order:
  1. Node version check (`DESIGN.md` §5.2).
  2. Load + validate + freeze config; **exit non-zero on any failure** (`DESIGN.md` §2.4).
  3. Construct the logger; emit the redacted effective-config summary.
  4. Emit the loud multi-line `error`-severity warning if `FMC_TLS_INSECURE_SKIP_VERIFY=true`, and set `ftd_exporter_tls_verification_disabled 1` (`DESIGN.md` §9.6).
  5. Set `ftd_exporter_build_info`; optionally `collectDefaultMetrics()` per `ENABLE_DEFAULT_METRICS`.
  6. Construct the single backend for `BACKEND_TYPE` — **exactly one per process** (`DESIGN.md` §2.3); `init()`.
  7. Start the HTTP server (so `/healthz` answers immediately and `/readyz` correctly reports not-ready).
  8. Start the poller (with startup jitter).
- `src/lifecycle.ts` — `SIGTERM`/`SIGINT` handler: stop accepting connections, cancel the in-flight poll via `AbortSignal`, `close()` the backend (destroying `undici` Agents), **exit 0** (`DESIGN.md` §6.2 — exec-form `ENTRYPOINT` so the process is PID 1 and receives signals directly). A hard-exit timer (e.g. 10 s) guarantees termination if something hangs.
- `process.on('unhandledRejection')` / `('uncaughtException')` routed through the error normalizer, then exit non-zero. Unrouted, these are a token-leak path (Stage 5).
- `src/cli.ts` — minimal argument handling: `--env-file`, `--dump-raw`, `--version`, `--help`. No CLI framework.
- `src/dump-raw.ts` — the capture mode from `DESIGN.md` §3.3.5: perform one poll's worth of upstream requests, write the **raw** upstream JSON to stdout, then exit. Requirements: it must pass through **the same redaction path**, and the docs must warn that dumps may still contain device names and topology detail. Recommend it also apply the Stage 1 fixture sanitizer by default (with an opt-out), so the artifact a contributor pastes into an issue is already safe — this is the mechanism that makes §3.4's blocked items community-solvable, so its usability matters.

### Dependencies

- Stages 4–10.

### Testing steps

1. Invalid config → non-zero exit, one actionable message, no socket opened (assert the port is still free).
2. Valid config → server listening, `/readyz` 503 then 200 after the first poll.
3. `SIGTERM` → server stops accepting, in-flight poll cancelled, exit code **0**, within the shutdown budget.
4. `SIGTERM` while a poll is mid-flight → no unhandled rejection, no partial cache write.
5. Hang-guard: with a deliberately stuck close, the hard-exit timer fires and the process still terminates.
6. `--version` prints and exits 0. `--help` lists the flags.
7. `--env-file=/path/to/other.env` is honored, and process env still wins over its contents.
8. Simulated Node 22 (`process.version` stubbed) → clear message, non-zero exit.
9. `FMC_TLS_INSECURE_SKIP_VERIFY=true` → the multi-line warning appears at `error` severity **and** `ftd_exporter_tls_verification_disabled 1` is present on `/metrics`. `DESIGN.md` §9.6 calls the metric *"the design's most useful anti-drift control"* — a startup log scrolls away, a metric persists and is alertable.
10. An unhandled rejection carrying an `Authorization` header → logged redacted, process exits non-zero.
11. `--dump-raw` against a mock → raw upstream JSON on stdout, **no tokens present**, sanitized identifiers, exit 0.
12. `--dump-raw` output round-trips: feed it back into the Stage 2 mapper and get a valid snapshot. This proves a contributed fixture will actually be usable, which is the whole point of the mode.
13. No open handles keep the process alive after a clean shutdown.

### Risks

- **Signal handling swallowed by a shell wrapper** — `DESIGN.md` §6.2 requires exec-form `ENTRYPOINT`. Verify in Stage 13B with an actual `docker stop` timing test, not just by reading the Dockerfile.
- **`undici` Agents not destroyed** → the process hangs on shutdown, and Kubernetes escalates to `SIGKILL`. Test 13 catches it.
- **Startup ordering.** Starting the poller before the server means a slow first `init()` (FMC login + discovery) delays `/healthz` and can fail a liveness probe during rollout. Server first, deliberately.
- **`--dump-raw` leaking real data** is the notable new risk in this stage: its entire purpose is to move real payloads out of a customer's environment. Over-sanitize rather than under-sanitize, warn prominently in both the CLI output and the docs, and make test 11 thorough.
- **§14.1** — `--dump-raw` is the primary mitigation for the unresolved HA/VPN/chassis field names. Its quality directly determines whether those gaps ever close. Do not treat it as a throwaway debug flag.

### Where later adjustment is likely

- `--dump-raw` ergonomics will change on first real contributor use — likely wanting per-device or per-family selection, and a file-output option (which conflicts with the "writes nothing to disk" property of `DESIGN.md` §9.3; keep it stdout-only and let the operator redirect).
- Shutdown timeout may need tuning against Kubernetes `terminationGracePeriodSeconds`.

---

# Stage 12 — Integration test suite

### Goal / outcome

The assembled process is verified end to end against mock upstreams, covering every scenario in `DESIGN.md` §12.2, with **no live credentials anywhere in CI** (`DESIGN.md` §12.3).

### Scope

- `test/integration/` using `undici`'s `MockAgent` for client-level interception and a real `node:http`/`node:https` fixture server where transport behavior matters (TLS, timeouts, connection counts).
- `test/helpers/` — a mock SCC server, a mock FMC server (with a scriptable token lifecycle, pagination, and per-device failure injection), a fake clock harness, and an exposition-format parser assertion helper.

### Testing steps

Directly from `DESIGN.md` §12.2:

1. **Full poll-cache-serve cycle, SCC:** start the process against a mock, wait for the first poll, scrape `/metrics`, assert expected series with expected values.
2. **Full cycle, FMC:** token acquisition → discovery → N×M fan-out → merged snapshot → scrape.
3. `/metrics` output validated as **parseable exposition format** in both cases.
4. **`429` handling and backoff** — mock returns `429` with `Retry-After`; assert the honored delay and the `rate_limited` error reason.
5. **`401` triggering FMC re-auth** — mock invalidates the token mid-cycle; assert exactly one re-auth and cycle completion.
6. **Upstream failure serving stale cache with `ftd_exporter_up 0`** — the §2.2 contract at process level.
7. **FMC pagination across multiple pages, including the >25-device case** that a naive implementation truncates.
8. **Partial device failure producing a partial snapshot** — 48 of 50 devices succeed; assert 48 devices' series present, `devices` = 48, `devices_discovered` = 50.
9. **Series disappearance** — poll a snapshot containing device B, then one without it, and assert B's series are **gone** from `/metrics`. `DESIGN.md` §12.2 calls this out separately from the unit test because the whole-process path (cache swap + collector + registry) is where it actually breaks.
10. **TLS behavior, all three paths** against a self-signed mock: CA bundle enables success; absence causes verification failure; the insecure flag bypasses it.
11. Concurrent scrapes during a poll → consistent output, one upstream fetch.
12. Graceful shutdown under load: scrape in a loop, send `SIGTERM`, assert clean exit and no dropped in-flight response.
13. Long-run soak (short in CI, longer locally): 100 poll cycles → memory stable (via `nodejs_heap_size_used_bytes` from default metrics), no handle growth, series count stable.

### Risks

- **Test flakiness from real timers.** Prefer injected clocks; where real timers are unavoidable, use generous margins and assert ordering rather than exact durations. A flaky integration suite gets disabled, and then the §12.2 guarantees quietly stop holding.
- **`MockAgent` vs. real transport coverage gap.** `MockAgent` intercepts above the socket, so it cannot validate TLS, connection-count limits, or timeout behavior. Use the real server for those (tests 10, and connection-cap assertions).
- **Windows differences** in port binding, socket teardown timing, and path handling — CI matrix, not local-only runs.
- **§12.3 is a hard rule:** no CI job may hold an SCC token or FMC password. *"CI secrets in a public repository are a standing exfiltration target (particularly via pull requests from forks)."* Enforce by never adding a repository secret for upstream credentials at all.
- **§12.3 second rule:** no test may require specific hardware. Chassis/HA/VPN paths use synthetic fixtures only.

### Where later adjustment is likely

- The mock FMC server will grow as the HA/VPN endpoints land in v1.1.
- Soak-test thresholds once real memory behavior at fleet scale is known (feeds Stage 13C's resource limits).

---

# Stage 13 — Packaging: standalone, Docker, Kubernetes

### Goal / outcome

Three independently followable deployment paths exist and have each been executed at least once by the implementer: a bare process (Windows, macOS, Linux) under a supervisor; a hardened container running read-only as non-root; and a Kubernetes Deployment with probes, a Secret, and a Service. Per `DESIGN.md` §5/§6/§7, each path's documentation is **self-contained** — a user reads only theirs plus §8's configuration reference.

**Split into three sub-stages — 13A (Standalone), 13B (Docker), 13C (Kubernetes) — specifically so implementation and testing are not blocked on the same infrastructure at the same time.** 13A's Windows portion needs nothing beyond the implementer's own machine and can start immediately; 13A's Linux/macOS portions, and all of 13B/13C, need a second test machine (an Ubuntu VM, per the environment note below) that takes time to provision. Building all three sub-stages' artifacts (Dockerfile, manifests, systemd unit, launchd plist) can still happen in one sitting — it is *testing* that is sequenced by machine availability, not the writing.

### Test environment and what each path is actually verified against

Two machines are available for this stage: the implementer's own Windows 11 machine, and an Ubuntu VM (once provisioned) running Docker and `microk8s` (chosen over `kind` specifically because `microk8s` ships **Calico** as its default CNI, which enforces `NetworkPolicy`; `kind`'s default CNI, `kindnet`, does not enforce `NetworkPolicy` at all and would make testing step 13 below pass regardless of whether the policy actually works). No macOS device is available, and no live Prometheus or Alloy deployment is available — those two gaps are called out explicitly in the table rather than silently assumed away.

| Deployment path | Tested against | Status | Notes |
|---|---|---|---|
| Standalone — Windows | this machine, real process + Task Scheduler | ✅ can execute now | Steps 1 (Windows leg) and 3 |
| Standalone — Linux | Ubuntu VM, systemd | ⏳ blocked on VM | Step 1 (Linux leg), step 2 |
| Standalone — macOS | — | ❌ genuinely blocked, no device | Step 1 (macOS leg); `launchd` plist ships written-from-docs, unexecuted |
| Docker build/run/hardening | Ubuntu VM, Docker Engine | ⏳ blocked on VM | Steps 4–9; also depends on the VM's own network path to Docker Hub, unconfirmed until the VM exists |
| Kubernetes manifests apply/probes/restart | Ubuntu VM, `microk8s` | ⏳ blocked on VM | Steps 10, 11 |
| `ServiceMonitor` + Prometheus Operator | `microk8s` `observability`/`prometheus` addon | ⏳ blocked on VM | Step 12 — also the first real (non-hand-rolled-parser) Prometheus ingestion test in the whole project |
| `NetworkPolicy` enforcement | `microk8s` (Calico) | ⏳ blocked on VM | Step 13 — see the CNI note above; this step is **not meaningfully testable under `kind`'s default CNI** |
| Multi-arch build + emulated run | Ubuntu VM, `buildx` + `qemu-user-static` | ⏳ blocked on VM | Step 14 |
| CA-bundle mount, in-cluster mock FMC | `microk8s` | ⏳ blocked on VM | Step 15 — uses a mock server, so it does not additionally depend on live FMC access |
| Live Prometheus/Alloy scraping this exporter | — | ❌ not available, out of scope for this stage | No test step above claims this; do not read a green Stage 13 as having exercised it. Alloy specifically is never exercised anywhere in Stage 13. |
| Live SCC/FMC access | — | N/A | Not required by any Stage 13 test step (`DESIGN.md` §3.1 already classifies Stage 13 as fixture/mock-testable); live access is irrelevant to this stage regardless of availability. |

✅ = executed and verified. ⏳ = artifact will exist, execution pending the named blocker. ❌ = cannot be executed in this environment; ships as docs/best-effort only, to be verified by first real use (mirrors how `DESIGN.md` §3.4 already treats chassis/HA/VPN field names).

---

## Stage 13A — Standalone packaging

### Goal / outcome

A bare-process deployment path exists and is documented as self-contained per `DESIGN.md` §5. The Windows leg is executed and verified on the implementer's own machine now; the Linux leg (systemd) and the Windows-permissions leg are executed as soon as the Ubuntu VM exists; the macOS leg ships from `DESIGN.md` §5 documentation only, unexecuted, flagged as such in the README and revisited on first real macOS use.

### Scope

- README section: prerequisites (Node 24+, outbound HTTPS, an inbound port), the 7-step install/run outline, and the verification step (`curl http://localhost:10049/metrics` shows `ftd_exporter_up 1`).
- Port **10049** (changed from the originally-planned `9812`, which turned out to already be registered to the FreeRADIUS exporter — see `DESIGN.md` §5.2), and an action item on the release checklist to register it on the Prometheus default-port-allocations list.
- `deploy/systemd/ftd-metrics-exporter.service` — `Restart=always`, `EnvironmentFile=`, and the hardening directives named in §5.4: `NoNewPrivileges=yes`, `ProtectSystem=strict`, `PrivateTmp=yes`, `ProtectHome=yes`, and an empty `ReadWritePaths=` (valid because the exporter never writes files).
- `deploy/launchd/*.plist` with `KeepAlive`.
- Windows: the `icacls` procedure for `.env` permissions — `DESIGN.md` §5.4 stresses this is *"a real difference from Unix, not a formality,"* since a `.env` commonly inherits broad `Users` read access and silently exposes the token to every local account. Plus Task Scheduler as the recommended dependency-free supervision path, with NSSM noted.
- Per-platform `.env` permission guidance (`chmod 600` on Unix), and a dedicated unprivileged service account on Linux.

### Dependencies

- Stages 0–12 (a working, tested binary).
- The Windows leg needs nothing else. The Linux leg needs the Ubuntu VM. The macOS leg needs a macOS device this project does not have — see the environment table above.

### Testing steps

1. Clean-machine standalone run on Windows following **only** the README's own steps — **executable now**. The Linux leg of this same step, and the macOS leg, follow once their respective environments exist (Linux: VM; macOS: genuinely blocked).
2. systemd: start, `systemctl status`, `journalctl` shows JSON lines, `systemctl stop` exits cleanly, `Restart=always` recovers from a kill. **Blocked on the Ubuntu VM.**
3. Windows: `icacls` procedure applied, then verify from a second local account that `.env` is unreadable — **executable now**.

### Risks

- **Windows service supervision** is the least-exercised path industry-wide and the most likely to have a documentation gap, even though it is the one leg fully testable today — testing it early is the point of running 13A first.
- **macOS ships unverified.** The `launchd` plist and per-platform guidance are written from `DESIGN.md` §5 directly, with no execution. Flag this in the README rather than implying parity with the tested Windows/Linux legs.

### Where later adjustment is likely

- The Linux (systemd) and macOS legs of testing step 1, once the Ubuntu VM exists and if a macOS device ever becomes available.

---

## Stage 13B — Docker packaging

### Goal / outcome

A hardened container image runs read-only as a fixed non-root UID, with signal handling and image hygiene verified — not just Dockerfile-reviewed. Fully blocked on the Ubuntu VM for execution; the Dockerfile, `.dockerignore`, and compose file can be written in 13A's session and simply queued.

### Scope

- Multi-stage `Dockerfile`: builder on `node:26` (`npm ci` with devDeps, `npm run build`); runtime on **`node:26-slim`** with only `dist/` and `npm ci --omit=dev` production modules. No compiler, no source, no devDeps in the shipped image. (Node 26 rather than 24 is a deliberate choice made during implementation — see `DESIGN.md` §6.1 — matching the runtime already in use on the implementer's own machine; `engines.node` already permits it.)
- Hardening: explicit `USER` with a **fixed non-zero UID/GID (e.g. 10001)** — not the image's default `node` user, so the UID is predictable for volume permissions and Kubernetes `runAsUser`; `EXPOSE 10049`; a `HEALTHCHECK` on `/healthz`; exec-form `ENTRYPOINT ["node","dist/index.js"]` so PID 1 receives signals.
- **`.dockerignore`** — `.env`, `.git`, `node_modules`, `dist`. `DESIGN.md` §6.2 calls this *"a load-bearing security control"*: a stray local `.env` baked into a layer is a real and common accident.
- Documented `docker run` with `--env-file`, `--read-only`, `--cap-drop=ALL`, `--security-opt=no-new-privileges`.
- `deploy/docker-compose.yml` using `env_file:` and read-only mounts.
- The CA-bundle mount pattern (`-v /host/ca.pem:/etc/ftd-exporter/ca.pem:ro` + `FMC_CA_BUNDLE_PATH`), documented as the one case env vars alone cannot cover.

### Dependencies

- Stage 13A's binary/README baseline (not a hard technical dependency, just sequencing — Docker packages the same artifact).
- The Ubuntu VM, with Docker Engine installed and (unconfirmed until it exists) a network path to Docker Hub for the `node:26`/`node:26-slim` base images. If the VM sits behind the same network policy that currently blocks Docker on the Windows machine, this sub-stage is blocked on that being resolved, not just on the VM's existence — confirm base-image pull works before relying on the rest of the plan below.
- Multi-arch publishing needs Buildx; GHCR needs org access (Stage 14).

### Testing steps

1. `docker build` → `docker history` shows **no** `.env` and no source. (The plan's original "~80 MB class" expectation was stale against current Debian-slim images — see `DESIGN.md` §6.1 for the real measured figure; image size itself is not a pass/fail criterion here.)
2. `docker run --read-only --cap-drop=ALL` → starts and serves `/metrics`, proving the no-disk-writes property (`DESIGN.md` §9.3).
3. `docker run` as UID 10001 → not root; `id` inside the container confirms.
4. `docker stop` → container exits within a second or two, **not** after the 10 s SIGKILL timeout. This is the practical test of exec-form `ENTRYPOINT` and Stage 11's signal handling.
5. `HEALTHCHECK` reports healthy.
6. **`.dockerignore` guard:** create a local `.env` containing a sentinel string, build, then `docker save` and grep the layers for the sentinel. Zero hits. Automate this in CI — it is cheap and catches a genuinely damaging accident.
7. Multi-arch: build `linux/amd64` + `linux/arm64` and run at least the non-native one under emulation (`buildx` + `qemu-user-static`).

### Risks

- **Read-only root filesystem breaking on something unexpected** — Node writes nothing by default, but a diagnostic added later (a heap snapshot, a temp file) would break it silently in production and not in dev. Test 2 in CI guards the invariant.
- **`.dockerignore` regression** baking a secret into a layer. Test 6, automated.
- **Alpine/musl temptation.** `DESIGN.md` §6.1 rejects `node:26-alpine` because musl introduces DNS-resolution and TLS edge-case differences — *"a poor trade for a network-centric exporter."* Someone will propose it for the smaller size. Point at §6.1.
- **VM network path is unverified until the VM exists.** If Docker Hub pulls are blocked on the VM the same way Docker itself is blocked on the Windows machine, this whole sub-stage's execution slips — check this first, before assuming the VM unblocks everything.

### Where later adjustment is likely

- **Distroless** as an alternative tag in v1.1 (`DESIGN.md` §6.1 rejects it for v1 only because the missing shell makes first-time troubleshooting harder).

---

## Stage 13C — Kubernetes packaging

### Goal / outcome

A Kubernetes Deployment with probes, a Secret, a Service, and a NetworkPolicy is applied and verified against a real (if single-node) cluster — not just YAML-reviewed. Fully blocked on the Ubuntu VM; manifests can be written ahead of time.

### Scope

- `deploy/kubernetes/`: `secret.example.yaml` (placeholders only), `configmap.yaml`, `deployment.yaml`, `service.yaml`, `servicemonitor.yaml`, `podmonitor.yaml`, `networkpolicy.yaml`. Plain YAML; a Helm chart is deferred to v1.1+ so the project does not commit to a values API before the config surface stabilizes.
- `Deployment`: `replicas: 1` with a comment explaining **why** (`DESIGN.md` §7.3 — replicas multiply upstream request rate against hard limits, and two replicas at 60 s consume SCC's entire 2/min budget); `envFrom` Secret + ConfigMap; full `securityContext` (`runAsNonRoot`, explicit `runAsUser`/`runAsGroup`, `allowPrivilegeEscalation: false`, `readOnlyRootFilesystem: true`, `capabilities.drop: [ALL]`, `seccompProfile: RuntimeDefault`); liveness → `/healthz`, readiness → `/readyz`; resources `requests: 50m/128Mi`, `limits: 500m/256Mi`.
- `ServiceMonitor` with a prominent comment that **`interval` is independent of `POLL_INTERVAL_SECONDS`** — `DESIGN.md` §7.5 identifies "I set the scrape interval to 5m to respect the rate limit" as *"the thing new users most predictably get wrong."*
- Secret-management guidance naming External Secrets Operator / Sealed Secrets / SOPS / CSI drivers without mandating one, plus an explicit statement that base64 is encoding, not encryption, and that committing a populated Secret defeats the entire credential design.

### Dependencies

- Stage 13B (a built, hardened image to deploy) — though the manifests themselves can be drafted in parallel.
- The Ubuntu VM with **`microk8s`** (not `kind` — see the environment note above for why: `microk8s`'s default Calico CNI enforces `NetworkPolicy`, `kind`'s default `kindnet` does not). Enable the `dns`, `registry`, and `observability` (or `prometheus`) addons.
- A locally-built image needs to reach `microk8s`'s containerd, not the Docker daemon — either `docker save <image> | microk8s ctr image import -`, or push to the `microk8s enable registry` local registry at `localhost:32000`. Decide which before test 1 below; it is a one-line difference in the manifests' `image:` field.

### Testing steps

1. Apply all manifests to `microk8s`; pod reaches Ready; `kubectl port-forward` and scrape; probes pass; `readOnlyRootFilesystem: true` does not break startup.
2. Kill the pod → new pod ready within one poll interval + jitter, confirming the "restart costs one poll interval" claim in §7.3.
3. `ServiceMonitor` via `microk8s`'s `observability`/`prometheus` addon → target appears UP and series land. This is the first real Prometheus ingestion test anywhere in the project — treat a pass here as also closing part of G1, not just a Stage 13 checkbox.
4. `NetworkPolicy` applied → scrapes from the Prometheus namespace still work; traffic from elsewhere does not. **Must run against Calico** (`microk8s`'s default) — this step would false-pass under `kind`'s default CNI, which does not enforce `NetworkPolicy` at all.
5. CA-bundle mount path end to end against a self-signed mock FMC inside the cluster.

### Risks

- **Resource limits are a guess.** `DESIGN.md` §7.2 sizes them for a small Node process holding one JSON snapshot in memory and explicitly labels them a starting point, noting *"a 1000-tunnel, 500-interface fleet will need more."* A 256Mi limit could OOM-kill on a large fleet, which looks like a crash-loop bug. Measure during Stage 12's soak and Stage 16.
- **`replicas: 1` will be questioned** by every Kubernetes reviewer. The comment in the manifest must carry the rate-limit arithmetic, not just assert the value.
- **A NetworkPolicy test run against the wrong CNI silently proves nothing.** This is not hypothetical — it is the specific reason `microk8s` was chosen over `kind` for this stage. If the test cluster is ever swapped (a future contributor defaults to `kind` out of habit), re-verify the CNI enforces `NetworkPolicy` before trusting a green result on this step.

### Where later adjustment is likely

- **Resource requests/limits**, once real memory/CPU at fleet scale is observed. Expect the limit to rise.
- **A Helm chart** in v1.1+, once the config surface has stabilized (`DESIGN.md` §7.1).
- Single-executable (Node SEA) as a convenience artifact in a later release (`DESIGN.md` §5.1).

---

# Stage 14 — Repository hygiene, CI, and release automation

### Goal / outcome

Every PR runs the full check matrix; a tag produces a published npm package and a multi-arch container image with provenance and an SBOM; and the repository presents the signals a third-party security team looks for before deploying a tool that holds firewall credentials.

**Start this stage at Stage 0 and grow it.** It is listed here because it *completes* here, not because it begins here.

### Scope

Per `DESIGN.md` §13's table:

- `README.md` — purpose; **the three deployment paths clearly separated so a user reads only theirs**; the full configuration table; the metric reference; troubleshooting; security notes; and an **explicit statement that chassis, HA, and VPN metrics are experimental in v1 on both backends.**
- **Troubleshooting section**, leading with the highest-frequency issues in order:
  1. **The health-policy prerequisite** (`DESIGN.md` §3.2.5 — *"the single most likely support question"*): a metric group is missing because the device's health policy is not collecting it. Point at the device's health policy in SCC/FMC, **not** the exporter config. Include the §14.6 **propagation-delay** caveat: a policy change is not immediately reflected in the metrics API (observed under 5 minutes on SCC), so checking immediately after a deploy risks a false negative.
  2. **The FMC UI/API session conflict** (`DESIGN.md` §3.3.2) as the explanation for both "my FMC UI keeps logging me out" and "the exporter intermittently gets 401s" — with the dedicated API-only service account as the fix.
  3. **Conditional-group absence by capability** (`DESIGN.md` §4.8): no chassis on an appliance, no HA outside a pair, no VPN metrics without VPN configured. Note that "metric missing" has two quite different root causes (capability vs health policy) and give both.
  4. TLS verification failures against FMC, and why the answer is a CA bundle with a hostname-matching `FMC_HOST` rather than the insecure flag (`DESIGN.md` §9.6).
  5. FMC sizing: the 300/min budget, the 50-device worked example, and the `POLL_INTERVAL_SECONDS` / `FMC_METRIC_FAMILIES` levers.
  6. Legacy SCC hostname deprecation (§14.12) — the startup warning and what to change.
  7. `ftd_exporter_devices_discovered` vs `devices` as the pagination/per-device-failure diagnostic.
- `LICENSE` (Apache-2.0), `CONTRIBUTING.md` (dev setup, tests, coding standards, **how to contribute sanitized fixtures** — the §3.3.5 mechanism, including the `--dump-raw` workflow and the sanitization rules from Stage 1), `CODE_OF_CONDUCT.md` (Contributor Covenant), `SECURITY.md` (GitHub private advisories, supported versions, response expectations), `CHANGELOG.md` (Keep-a-Changelog).
- Issue/PR templates requesting `ftd_exporter_build_info` labels, backend type, and **redacted** logs.
- `.github/workflows/ci.yml` per `DESIGN.md` §12.4:
  - **OS matrix `ubuntu-latest` / `macos-latest` / `windows-latest`** — non-negotiable for G4.
  - **Node matrix 24 and current.**
  - Checks: `tsc --noEmit`, lint, unit tests, integration tests, `npm audit` (fail on high/critical in prod deps), **secret scanning** (`gitleaks` and/or GitHub push protection), dependency license compliance, and the **no-native-build-step check**.
  - The `.dockerignore` sentinel test from Stage 13B.
  - The fixture-sanitization guard test from Stage 1.
  - Docker multi-arch build on PRs; publish only on tags.
- `.github/workflows/release.yml` — tag-triggered: `npm publish --provenance`; GHCR multi-arch push with build provenance attestation and an SBOM; GitHub Release with changelog. Image tags: exact version, minor, major, `latest`, with docs recommending at least the minor tag in production.
- **Actions pinned to commit SHAs**, not floating tags (`DESIGN.md` §9.7 — tag mutation is a demonstrated attack path).
- Dependabot (or Renovate) for dependencies and Actions, with grouped minor/patch PRs.
- `package-lock.json` committed; CI uses `npm ci` exclusively.
- A **release checklist** capturing the manual live-verification step (`DESIGN.md` §12.3 — live verification is a documented manual maintainer step with results recorded, never a CI job).

### Dependencies

- Everything, for completeness; nothing, to start.
- GHCR and npm publishing require org/registry access — flag early if it is not in hand, since it gates release but not development.

### Testing steps

1. A deliberately failing PR (type error, lint error, failing test) is blocked by CI on all matrix legs.
2. A PR adding a fake secret to a file is blocked by secret scanning.
3. A PR adding a dependency with a native build step is blocked by the no-native-addons check. This is worth actually attempting once, since it is the check most likely to be subtly non-functional.
4. `npm audit` failure path verified by temporarily pinning a known-vulnerable dev-only dep and confirming it does *not* fail (prod deps only), then a prod dep and confirming it does.
5. A dry-run release from a test tag produces a package tarball containing **only** the allowlisted files — no `.env`, no fixtures with real data, no `data/`, no `.scratch/`.
6. `npm pack` output inspected manually once, by eye, before the first real publish.
7. Provenance and SBOM present and verifiable on the published image.
8. Docs review: have someone who has not read `DESIGN.md` follow one deployment path start to finish.

### Risks

- **CI runtime creep** on a 3-OS × 2-Node matrix with Docker builds. Split fast checks (typecheck/lint/unit on Linux) from the full matrix, and run integration + Docker on a reduced set for PRs and the full set on main.
- **Windows CI flakiness** around ports and file locks. Do not paper over it with retries without understanding it — a flaky Windows test often *is* a Windows bug (`DESIGN.md` §12.4's whole rationale).
- **Publishing scope accidents** — the `files` allowlist is the control (`DESIGN.md` §9.7, allowlist not denylist). Test 5 is the guard.
- **The temptation to add a live-credential CI job** for confidence. `DESIGN.md` §12.3 forbids it. Do not add one, and say so in `CONTRIBUTING.md` so a well-meaning contributor does not propose it.
- Actions SHA pinning creates update churn; Dependabot's Actions ecosystem support handles it.

### Where later adjustment is likely

- Node matrix moves as new LTS versions land; raising the floor is a **major** bump (`DESIGN.md` §13).
- Release automation will need adjusting the first time a `0.x` → `1.0` transition happens.
- A Helm chart or SEA binary would add release jobs.

---

# Stage 15 — Grafana dashboard and alert rules

### Goal / outcome

`dashboards/ftd-health.json` imports cleanly into any Grafana without hand-editing and answers the operational questions in `DESIGN.md` §10.2 against real scraped data — **degrading gracefully** on an all-appliance fleet with no chassis, HA, or VPN. `alerts/ftd-health.yaml` loads into Prometheus and fires correctly on synthetic conditions.

Can run in parallel with Stages 13/14; needs only the frozen metric surface from Stage 3.

### Scope

- `dashboards/ftd-health.json` — the 8 rows specified in `DESIGN.md` §10.2:
  1. Fleet overview, with **exporter health placed first and prominently** — §10.2 is emphatic that *"a dashboard that looks green while the exporter is dead is the worst possible outcome and the most common exporter-dashboard failure."* Plus the per-device summary table, *"the visual anchor of the dashboard."*
  2. CPU and memory, one series per `component` — splitting Lina and Snort *is the point* (§10.2); gauges with 70/85 thresholds; a Top-N bar gauge.
  3. Disk, gauges at 75/90 plus a trend series.
  4. Interfaces: mirrored-Y throughput; errors/drops on a **separate** panel from throughput (mixing axes hides small error counts under large byte values); buffer overruns/underruns/L2 decode drops in their own panel; a state-timeline for link/operational status; an inventory table including down/unused interfaces. **A panel description noting the §14.4 unit ambiguity** so nobody misreads the axis.
  5. HA (conditional) — state-timeline mapping directly onto the §4.4 state-set representation, which is *"a large part of why that representation was chosen"*; plus a role stat; plus a description explaining emptiness is expected outside an HA pair.
  6. VPN (conditional) — session series with peak overlaid; S2S tunnel state filtered to non-`up` by default so the panel shows problems rather than a wall of green; a "tunnels currently down" stat, *"the number an operator actually wants at 3am."*
  7. Chassis (conditional) — fan RPM by `fan` label; PSU stats red on 0; description noting it is empty on appliances such as the FTD 1010.
  8. Freshness and diagnostics — `time() - ftd_health_window_end_timestamp_seconds` per device (the reason §4.5 exports these at all); poll duration; error rate by reason; upstream request rate; and a red `ftd_exporter_tls_verification_disabled` indicator.
- Datasource templated as `${DS_PROMETHEUS}` (§10.1 — a common friction point in shared dashboards). Template variables: `device` (multi-select from `label_values(ftd_cpu_usage_ratio, device_name)` with `All`), `interface` (dependent on `device`), and `job`/`instance` for multi-exporter setups.
- `alerts/ftd-health.yaml` — the 12 candidate rules in `DESIGN.md` §10.3, with the stated `for` durations and severities. Note §10.3's guidance: **interface-down alerting defaults to interfaces with a real `interface_name`**, since unused interfaces are legitimately down and would otherwise generate constant noise — a direct consequence of exporting all interfaces.
- Docs: import instructions, and the ConfigMap/sidecar provisioning option.

### Dependencies

- Stage 3 (frozen metric names) and a Prometheus + Grafana instance.
- To validate realistically, either Stage 12's mock-driven exporter feeding a local Prometheus, or a fixture-loaded Prometheus. Real conditional-group panels can only be validated with `all-groups-present` synthetic data — an honest limitation to note in the dashboard's own description.

### Testing steps

1. Import into a clean Grafana with no pre-provisioned datasource → prompts for the datasource, then renders. No hand-editing, no dangling UIDs.
2. Every panel's PromQL is valid against a Prometheus containing only fixture-derived series — no query errors.
3. **Graceful degradation (the §10.1 requirement):** point the dashboard at data from the appliance fixture (no chassis/HA/VPN) → conditional rows show explanatory descriptions, **not a wall of "No data" errors.**
4. Conditional rows populate correctly when fed the `all-groups-present` synthetic data.
5. Template variables cascade: selecting a device narrows the interface list.
6. Exporter-health panels correctly show a dead exporter (`ftd_exporter_up 0`) as an alarming state, while device panels still show their last values. This is the specific failure mode row 1 exists to prevent — test it deliberately.
7. Each alert rule fires against a synthetic series crafted to violate it, and does not fire otherwise. `promtool test rules` with committed unit-test YAML is the right mechanism, and it makes the alert file self-verifying in CI.
8. `FtdInterfaceDown` does **not** fire for an unused interface whose `interface_name` fell back to the hardware id. This is the noise-avoidance property from §10.3 and it depends on the Stage 3 fallback behavior — a genuine cross-layer test.
9. `promtool check rules` passes in CI.

### Risks

- **`interface_name` fallback interacts with alert filtering.** Because an unnamed interface's `interface_name` equals its hardware id (`DESIGN.md` §4.3), "has a real name" is not expressible as `interface_name != ""`. The filter must be something like `interface_name != interface`, which PromQL cannot express directly between two labels on the same series. This is a real, concrete design tension between §4.3's fallback and §10.3's noise-avoidance guidance, and it needs an explicit resolution — options: alert on a curated device/interface allowlist; alert only on interfaces that have *ever* been up; or add a distinguishing label. **Flag it, decide it during this stage, and record the decision.** Do not let it silently produce a noisy alert file.
- **Dashboard JSON drift** — hand-edited in the Grafana UI, exported, and committed with churn (ids, versions, timestamps). Establish an export/normalize procedure in `CONTRIBUTING.md`.
- **§14.4** — throughput panel units and axis labels are provisional. The panel description hedge is required, not optional.
- **Chassis/HA/VPN panels are built against synthetic data** and may be wrong in the same way the mappings may be wrong (§3.4).
- **Alert thresholds** (85% CPU, 90% memory, 90% disk) are reasonable defaults, not universal truths; document them as starting points.

### Where later adjustment is likely

- All conditional-group panels, once real data exists.
- Throughput axis units, pending §14.4.
- Threshold defaults, after operator feedback.
- Session-capacity thresholds are model-dependent and must stay operator-configured (§10.2 row 6).

---

# Stage 16 — Live validation, 0.x hardening, and the 1.0 gate

### Goal / outcome

The exporter has run against real infrastructure for a sustained period on both backends; the resolvable `DESIGN.md` §14 questions are resolved or explicitly re-deferred with evidence; and the project has either cut 1.0 or has a written statement of exactly what remains.

### Scope

- **Sustained SCC run** (maintainer tenant): ≥ 7 days at a 60 s poll interval. Verify no rate-limit errors, no memory growth, stable series count, and that the health-policy propagation-delay figure in the README is accurate.
- **Sustained FMC run** (lab, 4 FTDv): ≥ 7 days. Verify the token lifecycle over many cycles — expect roughly one re-auth every 2 hours (30 min × 4, per `DESIGN.md` §11) — and confirm `fmc_token_refreshes_total` / `_reauths_total` match that arithmetic. A mismatch is the clearest possible signal of a token-manager bug and this is the only place it can be observed.
- **§14.4 resolution attempt** (interface byte units): generate known traffic volumes against a test device and compare reported values at `5m` vs `1h`. Unit-consistent across window sizes → a rate → rename to `_bytes_per_second`. Scales with the window → a total → keep `_bytes_avg`. **Do this before 1.0**, because the rename is a major bump afterward.
- **§14.10 observation** (do failed SCC requests consume budget?): induce failures and observe. Either way the conservative assumption stands; document the finding.
- **§14.2 re-attempt** if chassis-based hardware becomes available: compare `/health/aggregatemetrics?metric:INTERFACE` against `/devices/devicerecords/{uuid}/fpinterfacestatistics` for field richness and freshness.
- **Fixture solicitation** — open GitHub issues explicitly asking for `--dump-raw` captures from operators with chassis hardware, an HA pair, RA VPN, and S2S VPN, on both backends. This is the *only* realistic path to closing §14.1's remaining gaps and §14.3. Make the ask concrete and easy: name the flag, name the sanitization step, link `CONTRIBUTING.md`.
- **Resource-limit calibration** from observed memory/CPU → update the Kubernetes manifests (Stage 13C).
- **Third-party SCC validation** — the actual 1.0 gate (`DESIGN.md` §13). Recruit at least one external SCC deployment; capture the outcome in the release checklist.
- Update `DESIGN.md` §14 in place as items resolve, preserving the evidence trail — the document's existing §14.1/§14.5/§14.6 entries model this well (finding, method, conclusion).

### Dependencies

- Stages 0–15.
- A live SCC tenant, a live FMC, and — for the genuinely blocked items — hardware and configurations the maintainers may not have (§3.4).

### Testing steps

1. 7-day SCC soak: zero `poll_errors_total{reason="rate_limited"}`, `cache_age_seconds` never exceeding ~2× the poll interval, flat heap.
2. 7-day FMC soak: `fmc_token_reauths_total` ≈ elapsed_hours / 2; zero unexplained `401`s; `devices_discovered` stable at 4; discovery firing once per 15 min.
3. Restart mid-run → recovery within one poll interval + jitter; no duplicate or missing series afterward.
4. Deliberate upstream outage (block egress) → `up 0`, stale serve continues, recovery on restore, backoff escalates and resets as designed.
5. §14.4 experiment executed and the result recorded in `DESIGN.md` §14.4 with the method.
6. Prometheus + the Stage 15 dashboard validated against real data on both backends.
7. Alert rules validated against at least one genuine condition (e.g. a real interface taken down).
8. Cross-backend series comparison: if any device is visible via both an SCC tenant and an on-prem FMC, compare rendered CPU/MEM/DISK/INTERFACE series. Identical values are the strongest possible confirmation of G2. Unlikely to be arrangeable, but worth checking whether it is.

### Risks

- **§3.4 items may never close.** Accept it. The mitigations — experimental labeling, `--dump-raw`, isolated mapping code — are the design's answer, and `DESIGN.md` §13/§14.11 already commits to keeping those names changeable in a minor release. Do not manufacture confidence by "verifying" against synthetic data.
- **§14.4 resolving toward per-second** means a metric rename plus dashboard updates plus a changelog note. Cheap while `0.x`; expensive after 1.0. This is the strongest single argument for doing the §14.4 experiment before cutting 1.0.
- **Third-party validation is a recruitment problem, not an engineering one.** It may take months. Do not block useful `0.y` releases on it — ship, document the 0.x status, and let adoption produce the validation.
- **Lab-only FMC verification** means fleet-scale behavior (the 250-request cycle, the budget guard under real load, the 300/min ceiling) remains projected rather than observed. Say so in the README's sizing guidance rather than implying it was measured.
- **A long soak can mask a slow leak** that only a longer one reveals. Keep `nodejs_heap_size_used_bytes` on the dashboard and treat it as a permanent signal, not a one-time check.

### Where later adjustment is likely

Everything already flagged as provisional throughout this plan converges here: interface metric names (§14.4), chassis/HA/VPN metric names (§14.1, §13), FMC concurrency and budget-warning defaults (§3.3.4), Kubernetes resource requests/limits (§7.2), retry and backoff constants (§2.5), and histogram buckets. Plus the deferred features `DESIGN.md` already scopes to v1.1+: Smart License status, device inventory/connectivity and certificate expiry (§4.6), health alerts/events as status gauges, FMC-appliance-level health via device UUID `0`, the high-resolution time-series mode (§14.9), multi-target support (§14.7), leader election (§14.8), a Helm chart (§7.1), distroless images (§6.1), TLS hot reload (§9.2), and `FTD_DISABLE_S2S_TUNNEL_METRICS` (§4.2).

---

## Appendix: stage-to-`DESIGN.md` section index

| Stage | Primary `DESIGN.md` sections |
|---|---|
| 0 Scaffolding | §2.7, §5.1, §5.2, §9.7, §13 |
| 1 Domain model + fixtures | §2.3, §4.8, §9.7, Appendix B, Appendix C |
| 2 Response mapping | §3.2.6, §3.3.5, §4.8, §12.1, §14.1, §14.6, Appendix B, Appendix C |
| 3 Metrics rendering | §4.1–4.5, §4.8, §11, §14.4, §14.11 |
| 4 Config loader | §2.4, §8 (all), §9.1, §9.4, §14.12 |
| 5 Logger + redaction | §2.6, §9.4 |
| 6 HTTP client / TLS / limiters | §2.5, §2.7, §3.2.4, §3.3.4, §9.1, §9.5, §9.6, §14.10 |
| 7 SCC adapter | §3.1, §3.2 (all), §12.1, Appendix B |
| 8 FMC adapter | §3.1, §3.3 (all), §12.1, §14.1, §14.2, Appendix A, Appendix C |
| 9 Poller + cache | §2.2, §2.5, §9.3, §11 |
| 10 HTTP server | §2.7, §7.2, §9.2, §11 |
| 11 Entrypoint + `--dump-raw` | §2.4, §3.3.5, §5.2, §6.2, §9.6 |
| 12 Integration tests | §12.2, §12.3 |
| 13 Packaging | §5, §6, §7, §9.3 |
| 14 Hygiene + CI | §9.7, §12.4, §13 |
| 15 Dashboard + alerts | §10 (all), §14.4 |
| 16 Live validation | §12.3, §13, §14 (all) |

---

### Critical files for implementation

Since the repository is pre-implementation, these are the existing files that drive the build plus the first files to create:

- `DESIGN.md` — the authoritative specification for every stage; §3, §4, §8, §12, §14, and Appendices B/C are consulted in almost every stage.
- `.gitignore` — must be extended (not replaced) in Stage 0 with `*.pem`, `*.key`, `*.crt`, `*.p12`, `.env.*` while keeping `/data/` and `/.scratch/` ignored.
- `.scratch/` — the live SCC and FMC captures (`scc_health_metrics.json`, `scc_health_metrics_recheck.json`, `fmc_CPU.json`, `fmc_MEM.json`, `fmc_DISK_STATS.json`, `fmc_INTERFACE_ftd1_recheck.json`, `fmc_CHASSIS_STATS.json`, `fmc_devices.json`, `fmc_INTERFACE_spoke1.json`, `fmc_fpinterfacestatistics.json`). **Time-sensitive:** these are gitignored and unreproducible without live access, so sanitizing and committing them as `test/fixtures/` is the first substantive Stage 1 task.
- First files to create, in order: `package.json` + `tsconfig.json` (Stage 0) → `src/domain/snapshot.ts` (Stage 1) → `src/backends/scc/map.ts` and `src/backends/fmc/map.ts` (Stage 2) → `src/metrics/collector.ts` (Stage 3).