# Changelog

All notable changes to this project are documented in this file. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows SemVer, where metric names, metric labels, and environment variable names are the project's versioned public API — not the TypeScript types.

## [Unreleased]

### Added

- Smart License status (`ftd_license_registration_info`, `ftd_license_authorization_info`, `ftd_license_eval_used`, `ftd_license_eval_expires_in_days`, `ftd_license_last_synchronized_timestamp_seconds`, `ftd_license_last_renewed_timestamp_seconds`) on **both backends**, fleet/manager-scoped — the upstream response carries no device identifier at all. `SCC_LICENSE_POLL_INTERVAL_SECONDS`/`FMC_LICENSE_POLL_INTERVAL_SECONDS` (default 3600s).
- Certificate status (`ftd_certificate_expiry_timestamp_seconds`, `ftd_certificate_status_info`) on **both backends**, per enrolled certificate's CA/identity component. `SCC_CERTIFICATE_POLL_INTERVAL_SECONDS`/`FMC_CERTIFICATE_POLL_INTERVAL_SECONDS` (default 3600s).
- `ftd_exporter_license_errors_total`/`ftd_exporter_certificate_errors_total` self-metrics.

### Fixed

- Certificate-expiry field names/endpoint corrected before shipping, based on a live check against both backends rather than the original guess.
- Adversarial review found and fixed 9 issues before merge: degenerate license/certificate refreshes were treated as successful instead of failures on both backends, SCC's domain-UUID lookup bypassed the shared rate-limit guard, FMC's license/certificate refresh wasn't actually protected the way a comment claimed, duplicate certificates could silently overwrite each other, timestamp parsing accepted invalid calendar dates, and a couple of smaller enum/metric-exposition edge cases.

### Changed

- DESIGN.md §2.3: two narrow extension interfaces (`LicenseStatusBackend`, `DeviceCertificatesBackend`) added alongside the existing SCC-only `SccHealthBackend` pattern, since both new capabilities are implemented on both backends — `HealthBackend` itself stays untouched.
- `DeviceInventoryEntry` (SCC device inventory) gained `uidOnFmc`, live-confirmed to be `devices/certificates`' join key on SCC — a *third* device identifier distinct from both `/health/metrics`'s `deviceUid` and this same endpoint's own `uid`.

## [0.2.0] - 2026-08-11

### Added

- `dashboards/ftd-health.json`: a generated Grafana dashboard (37 panels across 8 rows, exporter health first) covering both backends' full metric surface.
- `alerts/ftd-health.yaml`: 14 Prometheus alert rules across 8 groups, with `alerts/ftd-health.test.yaml` promtool unit tests covering every rule in both directions. `FtdExporterAbsent` is built on Prometheus's own `up{job="ftd-metrics"}` rather than an `ftd_*` series, so it still fires once the exporter process itself has died and every other rule has gone silent.
- `docs/DASHBOARDS_AND_ALERTS.md` documenting both, and the import/provisioning steps for Grafana and Prometheus.
- `ftd_device_info`/`ftd_device_connectivity_up` (SCC only), sourced from SCC's device inventory on its own poll cadence (`SCC_INVENTORY_POLL_INTERVAL_SECONDS`, default 300s) — closes the gap where a device SCC reports as fully `UNREACHABLE` was silently absent from every other `ftd_*` metric.
- `FtdDeviceUnreachable` alert and two dashboard stat panels ("Devices in SCC inventory", "Devices unreachable") built on the metrics above.
- `ftd_exporter_scc_inventory_errors_total` self-metric.
- `interface_type` now goes through a recognize-or-flag diagnostic path (`ftd_exporter_unknown_enum_total`) for an unrecognized value, without ever changing what is actually rendered (DESIGN.md §4.4's carve-out for this field).

### Fixed

- The "Devices with an unhealthy signal" dashboard panel undercounted distinct devices via `count by (device_uid)` alone — silently wrong once two nodes of an SCC HA pair (which share one `device_uid`, confirmed live) breach different thresholds at once. Fixed to `count by (device_uid, device_name)`.
- The named-interface alert filter (`FtdInterfaceDown`/`FtdInterfaceErrors`) could suppress a genuinely-down named interface on one SCC HA peer because of an unnamed interface at the same hardware id on the other peer — the two peers share one `device_uid`. Fixed by adding `device_name` to the filter's match/fold label lists.

### Changed

- `haHealthMetrics` is no longer documented as experimental on the SCC backend — validated against a real HA pair (2026-08-11). Remains experimental on FMC.
- DESIGN.md's framing of `device_uid` as a stable per-device join key is corrected for the SCC HA case: both peers share one `device_uid`, distinguished only by `device_name` (§14.14).

## [0.1.0] - 2026-08-07

Pre-1.0 (`0.x`) — see [docs/RELEASE_CHECKLIST.md](docs/RELEASE_CHECKLIST.md) for the remaining items before a 1.0 cut.

### Added

- Standalone (npm/Node.js), Docker, and Kubernetes deployment paths, all three live-verified against a real SCC tenant.
- Two backends: Security Cloud Control (SCC/cdFMC) and standalone on-prem FMC.
- `ftd_*` device health metrics (CPU, memory, disk, interfaces; chassis/HA/RA VPN/S2S experimental on both backends) and `ftd_exporter_*` self-observability metrics.
- `--dump-raw` capture mode for contributing sanitized fixtures.
- Repository hygiene: CI (OS/Node matrix, secret scanning, `npm audit`, no-native-addons check), release automation (GHCR multi-arch image with provenance/SBOM, npm publish with provenance), Dependabot, monthly base-image rebuild and vulnerability scan.

### Experimental

- Chassis, HA, and RA VPN/S2S VPN metric groups on both backends — field names may change in a minor release until validated against real hardware/configurations.

[Unreleased]: https://github.com/apilbeam101/ftd-metrics-exporter/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/apilbeam101/ftd-metrics-exporter/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/apilbeam101/ftd-metrics-exporter/releases/tag/v0.1.0
