# Troubleshooting

This page covers the failure modes an operator is most likely to hit — configuration mistakes, reachability problems, and permission issues — across all three deployment methods (standalone, Docker, Kubernetes). For each one: what you'll actually see, why, and how to fix it.

## Start here: three things to check first

1. **The startup log.** Every run logs an `Effective configuration:` line once, right after config validation. It shows every variable the exporter actually resolved (secrets shown as `[REDACTED]`, unset optional values shown as `(unset)`). Most "wrong credential" and "wrong backend" reports turn out to be visible immediately in this line — e.g. `BACKEND_TYPE=fmc` but you meant to configure SCC.
2. **`/healthz` and `/readyz`.** These tell you whether the process is alive and whether the cache has ever been populated — see [Endpoint reference](#endpoint-reference) below.
3. **`ftd_exporter_up`, `ftd_exporter_poll_errors_total`, `ftd_exporter_cache_age_seconds`.** These three self-metrics tell you, at a glance, whether the *last* poll succeeded, *why* recent polls have failed, and *how stale* the data currently being served is. See [Reading the self-metrics](#reading-the-self-metrics).

```bash
curl http://localhost:10049/healthz
curl http://localhost:10049/readyz
curl http://localhost:10049/metrics | grep ftd_exporter_
```

---

## Configuration errors (won't start at all)

Every configuration problem is caught **before** the exporter starts polling. The process writes one JSON line to **stderr** and exits with code **1** — nothing binds to `METRICS_PORT`, so a scrape or `curl` against it will simply fail to connect, not return an error response.

```json
{"level":"error","message":"Invalid configuration: BACKEND_TYPE is required and must be exactly \"scc\" or \"fmc\", but is unset"}
```

Multiple problems are collected and reported together, not one-at-a-time:

```json
{"level":"error","message":"Invalid configuration (3 errors):\n  1. SCC_BASE_URL is required when BACKEND_TYPE=scc, but is unset\n  2. SCC_API_TOKEN is required when BACKEND_TYPE=scc, but is unset\n  3. SCC_FMC_UID is required when BACKEND_TYPE=scc, but is unset"}
```

### Common causes

| Symptom (message contains…) | Cause | Fix |
|---|---|---|
| `BACKEND_TYPE is required...but is unset` | `.env` wasn't loaded, or `BACKEND_TYPE=` was left blank | Confirm `.env` exists in the working directory (standalone), was passed via `--env-file` (Docker `--env-file`), or is injected via the ConfigMap/Secret (Kubernetes). Set `BACKEND_TYPE` to exactly `scc` or `fmc`. |
| `BACKEND_TYPE must be exactly "scc" or "fmc" (case-sensitive), got "..."` | Typo, extra whitespace, or wrong case (`SCC`, `Fmc`) | Fix the exact value — it's case-sensitive. |
| `SCC_BASE_URL is required...` / `SCC_API_TOKEN is required...` / `SCC_FMC_UID is required...` | `BACKEND_TYPE=scc` but the SCC block in `.env` wasn't filled in | Fill in all three SCC variables — see [README Configuration](../README.md#configuration). |
| `FMC_HOST is required...` / `FMC_USERNAME is required...` / `FMC_PASSWORD is required...` | `BACKEND_TYPE=fmc` but the FMC block wasn't filled in | Fill in all three FMC variables. |
| `SCC_BASE_URL must use HTTPS...` | You pasted an `http://` URL | Use the `https://` regional URL from `example.env`. |
| `POLL_INTERVAL_SECONDS must be >= 30 on the SCC backend...` | `POLL_INTERVAL_SECONDS` set below SCC's hard rate limit floor | Raise it to 30 or more. This is enforced as a hard error, not silently clamped. |
| `FMC_TLS_INSECURE_SKIP_VERIFY=true together with FMC_CA_BUNDLE_PATH set is a configuration error` | Both a CA bundle and the insecure-skip-verify flag are set at once | Pick one: set `FMC_CA_BUNDLE_PATH` and leave `FMC_TLS_INSECURE_SKIP_VERIFY=false` (recommended), or clear `FMC_CA_BUNDLE_PATH` if you genuinely intend to skip verification (lab/test only). |
| `... must point to a file that exists and is readable, got "..."` | A TLS path variable (`FMC_CA_BUNDLE_PATH`, `METRICS_TLS_CERT_PATH`, etc.) points at a path that doesn't exist or isn't readable by the exporter's own process/account | Check the path is correct for *where the process actually runs* — a path that's valid on your workstation isn't automatically valid inside the container or pod. See [Permissions issues](#permissions-issues) below. |
| `METRICS_TLS_CERT_PATH and METRICS_TLS_KEY_PATH must be set together or not at all` | Only one of the pair was set | Set both, or neither (plain HTTP). |
| `... is empty — expected PEM-encoded material` | A TLS cert/key file exists and is readable, but is zero-length | Re-generate or re-copy the file — an empty file binds the listener but every TLS handshake then fails permanently until restart. |

### A "wrong block was edited" warning (not fatal)

If both an SCC variable and an FMC variable are non-default at the same time, startup **continues** but logs a warning like:

```
FMC_HOST is set but BACKEND_TYPE=scc, so it has no effect. This usually means the wrong block of example.env was edited; FMC_* variables only apply when BACKEND_TYPE=fmc.
```

This is informational — the exporter runs fine — but it's worth fixing `.env` to avoid confusion later (e.g. after actually switching `BACKEND_TYPE`).

### An insecure-mode warning (not fatal, but loud on purpose)

Setting `FMC_TLS_INSECURE_SKIP_VERIFY=true` on its own (no CA bundle conflict) doesn't block startup, but logs a large boxed warning at error severity every single time the process starts:

```
===========================================================================
INSECURE: FMC_TLS_INSECURE_SKIP_VERIFY=true — certificate verification for
the FMC backend is DISABLED. FMC credentials and all metrics data are
exposed to undetectable interception...
===========================================================================
```

`ftd_exporter_tls_verification_disabled` is also set to `1` so this is visible in your monitoring, not just something that scrolls past in a log. If you see this and didn't mean to, unset `FMC_TLS_INSECURE_SKIP_VERIFY` (or set it to `false`) and configure `FMC_CA_BUNDLE_PATH` instead.

---

## Permissions issues

### Windows: `.env` unreadable by the account running the exporter

If you followed the [standalone installation guide](INSTALL_STANDALONE.md)'s `icacls` steps and locked the account out by mistake, you'll now see a *specific* error rather than the generic "BACKEND_TYPE is unset" message:

```json
{"level":"error","message":"Env file \"C:\\path\\to\\.env\" exists but could not be read — check its file permissions (on Windows, the account running the exporter needs read access; see the README's icacls procedure)."}
```

This is deliberately distinct from a genuinely missing `.env` (which is silently treated as "no `.env`, use process environment variables instead" — the expected case for Docker/Kubernetes, where config arrives via env vars, not a file). If you see the message above:

1. Confirm which account is actually running the process (Task Scheduler's configured user, or `LocalSystem` if using NSSM's default).
2. Re-run the `icacls` grant for **that specific account** — see [Standalone installation → Windows](INSTALL_STANDALONE.md#windows) for the exact commands and the account-matching table.
3. Verify with `runas /user:<that account> cmd` then `type .env` — it must succeed.

### Linux/macOS: `.env` unreadable

Less common since `chmod 600 .env` combined with running as the file's owner just works, but if you see a bare filesystem permission error (`EACCES`) rather than the config-validation errors above, check:

```bash
ls -l .env
whoami   # or: systemctl show ftd-metrics-exporter -p User
```

The service account (e.g. `ftd-exporter`) must own the file or otherwise have read access.

### Kubernetes: Secret/ConfigMap not mounted as expected

There's no file-permission failure mode here — Secret/ConfigMap values become container environment variables via `envFrom`, not files, so there's nothing to `chmod`. If variables aren't showing up in the effective-config log line, check the Secret/ConfigMap actually exists in the right namespace and the Deployment's `envFrom` references the correct names:

```bash
kubectl get secret ftd-metrics-exporter-secrets -n monitoring
kubectl get configmap ftd-metrics-exporter-config -n monitoring
kubectl logs deploy/ftd-metrics-exporter -n monitoring | grep "Effective configuration"
```

### CA bundle / TLS cert file exists but exporter can't read it

Same underlying failure as any other unreadable path (see the config-error table above): `... must point to a file that exists and is readable, got "..."`. In a container, the most common cause is mounting the file with a UID/permissions that don't match the container's fixed non-root UID (`10001:10001` in the shipped Docker/Kubernetes images) — make sure the volume mount is world-readable or explicitly owned by that UID.

---

## Authentication and credential failures

These don't stop the process — the exporter is deliberately designed to **keep running** on an auth failure rather than crash-loop, since credentials being wrong is not something a restart fixes. What you'll see instead:

### SCC: bad or expired `SCC_API_TOKEN`

Log line, once per affected poll cycle:

```
SCC health metrics request failed with an authentication error — check SCC_API_TOKEN validity, expiry, and permissions. The exporter will keep running but this poll produced no data.
```

Effect: `ftd_exporter_up` is `0`, `ftd_exporter_poll_errors_total{reason="auth"}` increments every cycle, and this is **not retried** (an auth failure is never transient). `/metrics` keeps serving the last-known-good device data (if any was ever fetched) but its `ftd_exporter_cache_age_seconds` keeps climbing.

**Fix**: regenerate the token in SCC (Settings → User Management → the API-only user → Generate API Token) and update `SCC_API_TOKEN`. Since SCC tokens don't expire on their own, this almost always means the token was revoked/rotated outside this exporter, or was mistyped/truncated when pasted into `.env`.

### FMC: bad `FMC_USERNAME`/`FMC_PASSWORD`

Log line:

```
FMC generatetoken failed — verify FMC_USERNAME/FMC_PASSWORD are correct for a dedicated API-only service account. The exporter will keep running but this poll produced no FMC data.
```

Effect: same `up=0` / `poll_errors_total{reason="auth"}` pattern as SCC. Additionally, FMC **latches** this failure — once a login attempt itself comes back 401/403, the exporter stops attempting further logins for the rest of that process's lifetime (it fails every subsequent request instantly, with no network call) rather than hammering FMC with repeated failed logins. **A process restart is required after fixing the credential** — simply correcting `.env` while the old process is still running has no effect until it's restarted.

**Fix**: verify the username/password directly against the FMC UI login page. If they're correct there but still failing here, the most common cause is the "one session at a time" limitation — see the next section.

### FMC: intermittent 401s despite correct credentials

If `FMC_USERNAME`/`FMC_PASSWORD` are correct but auth still fails intermittently (rather than immediately and permanently), the account is very likely **not a dedicated API-only service account** — Cisco documents that a single FMC account cannot be logged into the web UI and used via the API simultaneously; whichever session is newer silently invalidates the other. Symptom: you (or a colleague) get logged out of the FMC UI around the same time the exporter starts reporting auth errors, or vice versa.

**Fix**: create a separate service account solely for this exporter and never use it interactively.

### Both backends: a `[REDACTED]` credential in the logs is expected, not a bug

`SCC_API_TOKEN`, `FMC_PASSWORD`, any `Authorization`/`Bearer` header, and similar fields are redacted at the logging boundary unconditionally — you will never see a real secret value in exporter logs, including in `--dump-raw` captures. If you need to confirm a credential's *value* is what you think it is, check it against `.env`/the Secret directly, not the logs.

---

## TLS and certificate errors

### FMC's self-signed certificate is rejected

By default, the exporter only trusts publicly-issued CAs. FMC ships a self-signed certificate out of the box, so with no `FMC_CA_BUNDLE_PATH` configured, `backend.init()` fails with a TLS-layer error along the lines of:

```
self-signed certificate
```
or
```
unable to verify the first certificate
```

This is Node/OpenSSL's own standard certificate-verification error text, surfaced as-is. It happens at startup (`init()`), so the process logs `backend init() failed — exiting` and exits with code 1 — it does not retry indefinitely.

**Fix**: pull FMC's certificate and point `FMC_CA_BUNDLE_PATH` at it:

```bash
openssl s_client -connect <fmc-host>:443 -showcerts
```

Verify the fingerprint out-of-band against the FMC UI before trusting it, save it as a PEM file, and set `FMC_CA_BUNDLE_PATH` to that file's path. See [example.env](../example.env) for the full procedure. As a last resort for lab/test environments only, `FMC_TLS_INSECURE_SKIP_VERIFY=true` disables verification entirely — see the warning above about why this isn't for production.

### `FMC_CA_BUNDLE_PATH` is set but still fails

Same class of error (`unable to verify` / `self-signed certificate`) — the bundle you provided doesn't match the certificate FMC is actually presenting. Common causes: the bundle was pulled from a different host/instance, FMC's certificate was regenerated after you captured it, or you copied the wrong file. Re-run the `openssl s_client` command above against the live host and compare fingerprints.

### The exporter's own `/metrics` listener won't start after enabling native TLS

If `METRICS_TLS_CERT_PATH`/`METRICS_TLS_KEY_PATH` are set but point at empty files, this is caught explicitly and fails startup with:

```
METRICS_TLS_CERT_PATH ("...") is empty — expected PEM-encoded material
```

This is a deliberate check — without it, an empty cert file would let the listener bind successfully and then fail *every single handshake* forever, which is much harder to diagnose than a startup failure. Regenerate or re-copy the cert/key files.

---

## Network reachability

### Connection to FMC or SCC times out

Log line on `backend.init()` failure (standalone/Docker/Kubernetes all behave the same way here):

```
backend init() failed — exiting
```

with a message along the lines of a request being aborted after its timeout budget was exceeded, or a raw OS-level error (`connect ECONNREFUSED ...`, `getaddrinfo ENOTFOUND ...`) passed through as-is. During ongoing polling (after a successful startup), the same class of failure instead shows up as `ftd_exporter_poll_errors_total{reason="timeout"}` or `{reason="network"}`, with `ftd_exporter_up` dropping to `0` — the process keeps running and retries on the next cycle.

**This exact symptom has three common root causes that look identical from the log alone:**

1. **`FMC_HOST`/`SCC_BASE_URL` is simply wrong** (typo, wrong IP, decommissioned host). Test independently: `curl -v https://<host>` from the same machine/container/pod that's running the exporter.
2. **A firewall or security group is blocking the connection** between the exporter and the upstream host. Test from the same network path, not from your workstation — a `curl` that works from your laptop doesn't prove the exporter's own network path is open.
3. **(Kubernetes only) `NetworkPolicy` egress is blocking the connection** — see the next section. This is the one that's easiest to miss, because it produces the *exact same* connect-timeout symptom as a genuinely unreachable host, with nothing in the pod's logs, `kubectl describe pod`, or the exporter's own diagnostics pointing at the NetworkPolicy as the cause.

### Kubernetes: `NetworkPolicy` blocking egress to FMC on a non-default port

`deploy/kubernetes/networkpolicy.yaml`'s shipped default only opens egress on TCP/443. `FMC_HOST` accepts an explicit `host:port` (e.g. `fmc.example.com:8443`) — if your FMC listens on a non-standard port and the NetworkPolicy is applied unmodified, `init()` fails with a bare connect-timeout that gives no hint the NetworkPolicy is the cause.

**Fix**: open the actual port FMC listens on in `networkpolicy.yaml`'s egress rule (a commented-out example line is provided in the manifest), or temporarily remove the NetworkPolicy to confirm this is indeed the cause before adjusting it permanently.

### Kubernetes: `NetworkPolicy` blocking Prometheus from scraping the exporter

Different direction, same manifest: the ingress side of `networkpolicy.yaml` restricts scraping to a specific namespace (default `monitoring`). If your Prometheus/Alloy actually runs in a different namespace — for example, `microk8s`'s own `observability` addon runs Prometheus in a namespace called `observability`, not `monitoring` — the scrape target shows as down in Prometheus with no error anywhere pointing at the NetworkPolicy.

**Fix**: update the namespace selector in `networkpolicy.yaml` to match wherever your Prometheus Operator (or Alloy) is actually deployed. See [Kubernetes installation → Notes](INSTALL_KUBERNETES.md#notes).

If Alloy/Prometheus lives **outside** the cluster entirely, see [Kubernetes installation → Exposing the service outside the cluster](INSTALL_KUBERNETES.md#exposing-the-service-outside-the-cluster) — the fix there is a `LoadBalancer` Service, not a NetworkPolicy change.

---

## Rate limiting (usually expected behavior, not a bug)

Seeing `ftd_exporter_rate_limit_deferrals_total` increase is **normal** and does not mean anything is broken — it means the exporter's own internal rate limiter (SCC's 30-second spacing floor, or FMC's 300-requests/minute budget) delayed a request to stay within the upstream limit, exactly as designed. This is different from `ftd_exporter_poll_errors_total{reason="rate_limited"}`, which means an actual `429` from upstream survived all retries — that one's worth investigating (usually means `POLL_INTERVAL_SECONDS` is set too aggressively, or something else is also consuming your SCC/FMC request budget).

A single `429` that gets retried and then succeeds produces **no poll error at all** — you may see a log line about the retry, but `ftd_exporter_up` stays `1`. This is expected, especially on SCC, whose 2-requests/minute limit is easy to brush up against.

**If you're consistently seeing `poll_errors_total{reason="rate_limited"}`:**
- SCC: confirm `POLL_INTERVAL_SECONDS` is at least 30 (the enforced floor) — and consider raising it further if something else also polls the same SCC tenant.
- FMC: check `FMC_METRIC_FAMILIES` isn't unnecessarily requesting all five families on a large fleet — narrowing this cuts request volume per cycle. Also consider raising `POLL_INTERVAL_SECONDS` on fleets above roughly 40 devices.

---

## FMC discovery failures

### First-ever discovery fails at startup

If FMC device discovery fails on its very first attempt (no previously-cached device list to fall back on), `init()` fails loudly rather than starting up "successfully" with a permanently empty `/metrics`:

```
FMC device discovery failed on its first attempt (no previous device list to fall back on) — the exporter would otherwise come up "healthy" serving a permanently empty /metrics. Check FMC connectivity/credentials and restart.
```

This is the same exit-1 / "backend init() failed — exiting" path as any other `init()` failure. Check FMC connectivity and credentials as described above.

### Discovery fails on a later refresh (after already running)

This is much less severe: `FMC_DISCOVERY_INTERVAL_SECONDS` (default 900s) periodically re-checks the device list, and if that refresh fails, the exporter keeps using the **previously known device list** rather than failing the whole poll cycle. Only `ftd_exporter_discovery_errors_total` increments — `ftd_exporter_up` and device metrics are unaffected. If this persists, it usually means the same connectivity/credential issue as above, just not severe enough (yet) to fail an entire cycle.

### `FMC_HOST` is reachable but isn't actually FMC

If the host answers but doesn't behave like FMC (wrong product, wrong port, a proxy stripping headers), login can fail in a few different ways — a non-204 HTTP status, a connection reset, or a 204 response missing the expected `X-auth-access-token` header (in which case the log explicitly calls out a possible reverse proxy/load balancer stripping response headers). All of these fail `init()` the same way as any other `init()` failure — exit code 1, nothing silently half-working.

---

## "I don't have hardware to test chassis/HA/VPN metrics, but I want to help"

Chassis, HA, and RA/S2S VPN groups are marked experimental (see [README's Experimental metric groups](../README.md#experimental-metric-groups)) because their field names come from Cisco's documentation only and have never been observed populated with real data on either backend. If you have access to chassis-based hardware, an HA pair, RA VPN, or S2S VPN tunnels, you can help close this gap without writing any code:

1. Run `node dist/index.js --dump-raw` against your own FMC or SCC tenant. This performs one real poll cycle and writes sanitized raw upstream JSON to stdout only — see [CONTRIBUTING.md's fixture-contribution workflow](../CONTRIBUTING.md#contributing-sanitized-fixtures-fmc-schema-unknowns) for the full procedure.
2. Review the output yourself before sharing — sanitization covers credential-shaped values and UUID/IPv4-shaped substrings, but not every possible sensitive field (device names, hostnames, tunnel names are common candidates worth double-checking).
3. Open an issue using the [fixture contribution template](../.github/ISSUE_TEMPLATE/fixture_contribution.md) and attach the capture.

## Docker: container shows `unhealthy`

`docker ps` reporting `unhealthy` means the built-in `HEALTHCHECK` (which polls `/healthz` from inside the container) failed 3 times in a row. Since `/healthz` itself almost never fails once the process is listening (see [Endpoint reference](#endpoint-reference)), the actual cause is almost always one of:

- **The process never started** — check `docker logs <container>` for a config error (see above); the container may be in a restart loop.
- **`METRICS_PORT` was changed but the healthcheck can't tell** — the shipped healthcheck script reads `METRICS_PORT`/`METRICS_TLS_CERT_PATH` from the container's own environment, so this should self-correct automatically; if you've customized the image, confirm the healthcheck script wasn't hardcoded to the old port.
- **The container is still starting up** — the healthcheck has a 10s `--start-period` before failures count against it; a slow `backend.init()` (e.g. a slow FMC login) can occasionally exceed this on the very first check, which resolves itself once `init()` completes.

---

## Endpoint reference

| Endpoint | Meaning | Response |
|---|---|---|
| `GET /healthz` | Process is alive and the HTTP server itself is responding. **Independent of upstream health** — a Cisco outage never fails this. | `200 ok` almost always, once the process is listening. `503` only if the liveness check itself throws (a bug, not an operational state). |
| `GET /readyz` | The cache has been populated at least once. | `503 not ready — no successful poll yet` before the first successful poll. `200 ready` after — and **stays** `200` even if later polls fail, since the cache still holds the last-known-good data. |
| `GET /metrics` | Prometheus exposition format, rendered from the in-memory cache. Never triggers an upstream request. | `200` with the metrics body. `500` only on an internal rendering error. |
| `GET /` | Minimal landing page. | `200` HTML linking to `/metrics`. |

A `404`/`405` from any other path/method is expected routing behavior, not an error to investigate.

## Reading the self-metrics

These four, read together, tell you the exporter's actual health without needing to read logs:

| Metric | What it tells you |
|---|---|
| `ftd_exporter_up` | `1` if the *most recent* poll succeeded, `0` if it didn't. The fastest single signal for "is something currently wrong." |
| `ftd_exporter_cache_age_seconds` | How stale the data being served right now is. Climbs steadily if polling has stopped succeeding; a healthy exporter's value stays bounded by roughly `POLL_INTERVAL_SECONDS`. |
| `ftd_exporter_last_successful_poll_timestamp_seconds` | Unix timestamp of the last success — good for alerting: `time() - ftd_exporter_last_successful_poll_timestamp_seconds > <threshold>`. Unlike `cache_age_seconds`, this one is stable even across a restart mid-outage. |
| `ftd_exporter_poll_errors_total{reason}` | *Why* recent polls have failed. Valid `reason` values: `auth`, `rate_limited`, `timeout`, `network`, `http_5xx`, `parse`, `unknown`. Use this to jump straight to the relevant section above instead of reading logs line-by-line. |

Full metric reference: [docs/METRICS.md](METRICS.md).
