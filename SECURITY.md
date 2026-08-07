# Security policy

## Reporting a vulnerability

Report suspected vulnerabilities privately via [GitHub Security Advisories](https://github.com/apilbeam101/ftd-metrics-exporter/security/advisories/new) for this repository. Do not open a public issue for a suspected vulnerability.

Given this exporter handles Cisco FMC/SCC credentials, please include:

- The affected version (`ftd_exporter_build_info` metric, or the image/npm tag).
- Whether the finding is in the exporter's own code, a runtime dependency (`prom-client`, `undici`), or the base container image — see "Container image CVEs" below, since the last category has a different, non-code response.
- **Redacted** logs or config only — see the README's troubleshooting section for how to redact before sharing.

## Supported versions

Pre-1.0 (`0.x`): only the most recently published minor version receives fixes, matching the project's rapid pre-1.0 iteration pace. Once 1.0 ships, this section will be updated with the supported major/minor lines.

## Container image CVEs (base image, not source code)

`node:26-slim` (Debian-based) is the runtime base for the published image. A CVE reported against a Debian package in the image is **not** a defect in this project's source and is not addressed by a source-code fix — it's addressed by rebuilding against a patched base image. Policy:

- **The published image is rebuilt monthly** (1st of the month, `.github/workflows/rebuild.yml`), picking up whatever Debian security patches have landed in `node:26-slim` since the previous rebuild.
- **Only the moving tags are rebuilt and republished**: `latest`, the major tag (e.g. `1`), and the minor tag (e.g. `1.2`). **Exact-version tags (e.g. `1.2.3`) are never overwritten** — pinning an exact version is a genuine immutability guarantee, not just a convention. If you need the latest base-image patches without waiting for the next source release, pin the minor or major tag instead of an exact version.
- **The published image is also scanned monthly** (`.github/workflows/scan.yml`), independent of the rebuild, with results posted to this repository's Security tab and a tracking issue opened on new high/critical findings. This scan is what surfaces a rebuild that silently stopped running (scheduled workflows in a public GitHub repo are auto-disabled after 60 days of no repository activity) or a mid-month advisory severe enough to warrant an out-of-band rebuild rather than waiting for the 1st.
- **A CVE affecting only the build stage** (the `node:26` builder, which never ships — see the Dockerfile) is not a runtime exposure and is not tracked here.

This means: at any point in time, a published image can be carrying an unpatched Debian advisory for up to roughly a month between rebuilds. If that window is unacceptable for your deployment, rebuild the image yourself from source against a current base image rather than relying solely on the published schedule.

## Provenance and verification

Published images carry build provenance and an SBOM attestation. Verify what you're running with:

```
gh attestation verify oci://ghcr.io/apilbeam101/ftd-metrics-exporter:<tag> -R apilbeam101/ftd-metrics-exporter
```

The npm package is published with `npm publish --provenance`.

## Dependency hygiene

- Two runtime dependencies (`prom-client`, `undici`), tracked by Dependabot and `npm audit` in CI.
- `package-lock.json` is committed; CI and the published image both use `npm ci` exclusively.
- No `postinstall`/`preinstall` lifecycle scripts in the published package — installing with `--ignore-scripts` should work identically.
- No live-credential CI job exists or will be added — live verification against a real SCC/FMC is a manual maintainer step recorded in [docs/RELEASE_CHECKLIST.md](docs/RELEASE_CHECKLIST.md), never automated.
