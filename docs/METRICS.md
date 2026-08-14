# Metric reference

Generated from `src/metrics/device-metrics.ts`, `src/metrics/inventory-metrics.ts`,
`src/metrics/license-metrics.ts`, `src/metrics/certificate-metrics.ts`, and
`src/metrics/self.ts` by `scripts/generate-metrics-doc.ts`. Do not hand-edit the tables below —
regenerate instead. For the full design rationale and the metric-surface
stability contract, see [DESIGN.md](DESIGN.md).

## Device health metrics (`ftd_*`)

Conditional groups (`ftd_chassis_*`, `ftd_ha_*`, `ftd_ravpn_*`, `ftd_s2s_*`) are
emitted only when the corresponding upstream data is present for a device —
never as zero, never as `NaN`.

| Metric | Type | Labels | Description |
|---|---|---|---|
| `ftd_chassis_fan_rpm` | gauge | device_uid, device_name, fan | Chassis fan speed in RPM. |
| `ftd_chassis_psu_fan_up` | gauge | device_uid, device_name, psu | 1 if the PSU fan status is up, 0 if down. Omitted when unrecognized. |
| `ftd_chassis_psu_input_up` | gauge | device_uid, device_name, psu | 1 if the PSU input status is up, 0 if down. Omitted when unrecognized. |
| `ftd_chassis_psu_output_up` | gauge | device_uid, device_name, psu | 1 if the PSU output status is up, 0 if down. Omitted when unrecognized. |
| `ftd_cpu_usage_ratio` | gauge | device_uid, device_name, component | Average CPU utilization over the sample window, 0-1. |
| `ftd_disk_usage_ratio` | gauge | device_uid, device_name | Average disk utilization over the sample window, 0-1. |
| `ftd_ha_node_info` | gauge | device_uid, device_name, node_type | Always 1. Informational; node_type carries the HA role. |
| `ftd_ha_node_status` | gauge | device_uid, device_name, status | State set: exactly one status label is 1 for a given device. |
| `ftd_health_window_end_timestamp_seconds` | gauge | device_uid, device_name | End of the averaging window this snapshot describes, unix seconds. |
| `ftd_health_window_start_timestamp_seconds` | gauge | device_uid, device_name | Start of the averaging window this snapshot describes, unix seconds. |
| `ftd_interface_buffer_overruns_avg` | gauge | device_uid, device_name, interface, interface_name, interface_type | Average buffer overrun count over the sample window. |
| `ftd_interface_buffer_underruns_avg` | gauge | device_uid, device_name, interface, interface_name, interface_type | Average buffer underrun count over the sample window. |
| `ftd_interface_drop_packets_avg` | gauge | device_uid, device_name, interface, interface_name, interface_type | Average dropped packet count over the sample window. |
| `ftd_interface_duplex_info` | gauge | device_uid, device_name, interface, interface_name, interface_type, duplex_mode | Always 1. Informational; duplex_mode carries the reported value. |
| `ftd_interface_input_bytes_avg` | gauge | device_uid, device_name, interface, interface_name, interface_type | Average inbound byte counter over the sample window. |
| `ftd_interface_input_errors_avg` | gauge | device_uid, device_name, interface, interface_name, interface_type | Average inbound error count over the sample window. |
| `ftd_interface_input_packet_size_avg_bytes` | gauge | device_uid, device_name, interface, interface_name, interface_type | Average inbound packet size over the sample window. |
| `ftd_interface_l2_decode_drops_avg` | gauge | device_uid, device_name, interface, interface_name, interface_type | Average L2 decode drop count over the sample window. |
| `ftd_interface_link_up` | gauge | device_uid, device_name, interface, interface_name, interface_type | 1 if the interface link is up, 0 if down. Omitted when link status is unrecognized. |
| `ftd_interface_operational_up` | gauge | device_uid, device_name, interface, interface_name, interface_type | 1 if the interface is operationally up, 0 if down. Omitted when operational status is unrecognized. |
| `ftd_interface_output_bytes_avg` | gauge | device_uid, device_name, interface, interface_name, interface_type | Average outbound byte counter over the sample window. |
| `ftd_interface_output_errors_avg` | gauge | device_uid, device_name, interface, interface_name, interface_type | Average outbound error count over the sample window. |
| `ftd_interface_output_packet_size_avg_bytes` | gauge | device_uid, device_name, interface, interface_name, interface_type | Average outbound packet size over the sample window. |
| `ftd_memory_usage_ratio` | gauge | device_uid, device_name, component | Average memory utilization over the sample window, 0-1. |
| `ftd_ravpn_sessions_active_avg` | gauge | device_uid, device_name | Average active RA VPN session count over the sample window. |
| `ftd_ravpn_sessions_inactive_avg` | gauge | device_uid, device_name | Average inactive RA VPN session count over the sample window. |
| `ftd_ravpn_sessions_peak_concurrent` | gauge | device_uid, device_name | Peak concurrent RA VPN session count over the sample window. |
| `ftd_s2s_tunnel_state` | gauge | device_uid, device_name, tunnel_id, tunnel_name, state | State set: exactly one state label is 1 for a given tunnel. |

## Device inventory metrics (`ftd_device_*`, SCC only)

From SCC's device inventory (DESIGN.md §14.6), on its own poll cadence independent of
the health-metrics poll above — populated even for a device absent from every other
`ftd_*` series (e.g. one SCC reports UNREACHABLE). Not available on the FMC backend,
which has no equivalent inventory endpoint wired up.

| Metric | Type | Labels | Description |
|---|---|---|---|
| `ftd_device_connectivity_up` | gauge | device_uid, device_name | 1 if SCC device inventory reports the device ONLINE, 0 if UNREACHABLE. Independent of the health-metrics poll — populated even for a device absent from every other ftd_* series. Omitted when connectivity state is absent or unrecognized. |
| `ftd_device_info` | gauge | device_uid, device_name, redundancy_mode | Always 1. Informational; from SCC device inventory. redundancy_mode carries standalone/ha (lowercased), or unknown. |

## Smart License status metrics (`ftd_license_*`, both backends)

DESIGN.md §4.6.2. Fleet/manager-scoped — the upstream response carries no device
identifier at all, so unlike every other metric group in this project, none of these
gauges carry `device_uid`/`device_name` labels. On its own poll cadence, independent
of every other poll.

| Metric | Type | Labels | Description |
|---|---|---|---|
| `ftd_license_authorization_info` | gauge | auth_status | Always 1 when license authorization status is known. auth_status carries the raw Smart License authorization state (lowercased), or unknown. Omitted if upstream did not report an authorization status. |
| `ftd_license_eval_expires_in_days` | gauge | (none) | Days remaining in the Smart License evaluation period. Omitted if upstream did not report this field. |
| `ftd_license_eval_used` | gauge | (none) | 1 if the Smart License evaluation period has been used, 0 otherwise. Omitted if upstream did not report this field. |
| `ftd_license_last_renewed_timestamp_seconds` | gauge | (none) | Unix timestamp of the last Smart License renewal. Omitted if upstream did not report this field. |
| `ftd_license_last_synchronized_timestamp_seconds` | gauge | (none) | Unix timestamp of the last successful Smart License synchronization with Cisco. Omitted if upstream did not report this field. |
| `ftd_license_registration_info` | gauge | reg_status | Always 1 when license status is known. reg_status carries the raw Smart License registration state (lowercased), or unknown. |

## Certificate status metrics (`ftd_certificate_*`, both backends)

DESIGN.md §4.6.2. Per enrolled certificate's CA/identity component. A component
reported `NOT_APPLICABLE` upstream (e.g. a self-signed certificate has no CA
component) is omitted entirely, never rendered as zero. On its own poll cadence,
independent of every other poll.

| Metric | Type | Labels | Description |
|---|---|---|---|
| `ftd_certificate_expiry_timestamp_seconds` | gauge | device_uid, device_name, cert_name, cert_type | Unix timestamp when this certificate component (cert_type: ca|identity) expires. Omitted entirely for a component reported NOT_APPLICABLE upstream (e.g. a self-signed certificate has no CA component) — genuinely absent, not zero. |
| `ftd_certificate_status_info` | gauge | device_uid, device_name, cert_name, cert_type, status | Always 1. Informational; status carries the raw upstream deployment/availability state (lowercased), or unknown. Same omission rule as ftd_certificate_expiry_timestamp_seconds for a NOT_APPLICABLE component. |

## Exporter self-metrics (`ftd_exporter_*`)

| Metric | Type | Labels | Description |
|---|---|---|---|
| `ftd_exporter_build_info` | gauge | version, commit, node_version, backend | Always 1. Labels identify the running build. |
| `ftd_exporter_cache_age_seconds` | gauge | (none) | Age of the currently served snapshot, computed at scrape time. |
| `ftd_exporter_certificate_errors_total` | counter | (none) | Device-certificates poll failures (both backends). |
| `ftd_exporter_devices` | gauge | (none) | Devices in the current snapshot. |
| `ftd_exporter_devices_discovered` | gauge | (none) | FMC backend: devices found by discovery. |
| `ftd_exporter_discovery_errors_total` | counter | (none) | FMC backend: discovery failures. |
| `ftd_exporter_fmc_token_expiry_timestamp_seconds` | gauge | (none) | FMC backend: current token expiry, unix seconds. |
| `ftd_exporter_fmc_token_reauths_total` | counter | (none) | FMC backend: full re-authentications. |
| `ftd_exporter_fmc_token_refreshes_total` | counter | (none) | FMC backend: token refreshes. |
| `ftd_exporter_last_successful_poll_timestamp_seconds` | gauge | (none) | Unix timestamp of the last successful poll. |
| `ftd_exporter_license_errors_total` | counter | (none) | License-status poll failures (both backends). |
| `ftd_exporter_parse_errors_total` | counter | group | Parse failures, by metric group. |
| `ftd_exporter_poll_duration_seconds` | histogram | (none) | Poll cycle latency. |
| `ftd_exporter_poll_errors_total` | counter | reason | Poll cycle failures, by reason. |
| `ftd_exporter_poll_total` | counter | (none) | Total poll cycles attempted. |
| `ftd_exporter_rate_limit_deferrals_total` | counter | (none) | Times a request was delayed by the internal rate limiter. |
| `ftd_exporter_scc_inventory_errors_total` | counter | (none) | SCC backend: device-inventory poll failures. |
| `ftd_exporter_series` | gauge | (none) | Series currently rendered on /metrics. |
| `ftd_exporter_tls_verification_disabled` | gauge | (none) | 1 if TLS verification is disabled for the upstream backend. |
| `ftd_exporter_unknown_enum_total` | counter | metric, value | Unrecognized upstream enum values encountered while rendering, by metric and value. |
| `ftd_exporter_up` | gauge | (none) | 1 if the most recent poll cycle succeeded. |
| `ftd_exporter_upstream_request_duration_seconds` | histogram | endpoint | Upstream HTTP request latency, by templated endpoint. |
| `ftd_exporter_upstream_requests_total` | counter | endpoint, status_code | Upstream HTTP requests, by templated endpoint and status code. |
