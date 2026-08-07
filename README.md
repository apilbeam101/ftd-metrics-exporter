# ftd-metrics-exporter

> **Not an official Cisco product.** This is an independently maintained, community project and is not affiliated with, endorsed by, or supported by Cisco Systems, Inc. "Cisco", "FTD", "FMC", and "Security Cloud Control" are trademarks of Cisco.

A Prometheus exporter for Cisco FTD firewall health metrics (CPU, memory, disk, chassis, interfaces, HA, VPN), supporting both Security Cloud Control (SCC/cdFMC) and standalone on-prem FMC as backends.

**Status:** pre-release, under active implementation.

Full usage documentation, deployment instructions, and the configuration reference will be written as the corresponding implementation stages land.

## Installation

Three deployment methods are supported. Pick one — each is self-contained, full instructions are linked below.

### Standalone (Node.js)

Install Node.js 24+, then either:

```
npm ci && npm run build
```

or

```
npm install -g ftd-metrics-exporter
```

Copy `example.env` to `.env` and fill it in, then run:

```
node dist/index.js
```

Supervise with systemd (Linux), launchd (macOS), or Task Scheduler/NSSM (Windows).
→ [Full standalone installation guide](docs/INSTALL_STANDALONE.md)

### Docker

```
docker pull ghcr.io/apilbeam101/ftd-metrics-exporter:0.1
docker run --rm --env-file .env -p 10049:10049 \
  --read-only --cap-drop=ALL --security-opt=no-new-privileges \
  ghcr.io/apilbeam101/ftd-metrics-exporter:0.1
```

or use [deploy/docker-compose.yml](deploy/docker-compose.yml).
→ [Full Docker installation guide](docs/INSTALL_DOCKER.md)

### Kubernetes

Plain YAML manifests in [deploy/kubernetes/](deploy/kubernetes/) — ConfigMap, Secret, Deployment, Service, ServiceMonitor/PodMonitor, NetworkPolicy:

```
kubectl apply -f deploy/kubernetes/configmap.yaml
kubectl apply -f deploy/kubernetes/secret.yaml
kubectl apply -f deploy/kubernetes/deployment.yaml
kubectl apply -f deploy/kubernetes/service.yaml
```

→ [Full Kubernetes installation guide](docs/INSTALL_KUBERNETES.md)

## Configuration

Every variable is documented in full detail — including how to obtain each credential — in [example.env](example.env), the authoritative reference. This section is a quick map of what you actually need to provide, split by backend.

### Required for every deployment

| Variable | Notes |
|---|---|
| `BACKEND_TYPE` | `scc` or `fmc`. No default — pick one, and only fill in that backend's block below. |

### Required — SCC (`BACKEND_TYPE=scc`)

| Variable | Notes |
|---|---|
| `SCC_BASE_URL` | Your SCC region's API base URL (e.g. `https://api.eu.security.cisco.com/firewall`). No default — you must state your region explicitly. |
| `SCC_API_TOKEN` | Static bearer token from a dedicated, read-only, API-only SCC user. Shown once at creation — copy it immediately. |
| `SCC_FMC_UID` | UID of the cloud-delivered FMC (cdFMC) whose devices you want polled. From the SCC inventory UI or `GET /v1/inventory/managers`. |

Optional for SCC: `SCC_TIME_RANGE` (averaging window, defaults to `5m`).

### Required — standalone FMC (`BACKEND_TYPE=fmc`)

| Variable | Notes |
|---|---|
| `FMC_HOST` | FMC hostname (preferred over an IP, for TLS hostname verification) or IP. |
| `FMC_USERNAME` | A dedicated API-only service account — **not** your own admin login, which would intermittently log itself out of the FMC UI. |
| `FMC_PASSWORD` | That service account's password. |

Optional for FMC, and auto-populated/defaulted if you leave them unset:

| Variable | Default / auto-behavior |
|---|---|
| `FMC_DOMAIN_UUID` | Auto-resolved from the access token's claims (the Global domain, typically) if unset. Only set explicitly to scope to a sub-domain. |
| `FMC_CA_BUNDLE_PATH` | Unset = trusts only public CAs, which will reject FMC's default self-signed cert. Recommended once you've pulled FMC's certificate — see example.env for the `openssl s_client` command. |
| `FMC_TLS_INSECURE_SKIP_VERIFY` | Defaults to `false`. Lab/test only — never `true` in production. |
| `FMC_MAX_CONCURRENT_REQUESTS` | Defaults to `5` (FMC's own limit is 10 per source IP; the default leaves headroom for other API consumers). |
| `FMC_DISCOVERY_INTERVAL_SECONDS` | Defaults to `900` (15 min) — device inventory changes slowly. |
| `FMC_METRIC_FAMILIES` | Defaults to all five (`CPU,MEM,INTERFACE,DISK_STATS,CHASSIS_STATS`). Narrow this to cut per-cycle request volume on large fleets. |
| `FMC_TIME_RANGE` | Defaults to `5m`. |

### Optional for both backends

These have working defaults and rarely need to change:

| Variable | Default |
|---|---|
| `METRICS_PORT` | `10049` |
| `METRICS_BIND_ADDRESS` | `0.0.0.0` |
| `POLL_INTERVAL_SECONDS` | `60` (SCC enforces a 30s floor) |
| `LOG_LEVEL` | `info` |
| `LOG_FORMAT` | `json` |
| `REQUEST_TIMEOUT_SECONDS` | `30` |
| `ENABLE_DEFAULT_METRICS` | `true` |

Native TLS for the `/metrics` listener itself (`METRICS_TLS_CERT_PATH`, `METRICS_TLS_KEY_PATH`, `METRICS_TLS_MIN_VERSION`, `METRICS_TLS_CLIENT_CA_PATH`) is a separate, optional concern covered under [TLS](#tls) below — leave all four unset if you terminate TLS at a reverse proxy instead.

## What gets collected

Every device metric is emitted per-device (`device_uid`, `device_name` labels), polled on `POLL_INTERVAL_SECONDS` and served from an in-memory cache. Conditional groups (chassis, HA, RA VPN, S2S) are emitted only when a device actually has that capability configured — never as zero.

| Category | Examples | Always present? |
|---|---|---|
| CPU / memory / disk usage | `ftd_cpu_usage_ratio`, `ftd_memory_usage_ratio`, `ftd_disk_usage_ratio` | Yes |
| Interfaces | link/operational status, input/output bytes, errors, drops, duplex | Yes, per interface |
| Chassis (hardware appliances) | fan RPM, PSU fan/input/output status | Only if chassis-capable |
| High availability | HA role (`ftd_ha_node_info`), HA node status | Only if HA-configured |
| Remote-access VPN | active/inactive/peak-concurrent session counts | Only if RA VPN-configured |
| Site-to-site VPN | per-tunnel state | Only if S2S tunnels exist |
| Exporter self-metrics (`ftd_exporter_*`) | `up`, `cache_age_seconds`, `poll_errors_total`, token refresh/reauth counts (FMC) | Yes |

Full metric names, types, labels, and descriptions: [docs/METRICS.md](docs/METRICS.md) (generated from the metric declarations, always in sync).

### Experimental metric groups

**Chassis, HA, and RA/S2S VPN metrics are experimental in v1, on both backends.** Their field names come from Cisco's documentation only and have never been observed populated with real chassis/HA/VPN data on either SCC or standalone FMC. These groups' metric names and labels **may change in a minor release**, unlike the CPU/memory/disk/interface metrics, which are stable. If you have hardware or configurations that would let you validate one of these groups against a real device, see [CONTRIBUTING.md's fixture-contribution workflow](CONTRIBUTING.md#contributing-sanitized-fixtures-fmc-schema-unknowns).

Running into a problem? See [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) — covers common configuration, permissions, and reachability issues across all three deployment methods.

## Endpoints

- `GET /metrics` — Prometheus exposition format, rendered from the in-memory cache. Never triggers an upstream request; scrape latency does not depend on upstream health.
- `GET /healthz` — 200 while the process is alive and the HTTP server is responding. Deliberately independent of upstream API health — a Cisco outage must not trigger a restart loop, since a restart would discard the cache for no benefit.
- `GET /readyz` — 200 once the first successful poll has populated the cache, 503 before that. Stays 200 after a later poll failure: readiness reflects "the cache has data," not "upstream is currently healthy."

## Security posture

- **No authentication on `/metrics`.** This is a decision, not an omission. `/metrics` exposes device names, interface names, and topology-adjacent data — sensitive, but not credential material.
- **Do not expose `/metrics` to untrusted networks.** The exporter binds `0.0.0.0` by default; set `METRICS_BIND_ADDRESS` to a specific interface on multi-homed hosts.
- Access control belongs at the network layer — bind address, Kubernetes `NetworkPolicy`, firewall rules — or at a reverse proxy/service mesh in front of the listener.
- Mutual TLS (`METRICS_TLS_CLIENT_CA_PATH`) is available for cryptographic client authentication and is the strongest access control the exporter offers natively.

## TLS

The exporter's own listener runs as plain HTTP by default. For most Prometheus/Alloy deployments, terminating TLS at a reverse proxy, ingress, or service mesh and running the listener as plain HTTP is the simpler and recommended posture — certificate lifecycle is then handled by infrastructure already built for it.

Native TLS is supported for deployments with no proxy in front (e.g. a standalone process on a jump host):

- Enabled by setting `METRICS_TLS_CERT_PATH` **and** `METRICS_TLS_KEY_PATH` together.
- `METRICS_TLS_MIN_VERSION` floors the listener at TLS 1.2 or 1.3 (default `TLSv1.2`); no downgrade option.
- `METRICS_TLS_CLIENT_CA_PATH` enables mutual TLS.
- **Certificate reload requires a restart.** There is no hot-reload of TLS material in this version — replacing the cert/key files takes effect only on the next start.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for dev setup, running the checks, and coding standards.

**Don't have chassis-based hardware, an HA pair, RA VPN, or S2S VPN tunnels to test against?** You can still help close the [experimental metric groups](#experimental-metric-groups) above without writing any code — [CONTRIBUTING.md's fixture-contribution workflow](CONTRIBUTING.md#contributing-sanitized-fixtures-fmc-schema-unknowns) walks through capturing a sanitized `--dump-raw` snapshot from your own device and submitting it via the [fixture contribution issue template](.github/ISSUE_TEMPLATE/fixture_contribution.md).

---

For the architecture and design rationale behind these decisions, see [docs/DESIGN.md](docs/DESIGN.md); for the implementation roadmap, see [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md).
