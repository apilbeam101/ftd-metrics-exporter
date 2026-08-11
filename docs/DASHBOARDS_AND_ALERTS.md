# Grafana dashboard and Prometheus alert rules

Two artifacts ship with the exporter:

- [dashboards/ftd-health.json](../dashboards/ftd-health.json) — a Grafana dashboard (uid `ftd-health`), 35 panels across 8 rows.
- [alerts/ftd-health.yaml](../alerts/ftd-health.yaml) — 13 Prometheus alerting rules.

Both are starting points. The thresholds in particular (85% CPU, 90% memory, 90% disk) are defaults, not universal truths — a device that legitimately runs hot under normal load needs its own threshold rather than a permanently-firing alert.

## Prerequisite: the scrape config

Everything below assumes Prometheus is scraping the exporter under the job name `ftd-metrics`:

```yaml
scrape_configs:
  - job_name: ftd-metrics
    static_configs:
      - targets: ["exporter-host:10049"]
```

The job name is not cosmetic. `FtdExporterAbsent` — the only rule that can fire when the exporter process is dead — matches `up{job="ftd-metrics"}` explicitly, because a bare `up == 0` would fire for every unrelated down target in your cluster. If you use a different job name, change it in that one rule. Every other rule is job-agnostic.

Scrape interval is your choice and is fully decoupled from how often the exporter polls upstream (`POLL_INTERVAL_SECONDS`); `/metrics` always serves from cache. A scrape interval well under the poll interval just returns the same cached values repeatedly, which is harmless.

## Importing the dashboard

The dashboard declares a `DS_PROMETHEUS` datasource variable rather than hardcoding a datasource uid, so it works against any Prometheus datasource without editing.

**Via the UI:** Dashboards → New → Import → Upload JSON file → select `dashboards/ftd-health.json` → pick your Prometheus datasource when prompted.

**Via the HTTP API:**

```bash
curl -sS -X POST "$GRAFANA_URL/api/dashboards/import" \
  -H "Authorization: Bearer $GRAFANA_TOKEN" \
  -H 'Content-Type: application/json' \
  --data "$(jq '{dashboard: ., overwrite: true, inputs: [{name: "DS_PROMETHEUS", type: "datasource", pluginId: "prometheus", value: "<your-datasource-uid>"}]}' dashboards/ftd-health.json)"
```

If you don't have `jq` (it is not a prerequisite of this project — Node is), build the same payload with Node:

```bash
payload=$(node -e 'const d=JSON.parse(require("node:fs").readFileSync("dashboards/ftd-health.json","utf8"));
  process.stdout.write(JSON.stringify({dashboard:d,overwrite:true,inputs:[{name:"DS_PROMETHEUS",type:"datasource",pluginId:"prometheus",value:process.argv[1]}]}))' "<your-datasource-uid>")
curl -sS -X POST "$GRAFANA_URL/api/dashboards/import" \
  -H "Authorization: Bearer $GRAFANA_TOKEN" \
  -H 'Content-Type: application/json' --data "$payload"
```

**Via file provisioning** (`/etc/grafana/provisioning/dashboards/ftd.yaml`):

```yaml
apiVersion: 1
providers:
  - name: ftd
    type: file
    options:
      path: /var/lib/grafana/dashboards/ftd
```

Copy `ftd-health.json` into that directory. Provisioned dashboards are read-only in the UI by design — see [Editing the dashboard](#editing-the-dashboard) for the round-trip if you want to change it.

**In Kubernetes**, the Grafana sidecar picks up any ConfigMap with the label the sidecar watches (`grafana_dashboard: "1"` in the community chart's default):

```bash
kubectl create configmap ftd-health-dashboard \
  --from-file=ftd-health.json=dashboards/ftd-health.json \
  --dry-run=client -o yaml \
  | kubectl label -f - --local --dry-run=client -o yaml grafana_dashboard=1 \
  | kubectl apply -f -
```

Check your own chart's `sidecar.dashboards.label` value before relying on that label name.

## Loading the alert rules

These are Prometheus rules, not Grafana-managed alerts — they evaluate in Prometheus and fire through Alertmanager.

```yaml
# prometheus.yml
rule_files:
  - /etc/prometheus/rules/ftd-health.yaml
```

Validate before loading, and after any local edit:

```bash
promtool check rules alerts/ftd-health.yaml
promtool test rules alerts/ftd-health.test.yaml
```

The second command is the one that matters. `check rules` only proves the file parses — it passes just as happily for a rule that can never fire (a `> 85` threshold against a 0–1 ratio, say). [alerts/ftd-health.test.yaml](../alerts/ftd-health.test.yaml) tests every rule in **both** directions: fires against a series crafted to violate it, and stays silent otherwise. Both commands run in CI (`.github/workflows/ci.yml`, job `alerts`).

**With the Prometheus Operator**, wrap the same rules in a `PrometheusRule`:

```bash
kubectl create configmap ftd-rules --from-file=alerts/ftd-health.yaml  # or:
# translate groups: into a PrometheusRule spec.groups: — the rule bodies are identical
```

The rule bodies transfer verbatim; only the enclosing `groups:` key moves under `spec:`.

### The rules

| Alert | Severity | Fires when |
|---|---|---|
| `FtdExporterDown` | critical | `ftd_exporter_up` is 0 for 5m — the exporter is running, but its poll cycles fail |
| `FtdExporterAbsent` | critical | Prometheus can't scrape the target at all for 5m — the process is gone |
| `FtdExporterStale` | warning | No successful poll for over 5m, despite having succeeded at least once |
| `FtdExporterInsecureTls` | warning | `FMC_TLS_INSECURE_SKIP_VERIFY=true` is in effect (no `for` — it can't clear on its own) |
| `FtdDeviceMetricsStale` | warning | One device's health window is over 15m old while others are current |
| `FtdHighCpu` | warning | `component="system"` CPU above 85% for 15m |
| `FtdHighMemory` | warning | `component="system"` memory above 90% for 15m |
| `FtdDiskNearFull` | critical | Disk above 90% for 5m |
| `FtdInterfaceDown` | warning | A **named** interface is operationally down for 5m |
| `FtdInterfaceErrors` | warning | A named interface reports input errors for 15m |
| `FtdHaNotNormal` | critical | An HA node is in any state other than NORMAL for 5m |
| `FtdS2sTunnelDown` | warning | A site-to-site tunnel is down for 10m |
| `FtdChassisPsuFailure` | critical | A chassis PSU reports input or output down for 5m |

`FtdExporterDown` and `FtdExporterAbsent` are **not** redundant, and neither should be deleted as duplicative. They cover disjoint failures: the first means "running, but upstream polls are failing"; the second means "not answering at all." Only the second can fire once the process dies, because every `ftd_*` series ceases to exist at that moment and an instant-vector comparison against a nonexistent series matches nothing. That distinction was found by killing a real exporter against a real Prometheus and watching the entire alert set go silent.

The last four rules produce no results at all on a fleet with no HA pair, no VPN, and no chassis hardware. That is correct, not misconfiguration — those metric groups are genuinely absent rather than zero on devices without the capability ([DESIGN.md §4.8](DESIGN.md)). An always-silent rule there means "not applicable to this fleet."

### Why the interface rules only cover named interfaces

The exporter exports every interface, including unused ones, and an unused interface is legitimately down — alerting on all of them is constant noise. But "has a configured name" is not expressible as `interface_name != ""`, because the exporter falls back to the hardware id when no name is set ([DESIGN.md §4.3](DESIGN.md)), so `interface_name` is never empty. The rules use a PromQL construct instead:

```promql
ftd_interface_operational_up == 0
  unless on(job, instance, device_uid, interface)
    label_replace(
      max by (job, instance, device_uid, interface_name) (ftd_interface_operational_up),
      "interface", "$1", "interface_name", "(.*)"
    )
```

`label_replace` copies `interface_name` over `interface`. For an unnamed interface the rewritten series has an identical `(device_uid, interface)` pair to the original, so `unless` removes it; for a named interface the pair differs and the original survives. To alert on unnamed interfaces too, drop the `unless` clause. The full rationale and the rejected alternatives are recorded in a comment above the rule.

Two pieces of that expression are load-bearing and should not be simplified away — both were added after a review found the naive form silently broken, and both have regression tests in [alerts/ftd-health.test.yaml](../alerts/ftd-health.test.yaml):

- **`max by (...)` on the right-hand side.** Because `label_replace` overwrites `interface`, two interfaces on one device that share an `interface_name` collapse to an identical labelset, and PromQL then aborts the *whole rule evaluation* with `vector cannot contain metrics with the same labelset` — silencing the rule for every device in the fleet, not just the colliding pair. The colliding interfaces don't even have to be down for that to happen. A named interface whose configured name happens to equal a sibling's hardware id is enough to trigger it.
- **`job, instance` in the `unless on(...)` list.** Without them, two exporters scraping the same device (an HA/rollout overlap, or an FMC and an SCC exporter covering one fleet) match across instances, and the exporter reporting the hardware-id fallback suppresses the other's genuine alert.

**Known limitation:** an interface whose legitimately configured name is identical to its own hardware id (e.g. an interface actually named `Ethernet1/1`) is indistinguishable from the unnamed fallback case and will never alert. This is inherent to the construct — PromQL cannot compare two labels on the same series — and is the accepted cost of the noise-avoidance default. Rename such an interface, or drop the `unless` clause to alert on everything.

## Reading the dashboard

Panels are ordered deliberately: **exporter health comes first**, before any device data. A dashboard that looks green while the exporter is dead is the worst possible outcome ([DESIGN.md §10.2](DESIGN.md)), so the top-left stat is the exporter's own status and the conditional-group panels below carry explicit "no data here is expected" text rather than an ambiguous blank.

Two panels are easy to misread:

- **Exporter up** is not the conventional Prometheus `up` semantic. It means "the most recent poll *cycle* succeeded." A healthy exporter serving a 10-minute-old cache still reads 1, and one reading 0 may still be serving perfectly usable cached data. Read it alongside **Cache age** and **Last successful poll**, never on its own. When it reads `NOT SCRAPED`, the series is absent entirely — the exporter is not being scraped, which is what `FtdExporterAbsent` covers.
- **Interface throughput** units are unresolved upstream ([DESIGN.md §14.4](DESIGN.md)) — the panel says so in its description. Treat the shape of the line as meaningful and the absolute magnitude as provisional until validated against a device you control.

Template variables `$job`, `$instance`, `$device`, and `$interface` all default to "All". `$interface` is scoped to whatever `$device` selects, so narrowing the device narrows the interface list too.

## Editing the dashboard

`dashboards/ftd-health.json` is **generated, not hand-edited**:

```bash
node --experimental-strip-types scripts/generate-dashboard.ts
```

[test/unit/dashboard-and-alerts.test.ts](../test/unit/dashboard-and-alerts.test.ts) asserts the committed JSON is byte-identical to the generator's output, so an edit to the JSON alone fails CI. This is the same anti-drift approach [docs/METRICS.md](METRICS.md) uses, and it exists because an 8000-line hand-maintained dashboard JSON is unreviewable in a diff and silently drifts from the metric names it queries. The same test cross-checks every `ftd_*` name and label in both the dashboard and the alerts against the exporter's actual metric declarations, so a rename in `src/metrics/` cannot leave a panel querying a series that no longer exists.

To change a panel, edit [scripts/generate-dashboard.ts](../scripts/generate-dashboard.ts) and regenerate.

### Round-tripping a change made in the Grafana UI

Prototyping in the UI is often faster than editing the generator. To bring a change back:

1. Make the change in Grafana.
2. Export it: dashboard settings → JSON Model, or Share → Export → **"Export for sharing externally"** off (the sharing variant rewrites datasource references into `__inputs`, which this dashboard deliberately does not use).
3. Diff the exported JSON against the committed file to isolate what actually changed. Grafana adds and reorders a lot of defaults on export, so both sides need their keys sorted first or the diff is unreadable noise:
   ```bash
   norm() { node -e 'const s=o=>Array.isArray(o)?o.map(s):o&&typeof o==="object"?Object.fromEntries(Object.keys(o).sort().map(k=>[k,s(o[k])])):o;
     process.stdout.write(JSON.stringify(s(JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8"))),null,2))' "$1"; }
   norm dashboards/ftd-health.json > /tmp/before.json
   norm ~/Downloads/ftd-health-1712345678.json > /tmp/after.json
   diff -u /tmp/before.json /tmp/after.json
   ```
   (`jq -S .` does the same job if you have it; Node is used here because it is already a prerequisite and `jq` is not.) Expect residual noise unrelated to your change.
4. Port only the meaningful part into `scripts/generate-dashboard.ts`.
5. Regenerate, then run the test:
   ```bash
   node --experimental-strip-types scripts/generate-dashboard.ts
   node --experimental-strip-types --test "test/unit/dashboard-and-alerts.test.ts"
   ```

Do not commit the Grafana export directly. Its `id`, `version`, and `iteration` fields are instance-specific, and it will not match the generator.
