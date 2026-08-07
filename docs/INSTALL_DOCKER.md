# Docker installation

This page is everything a Docker user needs — no need to also read the standalone installation page.

## Pull

```
docker pull ghcr.io/apilbeam101/ftd-metrics-exporter:0.1
```

Published to GHCR on every tagged release, multi-arch (`linux/amd64`, `linux/arm64`), with build provenance and an SBOM attached — verify what you're running with `gh attestation verify oci://ghcr.io/apilbeam101/ftd-metrics-exporter:0.1 -R apilbeam101/ftd-metrics-exporter`. The image is public; no `docker login` or pull secret is needed.

Tags: an exact version (`0.1.2`), minor (`0.1`), major (`0`), and `latest`. **Pin at least the minor tag in production** — `latest` moves with every release, and even the exact-version tag is periodically rebuilt (never its content, only its base-image layer — see [SECURITY.md](../SECURITY.md)) so its digest can change between releases. For the strongest guarantee, pin a digest instead of a tag: `ghcr.io/apilbeam101/ftd-metrics-exporter@sha256:...`.

Building from source instead of pulling (contributors, air-gapped environments):

```
docker build -t ftd-metrics-exporter .
```

Multi-stage: a `node:26` builder compiles TypeScript, and only `dist/` plus production dependencies are copied into the `node:26-slim` runtime image — no compiler, no source, no dev dependencies ship. The image runs as a fixed non-root UID/GID (`10001:10001`), not the base image's default `node` user, so the UID is predictable for volume permissions and Kubernetes `runAsUser`.

## Run

```
docker run --rm --env-file .env -p 10049:10049 \
  --read-only --cap-drop=ALL --security-opt=no-new-privileges \
  ghcr.io/apilbeam101/ftd-metrics-exporter:0.1
```

(Substitute `ftd-metrics-exporter` for the image name if you built from source instead of pulling.)

- `--env-file .env` — the same `.env` used by the standalone path; it is read by the Docker CLI on the host and injected as environment variables, never copied into the image or a volume. Prefer this over individual `-e` flags for secrets: values passed via `-e` are visible in shell history and `docker inspect`. `-e` flags are fine for non-secret variables (e.g. `-e LOG_LEVEL=debug`).
- `--read-only` works with no `tmpfs` mounts — the exporter never writes to disk (in-memory cache, stdout logging only).
- `--cap-drop=ALL` and `--security-opt=no-new-privileges` — the exporter needs no Linux capabilities and never re-elevates.

Verify: `curl http://localhost:10049/metrics` returns `ftd_exporter_up 1`, same as the standalone path.

## CA bundle mount

`FMC_CA_BUNDLE_PATH` (and, if using the exporter's native TLS listener, `METRICS_TLS_CERT_PATH`/`METRICS_TLS_KEY_PATH`) are file-valued — the one case environment variables alone can't cover. Mount the file read-only and point the variable at the in-container path:

```
docker run --rm --env-file .env -p 10049:10049 \
  -v /host/ca.pem:/etc/ftd-exporter/ca.pem:ro \
  --read-only --cap-drop=ALL --security-opt=no-new-privileges \
  ghcr.io/apilbeam101/ftd-metrics-exporter:0.1
```

Set `FMC_CA_BUNDLE_PATH=/etc/ftd-exporter/ca.pem` in `.env` to match.

## docker-compose

[deploy/docker-compose.yml](../deploy/docker-compose.yml) is the same invocation in compose form, pulling the published image by default (with a commented-out `build: ..` line for contributors), using `env_file:` and the same read-only/cap-drop hardening.

## Troubleshooting

Config errors, credential/TLS failures, reachability issues, and the container `unhealthy` state are covered in [docs/TROUBLESHOOTING.md](TROUBLESHOOTING.md).
