# Live-API smoke test (Stage 13 wrap-up)

**Current status:** the SCC backend has passed this smoke test on all three
deployment surfaces (standalone, Docker, Kubernetes) — see
`docs/RELEASE_CHECKLIST.md`'s results log for details. The FMC backend has
passed on the standalone surface only; the Docker and Kubernetes legs remain
unattempted because they need simultaneous network access to both a live FMC
host and the Docker/Kubernetes host, which isn't always available. A future
attempt needs either a host with routes to both networks, or a mock FMC
server seeded from a real `--dump-raw` capture (the same approach already
used to validate the Docker/Kubernetes packaging itself, before any live FMC
credential was available).

Manual maintainer runbook — never a CI job, since live verification holds
real credentials that must never be exposed to CI. Validates Stage 13's
three packaging surfaces (standalone, Docker, Kubernetes) against **real**
SCC and FMC APIs, since 13A/13B/13C were each tested "for real" against mock
upstream servers only (no live credential was available at the time those
stages were built).

**Not the same as Stage 16.** This is a ~10-15 minute smoke test per
backend/surface combination — enough poll cycles to see real device data and
confirm no unexpected errors. Stage 16 owns the separate ≥7-day sustained-run
validation (rate-limit behavior over days, memory growth, FMC token-lifecycle
arithmetic). Do not conflate the two; running this smoke test does not
satisfy Stage 16's scope.

## Prerequisites

Check these before starting — each is a change since 13A/13B/13C's
mock-based runs, and failing fast here is cheaper than debugging through
three deployment surfaces.

- **SCC token still valid.** The token in `.env` is long-lived but can be
  revoked/rotated independently of this repo. Confirm with one manual
  request before wiring up the exporter:
  ```
  curl -s -o /dev/null -w '%{http_code}\n' \
    -H "Authorization: Bearer $SCC_API_TOKEN" \
    "$SCC_BASE_URL/v1/inventory/managers/$SCC_FMC_UID/health/metrics?timeRange=5m"
  ```
  Expect `200`. A `401`/`403` means the token needs rotating before
  continuing.
- **FMC reachability from wherever each surface runs.** Confirm `FMC_HOST`
  in `.env` is reachable from each test location before assuming it works:
  - Standalone: reachable directly from the machine running the exporter,
    or via SSH to whichever Linux host you use for the Docker/Kubernetes
    legs below.
  - Docker: runs from a Linux host with confirmed general internet
    access — but the FMC network is a separate, likely internal,
    reachability question. Verify with `curl -sk https://<fmc-host>:<port>`
    from that host before assuming it works.
  - Kubernetes: pod egress additionally depends on `networkpolicy.yaml`'s
    applied egress rule. That manifest's default only opens TCP/443 — if
    FMC listens on a non-default port and `networkpolicy.yaml` is applied
    during this test, uncomment/adjust its commented-out non-443 egress
    line for that port, or the pod will see a bare connect-timeout
    indistinguishable from FMC actually being down.
- **FMC account hygiene.** `example.env` documents that this must be a
  dedicated API-only service account, since Cisco silently logs out a
  shared UI session when the same account is used via the API. The `.env`
  username is currently `admin` — confirm this is an account nobody is
  concurrently using the FMC web UI with before running, or expect
  spurious logout complaints unrelated to the exporter.

## Procedure

Run each backend against each surface independently. Poll interval stays at
its real default in every run — 60s floor for SCC (its 2 req/min limit),
FMC's own 60s default — since the point is to observe real rate-limit
behavior, not to rush the test. Run each combination for ~10-15 minutes
(10-15 poll cycles) before checking results.

### Standalone

1. Ensure `.env` has the correct backend block active (`BACKEND_TYPE=scc` or
   `fmc`) — only one block's variables take effect at a time; the other
   block should stay commented out to avoid the cross-backend startup
   warning.
2. `node dist/index.js` (or the npm-installed `ftd-metrics-exporter` binary).
3. After a few cycles: `curl http://localhost:10049/metrics`,
   `curl http://localhost:10049/healthz`, `curl http://localhost:10049/readyz`.

### Docker

Run from a Linux host with confirmed Docker Engine + registry access.

```
docker run --rm --env-file .env -p 10049:10049 \
  --read-only --cap-drop=ALL --security-opt=no-new-privileges \
  ftd-metrics-exporter
```

Same checks as standalone, from that host or via SSH port-forward.

### Kubernetes

Uses a real cluster (e.g. `microk8s` on a Linux host). **Never commit a
populated Secret** — create `secret.yaml` and `configmap.yaml` fresh on the
cluster host for this test only, from the real `.env` values, and delete
them when done, mirroring how 13B/13C already cleaned up their own
test-only artifacts each session.

1. `cp deploy/kubernetes/secret.example.yaml secret.yaml` (on the cluster
   host, outside the repo checkout) and fill in the real `SCC_API_TOKEN` or
   `FMC_USERNAME`/`FMC_PASSWORD`.
2. Apply `configmap.yaml` (with the real `BACKEND_TYPE`/`FMC_HOST`/etc.),
   `secret.yaml`, `deployment.yaml`, `service.yaml`.
3. If also re-verifying `networkpolicy.yaml` for this run, adjust its egress
   port per the non-default-FMC-port note above before applying it.
4. `kubectl port-forward svc/ftd-metrics-exporter -n monitoring 10049:10049`,
   same `curl` checks as above.
5. **Clean up afterward**: delete the Deployment/Service/ConfigMap/Secret/
   NetworkPolicy created for this test, and delete the local `secret.yaml`
   file from the cluster host. Never leave live credentials sitting in a
   cluster or on disk longer than the test itself.

## What "pass" looks like

- `ftd_exporter_up 1`.
- Real device series present on `/metrics` — not just the `ftd_exporter_*`
  self-metrics. Confirms actual device data flowed through the real mapper,
  not just that the connection succeeded.
- `/healthz` and `/readyz` both `200` after the first successful cycle.
- `ftd_exporter_poll_errors_total` is either absent or only shows expected
  reason values — `rate_limited` is fine if the interval is tight against
  SCC's 2/min budget, and a metric-group absence tied to health-policy
  gating is fine (see the propagation-delay note below) — but `auth_fatal`
  or an unexpected 4xx/5xx status is not.
- SCC specifically: no `429` responses at the default 60s interval.
- If a metric group looks unexpectedly absent right after changing a health
  policy in the SCC/FMC UI, wait — an observed propagation delay of under
  5 minutes between a policy change and the metrics API reflecting it has
  been documented. Checking immediately after a policy change risks a
  false negative.

## Recording results

Append a short results line (backend × surface × pass/fail × date) to
`docs/RELEASE_CHECKLIST.md`'s "Every release" entry.

Optional, not required: a sanitized `--dump-raw` capture from one of these
runs (`node dist/index.js --dump-raw`) is a good opportunity to contribute a
real (not synthetic/provisional) FMC fixture — see the `--dump-raw` workflow
this project's own `src/dump-raw.ts` already implements, and sanitize before
committing anything.
