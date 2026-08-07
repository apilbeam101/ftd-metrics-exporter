# Changelog

All notable changes to this project are documented in this file. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows SemVer, where metric names, metric labels, and environment variable names are the project's versioned public API — not the TypeScript types.

## [Unreleased]

Pre-1.0 (`0.x`) — see [docs/RELEASE_CHECKLIST.md](docs/RELEASE_CHECKLIST.md) for the remaining items before a 1.0 cut.

### Added

- Standalone (npm/Node.js), Docker, and Kubernetes deployment paths, all three live-verified against a real SCC tenant.
- Two backends: Security Cloud Control (SCC/cdFMC) and standalone on-prem FMC.
- `ftd_*` device health metrics (CPU, memory, disk, interfaces; chassis/HA/RA VPN/S2S experimental on both backends) and `ftd_exporter_*` self-observability metrics.
- `--dump-raw` capture mode for contributing sanitized fixtures.
- Repository hygiene: CI (OS/Node matrix, secret scanning, `npm audit`, no-native-addons check), release automation (GHCR multi-arch image with provenance/SBOM, npm publish with provenance), Dependabot, monthly base-image rebuild and vulnerability scan.

### Experimental

- Chassis, HA, and RA VPN/S2S VPN metric groups on both backends — field names may change in a minor release until validated against real hardware/configurations.

[Unreleased]: https://github.com/apilbeam101/ftd-metrics-exporter/commits/main
