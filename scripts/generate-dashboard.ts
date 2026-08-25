/**
 * Generates dashboards/ftd-health.json — the Grafana dashboard specified in
 * DESIGN.md §10.2 (8 rows) with the §10.1 import requirements.
 *
 * WHY A GENERATOR INSTEAD OF A COMMITTED UI EXPORT: IMPLEMENTATION_PLAN.md
 * Stage 15 names "dashboard JSON drift" as a risk — a dashboard hand-edited in
 * the Grafana UI, re-exported, and committed carries churn in panel ids,
 * `version`, `iteration` timestamps, and datasource UIDs, which makes a real
 * change indistinguishable from noise in review. Generating the JSON from this
 * file makes the panel set reviewable as code, keeps panel ids stable and
 * deterministic (assigned by position, not by whatever the UI last used), and
 * lets test/unit/dashboard-and-alerts.test.ts cross-check every `ftd_*` metric
 * name referenced in a query against the exporter's real metric declarations —
 * so a rename in src/metrics/ cannot silently leave a panel querying a series
 * that no longer exists.
 *
 * Not part of the shipped package. Regenerate after editing:
 *   node --experimental-strip-types scripts/generate-dashboard.ts
 *
 * The edit-then-regenerate procedure (including how to round-trip a change
 * made in the Grafana UI back into this file) is in
 * docs/DASHBOARDS_AND_ALERTS.md.
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Datasource reference used by every panel and every query variable. */
// biome-ignore lint/suspicious/noTemplateCurlyInString: Grafana's own variable-interpolation syntax, not a JS template placeholder.
const DS = { type: 'prometheus', uid: '${DS_PROMETHEUS}' } as const;

const GRID_WIDTH = 24;

interface Target {
  refId: string;
  expr: string;
  legendFormat?: string;
  instant?: boolean;
  range?: boolean;
}

interface PanelSpec {
  title: string;
  type: string;
  description?: string;
  width: number;
  height: number;
  targets?: Target[];
  /** fieldConfig.defaults overrides, merged over the per-type baseline. */
  defaults?: Record<string, unknown>;
  /** Panel-type-specific `options` block. */
  options?: Record<string, unknown>;
  /** fieldConfig.overrides, verbatim. */
  overrides?: unknown[];
  transformations?: unknown[];
}

interface RowSpec {
  title: string;
  description?: string;
  panels: PanelSpec[];
}

function targets(...specs: Array<[string, string] | [string, string, Partial<Target>]>): Target[] {
  return specs.map(([expr, legendFormat, extra], index) => ({
    refId: String.fromCharCode(65 + index),
    expr,
    legendFormat,
    ...extra,
  }));
}

/**
 * The named-interface filter, in PromQL, for a given interface-metric
 * selector. See the long comment on FtdInterfaceDown in alerts/ftd-health.yaml
 * for the full derivation and the rejected alternatives: `label_replace` copies
 * `interface_name` over `interface`, so an *unnamed* interface (whose
 * `interface_name` fell back to its hardware id per DESIGN.md §4.3) produces an
 * identical (device_uid, device_name, interface) pair and is removed by
 * `unless`, while a named one survives. This expresses a label-to-label
 * comparison PromQL cannot otherwise state.
 *
 * The `max by (...)` on the RHS and the `job, instance, device_name` in the
 * `unless on(...)` list are all load-bearing — see the long comment on
 * FtdInterfaceDown for why omitting any of them silently breaks the filter (a
 * fleet-wide duplicate-labelset abort, cross-exporter suppression, and
 * cross-HA-peer suppression once two devices share one `device_uid`,
 * respectively — the last one confirmed live, DESIGN.md §14.14).
 *
 * Kept identical in shape to the alert rules deliberately: a dashboard panel
 * that counts down interfaces differently from the alert that pages on them is
 * a support call waiting to happen.
 */
function namedInterfacesOnly(selector: string, condition: string): string {
  return (
    `${selector} ${condition}\n` +
    `  unless on(job, instance, device_uid, device_name, interface)\n` +
    `    label_replace(\n` +
    `      max by (job, instance, device_uid, device_name, interface_name) (${selector}),\n` +
    `      "interface", "$1", "interface_name", "(.*)"\n` +
    `    )`
  );
}

/** Standard device/job scoping applied to every device-level query. */
const SCOPE = 'job=~"$job",instance=~"$instance",device_name=~"$device"';
const SCOPE_IF = `${SCOPE},interface=~"$interface"`;
/** Exporter self-metrics carry no device labels. */
const SCOPE_SELF = 'job=~"$job",instance=~"$instance"';

/**
 * Text Grafana shows in place of "No data" (`fieldConfig.defaults.noValue`).
 * This is the actual mechanism behind DESIGN.md §10.1's graceful-degradation
 * requirement and Stage 15 testing step 3: a panel description explains the
 * emptiness only to someone who thinks to hover it, whereas `noValue` replaces
 * the bare "No data" text in the panel body itself. Without it, an all-appliance
 * fleet sees a wall of "No data" across rows 5-7 and reasonably concludes the
 * exporter is broken.
 */
const NO_DATA = {
  ha: 'No HA data — expected unless these devices are in an HA pair (not a fault).',
  vpn: 'No VPN data — expected unless RA VPN or site-to-site VPN is configured (not a fault).',
  chassis:
    'No chassis data — expected on appliances such as the FTD 1010 (not a fault). Chassis-based platforms only.',
} as const;

const EXPERIMENTAL =
  '\n\n**Experimental in v1.** The upstream field mapping behind this panel is validated against synthetic data only (DESIGN.md §13/§14.1) — treat unexpected values as a possible mapping bug and please report them with a `--dump-raw` capture.';

const UNIT_CAVEAT =
  '\n\n**Unit caveat (DESIGN.md §14.4, unresolved):** it is not yet confirmed whether the upstream `*_bytes_avg` fields are a rate (bytes/second) or a total over the averaging window. The axis is therefore labelled in bytes without a per-second denominator. Do not read this axis as throughput until §14.4 is resolved — compare two window sizes if you need to know which it is.';

// ---------------------------------------------------------------------------
// Row 1 — Fleet overview. Exporter health FIRST and PROMINENTLY: DESIGN.md
// §10.2 calls a dashboard that looks green while the exporter is dead "the
// worst possible outcome and the most common exporter-dashboard failure".
// ---------------------------------------------------------------------------
const row1: RowSpec = {
  title: 'Fleet overview — exporter health first',
  panels: [
    {
      title: 'Exporter up',
      type: 'stat',
      width: 3,
      height: 4,
      description:
        'Whether the most recent poll *cycle* succeeded. Note this is not the conventional Prometheus `up` semantic (DESIGN.md §11): a healthy exporter serving a 10-minute-old cache still reads 1, and an exporter reading 0 may still be serving perfectly usable cached data. Read it alongside "Cache age" and "Last successful poll" — never on its own.',
      targets: targets([`min(ftd_exporter_up{${SCOPE_SELF}})`, 'up', { instant: true }]),
      defaults: {
        mappings: [
          { type: 'value', options: { '0': { text: 'DOWN', color: 'red', index: 0 } } },
          { type: 'value', options: { '1': { text: 'UP', color: 'green', index: 1 } } },
        ],
        thresholds: {
          mode: 'absolute',
          steps: [
            { color: 'red', value: null },
            { color: 'green', value: 1 },
          ],
        },
        noValue: 'NOT SCRAPED',
      },
      options: {
        colorMode: 'background',
        graphMode: 'none',
        textMode: 'value',
        reduceOptions: { calcs: ['lastNotNull'], fields: '', values: false },
      },
    },
    {
      title: 'Cache age',
      type: 'stat',
      width: 3,
      height: 4,
      description:
        'How old the snapshot currently being served is. This is the metric that answers "how stale is what I am looking at" — `ftd_exporter_up` does not. Amber past 2x a 60s poll interval, red past 5x; adjust to your own POLL_INTERVAL_SECONDS.',
      targets: targets([
        `max(ftd_exporter_cache_age_seconds{${SCOPE_SELF}})`,
        'cache age',
        { instant: true },
      ]),
      defaults: {
        unit: 's',
        thresholds: {
          mode: 'absolute',
          steps: [
            { color: 'green', value: null },
            { color: 'yellow', value: 120 },
            { color: 'red', value: 300 },
          ],
        },
      },
      options: {
        colorMode: 'background',
        graphMode: 'area',
        reduceOptions: { calcs: ['lastNotNull'], fields: '', values: false },
      },
    },
    {
      title: 'Last successful poll',
      type: 'stat',
      width: 3,
      height: 4,
      description:
        'Time since the last poll cycle that actually succeeded. Reads "never" until the first success — the underlying gauge is 0 on a freshly started exporter, which is also why the FtdExporterStale alert carries an explicit `> 0` guard.',
      targets: targets([
        `time() - max(ftd_exporter_last_successful_poll_timestamp_seconds{${SCOPE_SELF}} > 0)`,
        'since last success',
        { instant: true },
      ]),
      defaults: {
        unit: 's',
        noValue: 'never (no successful poll yet)',
        thresholds: {
          mode: 'absolute',
          steps: [
            { color: 'green', value: null },
            { color: 'yellow', value: 300 },
            { color: 'red', value: 900 },
          ],
        },
      },
      options: {
        colorMode: 'background',
        graphMode: 'none',
        reduceOptions: { calcs: ['lastNotNull'], fields: '', values: false },
      },
    },
    {
      title: 'Poll error rate',
      type: 'stat',
      width: 3,
      height: 4,
      description:
        'Poll cycle failures per second over 5m, all reasons combined. Broken down by reason in row 8.',
      targets: targets([
        `sum(rate(ftd_exporter_poll_errors_total{${SCOPE_SELF}}[5m]))`,
        'errors/s',
        { instant: true },
      ]),
      defaults: {
        unit: 'reqps',
        decimals: 4,
        thresholds: {
          mode: 'absolute',
          steps: [
            { color: 'green', value: null },
            { color: 'yellow', value: 0.0001 },
          ],
        },
      },
      options: {
        colorMode: 'value',
        graphMode: 'area',
        reduceOptions: { calcs: ['lastNotNull'], fields: '', values: false },
      },
    },
    {
      title: 'Devices reporting',
      type: 'stat',
      width: 4,
      height: 4,
      description:
        'Devices in the current snapshot (`ftd_exporter_devices`). On the FMC backend, compare against "Devices discovered" in row 8 — a gap between them is the per-device-failure / pagination signal.',
      targets: targets([`sum(ftd_exporter_devices{${SCOPE_SELF}})`, 'devices', { instant: true }]),
      defaults: { unit: 'short' },
      options: {
        colorMode: 'none',
        graphMode: 'none',
        reduceOptions: { calcs: ['lastNotNull'], fields: '', values: false },
      },
    },
    {
      title: 'Devices with an unhealthy signal',
      type: 'stat',
      width: 4,
      height: 4,
      description:
        "Distinct devices currently over any resource threshold (system CPU > 85%, system memory > 90%, or disk > 90%) — the same thresholds the alert rules use. Counted via `count by (device_uid, device_name)` so a device breaching two thresholds at once counts once, not twice. `device_name` is part of the grouping key, not just `device_uid`: on SCC, an HA pair's two nodes share one `device_uid` (confirmed live), so grouping by `device_uid` alone would collapse two genuinely different unhealthy devices into one.",
      targets: targets([
        `count(count by (device_uid, device_name) (\n` +
          `  (ftd_cpu_usage_ratio{${SCOPE},component="system"} > 0.85)\n` +
          `    or (ftd_memory_usage_ratio{${SCOPE},component="system"} > 0.90)\n` +
          `    or (ftd_disk_usage_ratio{${SCOPE}} > 0.90)\n` +
          `))`,
        'unhealthy',
        { instant: true },
      ]),
      defaults: {
        unit: 'short',
        noValue: '0',
        thresholds: {
          mode: 'absolute',
          steps: [
            { color: 'green', value: null },
            { color: 'red', value: 1 },
          ],
        },
      },
      options: {
        colorMode: 'background',
        graphMode: 'none',
        reduceOptions: { calcs: ['lastNotNull'], fields: '', values: false },
      },
    },
    {
      title: 'Named interfaces down',
      type: 'stat',
      width: 2,
      height: 4,
      description:
        'Fleet-wide count of operationally-down interfaces that have a real configured name. Unnamed/unused interfaces are excluded — they are legitimately down and would otherwise dominate this number (DESIGN.md §4.2 exports every interface by design). Uses the same PromQL filter as the FtdInterfaceDown alert, so this panel and that alert can never disagree.',
      targets: targets([
        `count(\n${namedInterfacesOnly(`ftd_interface_operational_up{${SCOPE_IF}}`, '== 0')}\n)`,
        'down',
        { instant: true },
      ]),
      defaults: {
        unit: 'short',
        noValue: '0',
        thresholds: {
          mode: 'absolute',
          steps: [
            { color: 'green', value: null },
            { color: 'red', value: 1 },
          ],
        },
      },
      options: {
        colorMode: 'background',
        graphMode: 'none',
        reduceOptions: { calcs: ['lastNotNull'], fields: '', values: false },
      },
    },
    {
      title: 'S2S tunnels down',
      type: 'stat',
      width: 2,
      height: 4,
      description: `Site-to-site tunnels currently reporting state "down" — the number an operator actually wants at 3am. Empty rather than 0 when no VPN is configured at all.${EXPERIMENTAL}`,
      targets: targets([
        `count(ftd_s2s_tunnel_state{${SCOPE},state="down"} == 1)`,
        'tunnels down',
        { instant: true },
      ]),
      defaults: {
        unit: 'short',
        noValue: NO_DATA.vpn,
        thresholds: {
          mode: 'absolute',
          steps: [
            { color: 'green', value: null },
            { color: 'red', value: 1 },
          ],
        },
      },
      options: {
        colorMode: 'background',
        graphMode: 'none',
        reduceOptions: { calcs: ['lastNotNull'], fields: '', values: false },
      },
    },
    {
      title: 'Devices in SCC inventory',
      type: 'stat',
      width: 3,
      height: 4,
      description:
        'SCC only (DESIGN.md §14.6): count of `ftd_device_info`, from SCC device inventory rather than health/metrics — the denominator for "Devices unreachable" next to it, and for comparing against "Devices reporting" (which comes from health/metrics and is silently missing anything UNREACHABLE). Empty on the FMC backend, which has no equivalent inventory endpoint wired up.',
      targets: targets([`count(ftd_device_info{${SCOPE}})`, 'in inventory', { instant: true }]),
      defaults: { unit: 'short' },
      options: {
        colorMode: 'none',
        graphMode: 'none',
        reduceOptions: { calcs: ['lastNotNull'], fields: '', values: false },
      },
    },
    {
      title: 'Devices unreachable',
      type: 'stat',
      width: 3,
      height: 4,
      description:
        'SCC only (DESIGN.md §14.6): devices SCC device inventory reports UNREACHABLE. This is the ONLY signal for a device that has gone fully absent from health/metrics — confirmed live (2026-08-11), an unreachable device produces no series there at all, so it never shows up anywhere else on this dashboard. See the FtdDeviceUnreachable alert.',
      targets: targets([
        `count(ftd_device_connectivity_up{${SCOPE}} == 0)`,
        'unreachable',
        { instant: true },
      ]),
      defaults: {
        unit: 'short',
        noValue: '0',
        thresholds: {
          mode: 'absolute',
          steps: [
            { color: 'green', value: null },
            { color: 'red', value: 1 },
          ],
        },
      },
      options: {
        colorMode: 'background',
        graphMode: 'none',
        reduceOptions: { calcs: ['lastNotNull'], fields: '', values: false },
      },
    },
    {
      title: 'Per-device summary',
      type: 'table',
      width: 24,
      height: 10,
      description:
        'The visual anchor of the dashboard (DESIGN.md §10.2): one row per device with system CPU, memory, disk, HA status/role, and named-interfaces-down count, cell-coloured by the same thresholds as the alerts. HA columns are empty for non-HA devices, which is expected rather than a fault.',
      targets: [
        {
          refId: 'A',
          expr: `ftd_cpu_usage_ratio{${SCOPE},component="system"}`,
          legendFormat: 'cpu',
          instant: true,
        },
        {
          refId: 'B',
          expr: `ftd_memory_usage_ratio{${SCOPE},component="system"}`,
          legendFormat: 'memory',
          instant: true,
        },
        { refId: 'C', expr: `ftd_disk_usage_ratio{${SCOPE}}`, legendFormat: 'disk', instant: true },
        {
          refId: 'D',
          // The state set collapses to a single status string per device via
          // the `status` label of whichever series is 1.
          expr: `ftd_ha_node_status{${SCOPE}} == 1`,
          legendFormat: 'ha_status',
          instant: true,
        },
        {
          refId: 'E',
          expr: `ftd_ha_node_info{${SCOPE}} == 1`,
          legendFormat: 'ha_role',
          instant: true,
        },
        {
          refId: 'F',
          expr:
            `count by (device_uid, device_name) (\n` +
            `${namedInterfacesOnly(`ftd_interface_operational_up{${SCOPE_IF}}`, '== 0')}\n)`,
          legendFormat: 'ifaces_down',
          instant: true,
        },
      ],
      transformations: [
        // `joinByField` (mode: outer) assumes each target resolves to one
        // frame per query -- true for a single-series query, false here:
        // Prometheus's datasource returns one frame PER SERIES for an
        // instant query, so a 5-device target already arrives as 5 frames.
        // `joinByField` collapsed all ~19 frames from A-F down to a single
        // row (verified live: the rendered table showed one row with only
        // target A's first series). `merge` is built for exactly this shape
        // -- combining many single/few-row frames into one table aligned on
        // shared field values -- and is what "Current HA role" below
        // already uses successfully for the same instant-query pattern.
        { id: 'merge', options: {} },
        {
          id: 'organize',
          options: {
            excludeByName: {
              Time: true,
              device_uid: true,
              component: true,
              node_type: true,
            },
            renameByName: {
              device_name: 'Device',
              // `merge`'s output field names come from each target's
              // legendFormat directly (no refId suffixing, unlike
              // joinByField) -- these must match targets A/B/C/D/F's
              // legendFormat strings above verbatim.
              cpu: 'CPU (system)',
              memory: 'Memory (system)',
              disk: 'Disk',
              status: 'HA status',
              ha_role: '',
              ifaces_down: 'Named ifaces down',
            },
          },
        },
      ],
      defaults: {
        custom: { align: 'auto', cellOptions: { type: 'auto' }, filterable: true },
        noValue: '—',
      },
      overrides: [
        {
          matcher: { id: 'byRegexp', options: '(CPU|Memory|Disk).*' },
          properties: [
            { id: 'unit', value: 'percentunit' },
            { id: 'decimals', value: 1 },
            { id: 'custom.cellOptions', value: { type: 'color-text' } },
            {
              id: 'thresholds',
              value: {
                mode: 'absolute',
                steps: [
                  { color: 'green', value: null },
                  { color: 'yellow', value: 0.7 },
                  { color: 'red', value: 0.85 },
                ],
              },
            },
          ],
        },
        {
          matcher: { id: 'byName', options: 'Named ifaces down' },
          properties: [
            { id: 'custom.cellOptions', value: { type: 'color-background' } },
            {
              id: 'thresholds',
              value: {
                mode: 'absolute',
                steps: [
                  { color: 'green', value: null },
                  { color: 'red', value: 1 },
                ],
              },
            },
          ],
        },
      ],
      options: { showHeader: true, footer: { show: false, reducer: ['sum'], fields: '' } },
    },
  ],
};

// ---------------------------------------------------------------------------
// Row 2 — CPU and memory. One series per component: splitting Lina and Snort
// IS the point (DESIGN.md §10.2) — a Snort spike and a Lina spike mean
// different things and demand different responses.
// ---------------------------------------------------------------------------
const row2: RowSpec = {
  title: 'CPU and memory',
  panels: [
    {
      title: 'CPU by component',
      type: 'timeseries',
      width: 12,
      height: 8,
      description:
        'One series per component per device. Lina (the data plane) and Snort (inspection) are deliberately not summed: sustained high Snort is often normal under inspection load, whereas sustained high Lina points at the data path. `system` is what the alert rules threshold on.',
      targets: targets([
        `ftd_cpu_usage_ratio{${SCOPE}}`,
        '{{device_name}} — {{component}}',
        { range: true },
      ]),
      defaults: {
        unit: 'percentunit',
        min: 0,
        max: 1,
        custom: { fillOpacity: 5, lineWidth: 2, showPoints: 'never' },
      },
      options: {
        legend: { displayMode: 'table', placement: 'right', calcs: ['lastNotNull', 'max'] },
        tooltip: { mode: 'multi', sort: 'desc' },
      },
    },
    {
      title: 'Memory by component',
      type: 'timeseries',
      width: 12,
      height: 8,
      description: 'Same shape as CPU: one series per component per device.',
      targets: targets([
        `ftd_memory_usage_ratio{${SCOPE}}`,
        '{{device_name}} — {{component}}',
        { range: true },
      ]),
      defaults: {
        unit: 'percentunit',
        min: 0,
        max: 1,
        custom: { fillOpacity: 5, lineWidth: 2, showPoints: 'never' },
      },
      options: {
        legend: { displayMode: 'table', placement: 'right', calcs: ['lastNotNull', 'max'] },
        tooltip: { mode: 'multi', sort: 'desc' },
      },
    },
    {
      title: 'Current system CPU',
      type: 'gauge',
      width: 6,
      height: 6,
      description:
        'Thresholds are 70/85% — documented DEFAULTS, not universal truths (DESIGN.md §10.3). A device that legitimately runs hot needs its own numbers.',
      targets: targets([
        `ftd_cpu_usage_ratio{${SCOPE},component="system"}`,
        '{{device_name}}',
        { instant: true },
      ]),
      defaults: {
        unit: 'percentunit',
        min: 0,
        max: 1,
        thresholds: {
          mode: 'absolute',
          steps: [
            { color: 'green', value: null },
            { color: 'yellow', value: 0.7 },
            { color: 'red', value: 0.85 },
          ],
        },
      },
      options: {
        showThresholdLabels: false,
        showThresholdMarkers: true,
        reduceOptions: { calcs: ['lastNotNull'], fields: '', values: false },
      },
    },
    {
      title: 'Current system memory',
      type: 'gauge',
      width: 6,
      height: 6,
      description: 'Thresholds 70/85% as defaults; the memory alert pages at 90%.',
      targets: targets([
        `ftd_memory_usage_ratio{${SCOPE},component="system"}`,
        '{{device_name}}',
        { instant: true },
      ]),
      defaults: {
        unit: 'percentunit',
        min: 0,
        max: 1,
        thresholds: {
          mode: 'absolute',
          steps: [
            { color: 'green', value: null },
            { color: 'yellow', value: 0.7 },
            { color: 'red', value: 0.85 },
          ],
        },
      },
      options: {
        showThresholdLabels: false,
        showThresholdMarkers: true,
        reduceOptions: { calcs: ['lastNotNull'], fields: '', values: false },
      },
    },
    {
      title: 'Top 10 devices by system CPU',
      type: 'bargauge',
      width: 12,
      height: 6,
      description: 'For fleets too large to eyeball in the timeseries above.',
      targets: targets([
        `topk(10, ftd_cpu_usage_ratio{${SCOPE},component="system"})`,
        '{{device_name}}',
        { instant: true },
      ]),
      defaults: {
        unit: 'percentunit',
        min: 0,
        max: 1,
        thresholds: {
          mode: 'absolute',
          steps: [
            { color: 'green', value: null },
            { color: 'yellow', value: 0.7 },
            { color: 'red', value: 0.85 },
          ],
        },
      },
      options: {
        displayMode: 'gradient',
        orientation: 'horizontal',
        reduceOptions: { calcs: ['lastNotNull'], fields: '', values: false },
      },
    },
  ],
};

// ---------------------------------------------------------------------------
// Row 3 — Disk.
// ---------------------------------------------------------------------------
const row3: RowSpec = {
  title: 'Disk',
  panels: [
    {
      title: 'Current disk usage',
      type: 'gauge',
      width: 8,
      height: 7,
      description:
        'Thresholds 75/90% (DESIGN.md §10.2). A full disk on FTD affects logging and deployment, not just metrics — hence the critical severity on the matching alert.',
      targets: targets([`ftd_disk_usage_ratio{${SCOPE}}`, '{{device_name}}', { instant: true }]),
      defaults: {
        unit: 'percentunit',
        min: 0,
        max: 1,
        thresholds: {
          mode: 'absolute',
          steps: [
            { color: 'green', value: null },
            { color: 'yellow', value: 0.75 },
            { color: 'red', value: 0.9 },
          ],
        },
      },
      options: {
        showThresholdLabels: false,
        showThresholdMarkers: true,
        reduceOptions: { calcs: ['lastNotNull'], fields: '', values: false },
      },
    },
    {
      title: 'Disk usage trend',
      type: 'timeseries',
      width: 16,
      height: 7,
      description:
        'Where slow-growth problems are visible. A steadily rising line over days is the signal here — the gauge on the left cannot show it.',
      targets: targets([`ftd_disk_usage_ratio{${SCOPE}}`, '{{device_name}}', { range: true }]),
      defaults: {
        unit: 'percentunit',
        min: 0,
        max: 1,
        custom: { fillOpacity: 5, lineWidth: 2, showPoints: 'never' },
        thresholds: {
          mode: 'absolute',
          steps: [
            { color: 'green', value: null },
            { color: 'yellow', value: 0.75 },
            { color: 'red', value: 0.9 },
          ],
        },
      },
      options: {
        legend: { displayMode: 'table', placement: 'right', calcs: ['lastNotNull', 'max'] },
        tooltip: { mode: 'multi', sort: 'desc' },
      },
    },
  ],
};

// ---------------------------------------------------------------------------
// Row 4 — Interfaces. Errors/drops are on a SEPARATE panel from throughput
// deliberately (DESIGN.md §10.2): mixing them on one axis hides small-but-
// significant error counts under large byte values.
// ---------------------------------------------------------------------------
const row4: RowSpec = {
  title: 'Interfaces',
  panels: [
    {
      title: 'Throughput (mirrored: in above, out below)',
      type: 'timeseries',
      width: 12,
      height: 8,
      description: `Conventional mirrored view — inbound positive, outbound negative via a per-series transform.${UNIT_CAVEAT}`,
      targets: targets(
        [`ftd_interface_input_bytes_avg{${SCOPE_IF}}`, 'in — {{device_name}} {{interface_name}}'],
        [`ftd_interface_output_bytes_avg{${SCOPE_IF}}`, 'out — {{device_name}} {{interface_name}}'],
      ),
      defaults: {
        unit: 'bytes',
        custom: { fillOpacity: 10, lineWidth: 1, showPoints: 'never', axisSoftMin: 0 },
      },
      overrides: [
        {
          matcher: { id: 'byRegexp', options: '^out — .*' },
          properties: [{ id: 'custom.transform', value: 'negative-Y' }],
        },
      ],
      options: {
        legend: { displayMode: 'table', placement: 'bottom', calcs: ['lastNotNull', 'max'] },
        tooltip: { mode: 'multi', sort: 'desc' },
      },
    },
    {
      title: 'Errors and drops',
      type: 'timeseries',
      width: 12,
      height: 8,
      description:
        'Separated from throughput on purpose: on a shared axis a handful of errors is invisible next to gigabytes of traffic. Any non-zero value here on a named interface is worth investigating — usually cabling, an SFP, or a duplex mismatch.',
      targets: targets(
        [
          `ftd_interface_input_errors_avg{${SCOPE_IF}}`,
          'in errors — {{device_name}} {{interface_name}}',
        ],
        [
          `ftd_interface_output_errors_avg{${SCOPE_IF}}`,
          'out errors — {{device_name}} {{interface_name}}',
        ],
        [
          `ftd_interface_drop_packets_avg{${SCOPE_IF}}`,
          'drops — {{device_name}} {{interface_name}}',
        ],
      ),
      defaults: {
        unit: 'short',
        min: 0,
        custom: { fillOpacity: 0, lineWidth: 2, showPoints: 'auto' },
      },
      options: {
        legend: { displayMode: 'table', placement: 'bottom', calcs: ['lastNotNull', 'max'] },
        tooltip: { mode: 'multi', sort: 'desc' },
      },
    },
    {
      title: 'Buffer overruns / underruns / L2 decode drops',
      type: 'timeseries',
      width: 12,
      height: 7,
      description:
        'Low-level indicators in their own panel because they usually point at a physical or driver-level problem rather than a policy one — a different investigation from an interface error count.',
      targets: targets(
        [
          `ftd_interface_buffer_overruns_avg{${SCOPE_IF}}`,
          'overruns — {{device_name}} {{interface_name}}',
        ],
        [
          `ftd_interface_buffer_underruns_avg{${SCOPE_IF}}`,
          'underruns — {{device_name}} {{interface_name}}',
        ],
        [
          `ftd_interface_l2_decode_drops_avg{${SCOPE_IF}}`,
          'l2 decode drops — {{device_name}} {{interface_name}}',
        ],
      ),
      defaults: {
        unit: 'short',
        min: 0,
        custom: { fillOpacity: 0, lineWidth: 2, showPoints: 'auto' },
      },
      options: {
        legend: { displayMode: 'table', placement: 'bottom', calcs: ['lastNotNull', 'max'] },
        tooltip: { mode: 'multi', sort: 'desc' },
      },
    },
    {
      title: 'Link and operational state history',
      type: 'state-timeline',
      width: 12,
      height: 7,
      description:
        'Flap history at a glance, which a gauge cannot show. Both link status and operational status are plotted: they can legitimately disagree (a cable is up while the interface is administratively down).',
      targets: targets(
        [
          `ftd_interface_link_up{${SCOPE_IF}}`,
          'link — {{device_name}} {{interface_name}}',
          { range: true },
        ],
        [
          `ftd_interface_operational_up{${SCOPE_IF}}`,
          'oper — {{device_name}} {{interface_name}}',
          { range: true },
        ],
      ),
      defaults: {
        custom: { fillOpacity: 90, lineWidth: 0 },
        mappings: [
          { type: 'value', options: { '0': { text: 'down', color: 'red', index: 0 } } },
          { type: 'value', options: { '1': { text: 'up', color: 'green', index: 1 } } },
        ],
        noValue:
          'No link/operational state — an unrecognized upstream status value is omitted rather than guessed (DESIGN.md §4.4).',
      },
      options: {
        mergeValues: true,
        showValue: 'never',
        alignValue: 'left',
        legend: { displayMode: 'list', placement: 'bottom' },
        tooltip: { mode: 'single' },
      },
    },
    {
      title: 'Interface inventory (including down and unused)',
      type: 'table',
      width: 24,
      height: 9,
      description:
        'Every interface the device reports, including unused ones — exported by design (DESIGN.md §4.2). An interface whose `interface_name` equals its `interface` has no configured name; those are the ones deliberately excluded from FtdInterfaceDown alerting, and the reason this table exists separately from the down-count stat in row 1.',
      targets: [
        {
          refId: 'A',
          expr: `ftd_interface_operational_up{${SCOPE_IF}}`,
          legendFormat: 'oper',
          instant: true,
        },
        {
          refId: 'B',
          expr: `ftd_interface_link_up{${SCOPE_IF}}`,
          legendFormat: 'link',
          instant: true,
        },
      ],
      transformations: [
        { id: 'merge', options: {} },
        {
          id: 'organize',
          options: {
            excludeByName: { Time: true, device_uid: true, __name__: true },
            renameByName: {
              device_name: 'Device',
              interface: 'Interface (hardware id)',
              interface_name: 'Configured name',
              interface_type: 'Type',
              'Value #A': 'Operational',
              'Value #B': 'Link',
            },
          },
        },
      ],
      defaults: {
        custom: { align: 'auto', cellOptions: { type: 'auto' }, filterable: true },
        mappings: [
          { type: 'value', options: { '0': { text: 'down', color: 'red', index: 0 } } },
          { type: 'value', options: { '1': { text: 'up', color: 'green', index: 1 } } },
        ],
      },
      overrides: [
        {
          matcher: { id: 'byRegexp', options: '(Operational|Link)' },
          properties: [{ id: 'custom.cellOptions', value: { type: 'color-text' } }],
        },
      ],
      options: { showHeader: true, footer: { show: false, reducer: ['sum'], fields: '' } },
    },
  ],
};

// ---------------------------------------------------------------------------
// Row 5 — High availability (CONDITIONAL). The state-set representation from
// DESIGN.md §4.4 maps directly onto a state-timeline, which §10.2 notes is "a
// large part of why that representation was chosen".
// ---------------------------------------------------------------------------
const row5: RowSpec = {
  title: 'High availability (conditional — empty unless devices are in an HA pair)',
  panels: [
    {
      title: 'HA status history',
      type: 'state-timeline',
      width: 16,
      height: 7,
      description: `Empty for devices not in an HA pair, which is EXPECTED and not a fault (DESIGN.md §4.8 — conditional groups are genuinely absent, never zero). The query filters the state set to whichever status is currently 1, so the timeline shows the status name rather than five parallel 0/1 lines.${EXPERIMENTAL}`,
      targets: targets([
        `ftd_ha_node_status{${SCOPE}} == 1`,
        '{{device_name}} — {{status}}',
        { range: true },
      ]),
      defaults: {
        custom: { fillOpacity: 90, lineWidth: 0 },
        noValue: NO_DATA.ha,
        mappings: [
          { type: 'value', options: { '1': { text: 'active', color: 'text', index: 0 } } },
        ],
      },
      options: {
        mergeValues: true,
        showValue: 'never',
        alignValue: 'left',
        legend: { displayMode: 'list', placement: 'bottom' },
        tooltip: { mode: 'single' },
      },
    },
    {
      title: 'Current HA role',
      type: 'table',
      width: 8,
      height: 7,
      description: `Role (primary/secondary) per device from \`ftd_ha_node_info\`, alongside the currently-active status. An unrecognized upstream role renders as \`unknown\` rather than minting a new label value (DESIGN.md §4.4).${EXPERIMENTAL}`,
      targets: [
        {
          refId: 'A',
          expr: `ftd_ha_node_info{${SCOPE}} == 1`,
          legendFormat: 'role',
          instant: true,
        },
        {
          refId: 'B',
          expr: `ftd_ha_node_status{${SCOPE}} == 1`,
          legendFormat: 'status',
          instant: true,
        },
      ],
      transformations: [
        { id: 'merge', options: {} },
        {
          id: 'organize',
          options: {
            excludeByName: {
              Time: true,
              device_uid: true,
              __name__: true,
              'Value #A': true,
              'Value #B': true,
            },
            renameByName: {
              device_name: 'Device',
              node_type: 'HA role',
              status: 'HA status',
            },
          },
        },
      ],
      defaults: {
        custom: { align: 'auto', cellOptions: { type: 'auto' }, filterable: true },
        noValue: NO_DATA.ha,
      },
      options: { showHeader: true, footer: { show: false, reducer: ['sum'], fields: '' } },
    },
  ],
};

// ---------------------------------------------------------------------------
// Row 6 — VPN (CONDITIONAL). S2S tunnel state is filtered to non-up BY DEFAULT
// so the panel shows problems rather than a wall of green (DESIGN.md §10.2).
// ---------------------------------------------------------------------------
const row6: RowSpec = {
  title: 'VPN (conditional — empty unless RA VPN or S2S VPN is configured)',
  panels: [
    {
      title: 'RA VPN sessions',
      type: 'timeseries',
      width: 16,
      height: 7,
      description: `Active and inactive session counts with peak-concurrent overlaid as a dashed line. Empty unless remote-access VPN is configured, which is expected rather than a fault.${EXPERIMENTAL}`,
      targets: targets(
        [`ftd_ravpn_sessions_active_avg{${SCOPE}}`, 'active — {{device_name}}'],
        [`ftd_ravpn_sessions_inactive_avg{${SCOPE}}`, 'inactive — {{device_name}}'],
        [`ftd_ravpn_sessions_peak_concurrent{${SCOPE}}`, 'peak concurrent — {{device_name}}'],
      ),
      defaults: {
        unit: 'short',
        min: 0,
        custom: { fillOpacity: 10, lineWidth: 2, showPoints: 'never' },
        noValue: NO_DATA.vpn,
      },
      overrides: [
        {
          matcher: { id: 'byRegexp', options: '^peak concurrent — .*' },
          properties: [
            { id: 'custom.lineStyle', value: { fill: 'dash', dash: [10, 10] } },
            { id: 'custom.fillOpacity', value: 0 },
          ],
        },
      ],
      options: {
        legend: { displayMode: 'table', placement: 'right', calcs: ['lastNotNull', 'max'] },
        tooltip: { mode: 'multi', sort: 'desc' },
      },
    },
    {
      title: 'Active RA VPN sessions',
      type: 'stat',
      width: 8,
      height: 7,
      description: `Current active session count per device. NO THRESHOLD IS SET BY DEFAULT: session capacity is model-dependent (DESIGN.md §10.2 row 6), so a shipped number would be wrong for most fleets. Set one against your own platform's documented capacity.${EXPERIMENTAL}`,
      targets: targets([
        `ftd_ravpn_sessions_active_avg{${SCOPE}}`,
        '{{device_name}}',
        { instant: true },
      ]),
      defaults: { unit: 'short', noValue: NO_DATA.vpn },
      options: {
        colorMode: 'none',
        graphMode: 'area',
        reduceOptions: { calcs: ['lastNotNull'], fields: '', values: false },
      },
    },
    {
      title: 'S2S tunnels not up',
      type: 'table',
      width: 16,
      height: 7,
      description: `Filtered to non-up by default so the panel shows PROBLEMS rather than a wall of green (DESIGN.md §10.2). An empty table here is the good outcome — it means every tunnel is up, or no S2S VPN is configured. Remove the \`state!="up"\` filter to see all tunnels.${EXPERIMENTAL}`,
      targets: [
        {
          refId: 'A',
          expr: `ftd_s2s_tunnel_state{${SCOPE},state!="up"} == 1`,
          legendFormat: 'tunnel',
          instant: true,
        },
      ],
      transformations: [
        {
          id: 'organize',
          options: {
            excludeByName: { Time: true, device_uid: true, __name__: true, Value: true },
            renameByName: {
              device_name: 'Device',
              tunnel_name: 'Tunnel',
              tunnel_id: 'Tunnel id',
              state: 'State',
            },
          },
        },
      ],
      defaults: {
        custom: { align: 'auto', cellOptions: { type: 'auto' }, filterable: true },
        noValue: 'No tunnels in a non-up state (or no S2S VPN configured) — this is the good case.',
      },
      overrides: [
        {
          matcher: { id: 'byName', options: 'State' },
          properties: [
            { id: 'custom.cellOptions', value: { type: 'color-background' } },
            {
              id: 'mappings',
              value: [
                {
                  type: 'value',
                  options: {
                    down: { color: 'red', index: 0 },
                    unknown: { color: 'orange', index: 1 },
                  },
                },
              ],
            },
          ],
        },
      ],
      options: { showHeader: true, footer: { show: false, reducer: ['sum'], fields: '' } },
    },
    {
      title: 'Tunnels currently down',
      type: 'stat',
      width: 8,
      height: 7,
      description: `The number an operator actually wants at 3am (DESIGN.md §10.2).${EXPERIMENTAL}`,
      targets: targets([
        `count(ftd_s2s_tunnel_state{${SCOPE},state="down"} == 1)`,
        'down',
        { instant: true },
      ]),
      defaults: {
        unit: 'short',
        noValue: NO_DATA.vpn,
        thresholds: {
          mode: 'absolute',
          steps: [
            { color: 'green', value: null },
            { color: 'red', value: 1 },
          ],
        },
      },
      options: {
        colorMode: 'background',
        graphMode: 'none',
        reduceOptions: { calcs: ['lastNotNull'], fields: '', values: false },
      },
    },
  ],
};

// ---------------------------------------------------------------------------
// Row 7 — Chassis (CONDITIONAL, chassis hardware only).
// ---------------------------------------------------------------------------
const row7: RowSpec = {
  title: 'Chassis (conditional — chassis-based platforms only, empty on appliances)',
  panels: [
    {
      title: 'Fan speed',
      type: 'timeseries',
      width: 12,
      height: 7,
      description: `Fan RPM by \`fan\` label. Empty on appliances such as the FTD 1010, which is expected rather than a fault (DESIGN.md §10.2 row 7).${EXPERIMENTAL}`,
      targets: targets([
        `ftd_chassis_fan_rpm{${SCOPE}}`,
        '{{device_name}} — fan {{fan}}',
        { range: true },
      ]),
      defaults: {
        unit: 'rotrpm',
        min: 0,
        custom: { fillOpacity: 0, lineWidth: 2, showPoints: 'never' },
        noValue: NO_DATA.chassis,
      },
      options: {
        legend: { displayMode: 'table', placement: 'right', calcs: ['lastNotNull', 'min', 'max'] },
        tooltip: { mode: 'multi', sort: 'desc' },
      },
    },
    {
      title: 'PSU status',
      type: 'stat',
      width: 12,
      height: 7,
      description: `Input, output, and fan status per PSU, red on 0. A PSU whose upstream status value is unrecognized is OMITTED rather than rendered as 0 (DESIGN.md §4.4) — so a missing tile is "not classifiable", not "failed".${EXPERIMENTAL}`,
      targets: targets(
        [
          `ftd_chassis_psu_input_up{${SCOPE}}`,
          '{{device_name}} psu {{psu}} input',
          { instant: true },
        ],
        [
          `ftd_chassis_psu_output_up{${SCOPE}}`,
          '{{device_name}} psu {{psu}} output',
          { instant: true },
        ],
        [`ftd_chassis_psu_fan_up{${SCOPE}}`, '{{device_name}} psu {{psu}} fan', { instant: true }],
      ),
      defaults: {
        noValue: NO_DATA.chassis,
        mappings: [
          { type: 'value', options: { '0': { text: 'FAILED', color: 'red', index: 0 } } },
          { type: 'value', options: { '1': { text: 'OK', color: 'green', index: 1 } } },
        ],
        thresholds: {
          mode: 'absolute',
          steps: [
            { color: 'red', value: null },
            { color: 'green', value: 1 },
          ],
        },
      },
      options: {
        colorMode: 'background',
        graphMode: 'none',
        textMode: 'value_and_name',
        reduceOptions: { calcs: ['lastNotNull'], fields: '', values: false },
      },
    },
  ],
};

// ---------------------------------------------------------------------------
// Row 8 — Data freshness and diagnostics. The per-device staleness panel is the
// reason the window timestamps are exported at all (DESIGN.md §4.5).
// ---------------------------------------------------------------------------
const row8: RowSpec = {
  title: 'Data freshness and exporter diagnostics',
  panels: [
    {
      title: 'Per-device data staleness',
      type: 'timeseries',
      width: 12,
      height: 8,
      description:
        'Age of each device\'s health sample window. This catches "this ONE device stopped reporting" while every other device — and `ftd_exporter_up` — still looks fine, because a partial-failure poll cycle still counts as a success (DESIGN.md §3.3). This panel is the reason the window timestamps are exported at all (§4.5). A device missing from this panel entirely is reporting no window timestamps rather than reporting stale ones.',
      targets: targets([
        `time() - ftd_health_window_end_timestamp_seconds{${SCOPE}}`,
        '{{device_name}}',
        { range: true },
      ]),
      defaults: {
        unit: 's',
        min: 0,
        custom: { fillOpacity: 0, lineWidth: 2, showPoints: 'never' },
        thresholds: {
          mode: 'absolute',
          steps: [
            { color: 'green', value: null },
            { color: 'yellow', value: 600 },
            { color: 'red', value: 900 },
          ],
        },
      },
      options: {
        legend: { displayMode: 'table', placement: 'right', calcs: ['lastNotNull', 'max'] },
        tooltip: { mode: 'multi', sort: 'desc' },
      },
    },
    {
      title: 'Poll duration',
      type: 'timeseries',
      width: 12,
      height: 8,
      description:
        'p50/p95/p99 of poll cycle latency. Reveals a degrading upstream before it fails outright. On the FMC backend this scales with device count — a cycle is one request per device per metric family (DESIGN.md §3.3).',
      targets: targets(
        [
          `histogram_quantile(0.50, sum by (le) (rate(ftd_exporter_poll_duration_seconds_bucket{${SCOPE_SELF}}[5m])))`,
          'p50',
        ],
        [
          `histogram_quantile(0.95, sum by (le) (rate(ftd_exporter_poll_duration_seconds_bucket{${SCOPE_SELF}}[5m])))`,
          'p95',
        ],
        [
          `histogram_quantile(0.99, sum by (le) (rate(ftd_exporter_poll_duration_seconds_bucket{${SCOPE_SELF}}[5m])))`,
          'p99',
        ],
      ),
      defaults: {
        unit: 's',
        min: 0,
        custom: { fillOpacity: 0, lineWidth: 2, showPoints: 'never' },
      },
      options: {
        legend: { displayMode: 'list', placement: 'bottom' },
        tooltip: { mode: 'multi', sort: 'desc' },
      },
    },
    {
      title: 'Poll errors by reason',
      type: 'timeseries',
      width: 8,
      height: 7,
      description:
        'The `reason` label set is bounded and deliberate (DESIGN.md §11): auth, rate_limited, timeout, network, http_5xx, parse, unknown. A rising `rate_limited` means the poll interval is too aggressive for the backend; a rising `parse` means upstream schema drift.',
      targets: targets([
        `sum by (reason) (rate(ftd_exporter_poll_errors_total{${SCOPE_SELF}}[5m]))`,
        '{{reason}}',
      ]),
      defaults: {
        unit: 'reqps',
        min: 0,
        custom: { fillOpacity: 20, lineWidth: 1, showPoints: 'auto', stacking: { mode: 'normal' } },
        noValue: '0 — no poll errors in this window.',
      },
      options: {
        legend: { displayMode: 'table', placement: 'bottom', calcs: ['sum'] },
        tooltip: { mode: 'multi', sort: 'desc' },
      },
    },
    {
      title: 'Upstream request rate by status code',
      type: 'timeseries',
      width: 8,
      height: 7,
      description:
        'Requests per second to the Cisco API, by templated endpoint and status code (never with UUIDs interpolated — that would be a cardinality explosion, DESIGN.md §11). A sustained 429 rate means the internal limiter is not keeping up with the configured poll interval.',
      targets: targets([
        `sum by (status_code) (rate(ftd_exporter_upstream_requests_total{${SCOPE_SELF}}[5m]))`,
        '{{status_code}}',
      ]),
      defaults: {
        unit: 'reqps',
        min: 0,
        custom: { fillOpacity: 20, lineWidth: 1, showPoints: 'auto', stacking: { mode: 'normal' } },
      },
      options: {
        legend: { displayMode: 'table', placement: 'bottom', calcs: ['sum'] },
        tooltip: { mode: 'multi', sort: 'desc' },
      },
    },
    {
      title: 'Exporter diagnostics',
      type: 'stat',
      width: 8,
      height: 7,
      description:
        'TLS verification disabled is a RED indicator by design (DESIGN.md §9.6) — the insecure escape hatch is a bring-up aid, not a running configuration. "Discovered vs reporting" is the FMC per-device-failure/pagination diagnostic: a gap between them means discovery found devices the poll could not fetch. Rate-limit deferrals confirm the internal limiter is doing its job; a large number is not an error but does mean the configuration is more aggressive than the backend allows.',
      targets: targets(
        [
          `max(ftd_exporter_tls_verification_disabled{${SCOPE_SELF}})`,
          'TLS verification disabled',
          { instant: true },
        ],
        [
          `sum(ftd_exporter_devices_discovered{${SCOPE_SELF}})`,
          'Devices discovered',
          { instant: true },
        ],
        [`sum(ftd_exporter_series{${SCOPE_SELF}})`, 'Series rendered', { instant: true }],
        [
          `sum(increase(ftd_exporter_rate_limit_deferrals_total{${SCOPE_SELF}}[1h]))`,
          'Rate-limit deferrals (1h)',
          { instant: true },
        ],
        [
          `sum(increase(ftd_exporter_parse_errors_total{${SCOPE_SELF}}[1h]))`,
          'Parse errors (1h)',
          { instant: true },
        ],
        [
          `sum(increase(ftd_exporter_unknown_enum_total{${SCOPE_SELF}}[1h]))`,
          'Unknown enum values (1h)',
          { instant: true },
        ],
      ),
      defaults: { unit: 'short', noValue: '—' },
      overrides: [
        {
          matcher: { id: 'byName', options: 'TLS verification disabled' },
          properties: [
            {
              id: 'mappings',
              value: [
                { type: 'value', options: { '0': { text: 'no', color: 'green', index: 0 } } },
                {
                  type: 'value',
                  options: { '1': { text: 'YES — INSECURE', color: 'red', index: 1 } },
                },
              ],
            },
            {
              id: 'thresholds',
              value: {
                mode: 'absolute',
                steps: [
                  { color: 'green', value: null },
                  { color: 'red', value: 1 },
                ],
              },
            },
          ],
        },
        {
          matcher: { id: 'byRegexp', options: '(Parse errors|Unknown enum).*' },
          properties: [
            {
              id: 'thresholds',
              value: {
                mode: 'absolute',
                steps: [
                  { color: 'green', value: null },
                  { color: 'yellow', value: 1 },
                ],
              },
            },
          ],
        },
      ],
      options: {
        colorMode: 'background',
        graphMode: 'none',
        textMode: 'value_and_name',
        reduceOptions: { calcs: ['lastNotNull'], fields: '', values: false },
      },
    },
    {
      title: 'Exporter build info',
      type: 'table',
      width: 24,
      height: 5,
      description:
        'What is actually running — the first thing to establish in a support case. Include these labels in any issue you open.',
      targets: [
        {
          refId: 'A',
          expr: `ftd_exporter_build_info{${SCOPE_SELF}}`,
          legendFormat: 'build',
          instant: true,
        },
      ],
      transformations: [
        {
          id: 'organize',
          options: {
            excludeByName: { Time: true, __name__: true, Value: true },
            renameByName: {
              version: 'Version',
              commit: 'Commit',
              node_version: 'Node',
              backend: 'Backend',
              instance: 'Instance',
              job: 'Job',
            },
          },
        },
      ],
      defaults: { custom: { align: 'auto', cellOptions: { type: 'auto' }, filterable: true } },
      options: { showHeader: true, footer: { show: false, reducer: ['sum'], fields: '' } },
    },
  ],
};

const ROWS: RowSpec[] = [row1, row2, row3, row4, row5, row6, row7, row8];

// ---------------------------------------------------------------------------
// Layout: rows are `row`-type panels; each row's own panels are laid out
// left-to-right, wrapping at 24 grid columns. Panel ids are assigned
// sequentially by position so regeneration is deterministic — the whole point
// of generating rather than committing a UI export.
// ---------------------------------------------------------------------------
function buildPanels(): unknown[] {
  const panels: unknown[] = [];
  let id = 1;
  let y = 0;

  for (const row of ROWS) {
    panels.push({
      id: id++,
      type: 'row',
      title: row.title,
      collapsed: false,
      gridPos: { h: 1, w: GRID_WIDTH, x: 0, y },
      panels: [],
    });
    y += 1;

    let x = 0;
    let rowHeight = 0;
    for (const spec of row.panels) {
      if (x + spec.width > GRID_WIDTH) {
        x = 0;
        y += rowHeight;
        rowHeight = 0;
      }
      panels.push(buildPanel(spec, id++, x, y));
      x += spec.width;
      rowHeight = Math.max(rowHeight, spec.height);
    }
    y += rowHeight;
  }

  return panels;
}

function buildPanel(spec: PanelSpec, id: number, x: number, y: number): unknown {
  const panel: Record<string, unknown> = {
    id,
    type: spec.type,
    title: spec.title,
    datasource: DS,
    gridPos: { h: spec.height, w: spec.width, x, y },
    fieldConfig: {
      defaults: { custom: {}, ...spec.defaults },
      overrides: spec.overrides ?? [],
    },
    options: spec.options ?? {},
  };
  if (spec.description !== undefined) panel.description = spec.description;
  if (spec.transformations !== undefined) panel.transformations = spec.transformations;
  if (spec.targets !== undefined) {
    panel.targets = spec.targets.map((t) => ({
      datasource: DS,
      refId: t.refId,
      expr: t.expr,
      ...(t.legendFormat !== undefined ? { legendFormat: t.legendFormat } : {}),
      ...(t.instant === true ? { instant: true, range: false } : {}),
      ...(t.range === true ? { instant: false, range: true } : {}),
      editorMode: 'code',
    }));
  }
  return panel;
}

/**
 * Template variables. DS_PROMETHEUS is a `datasource`-type variable rather
 * than the `__inputs` export form Grafana.com sharing produces: a datasource
 * variable resolves against whatever Prometheus the target Grafana already has
 * (defaulting to its default datasource), so the dashboard imports with no
 * hand-editing and — crucially — with no hardcoded datasource UID anywhere in
 * the file that could dangle (DESIGN.md §10.1's stated friction point).
 */
function buildTemplating(): unknown {
  return {
    list: [
      {
        name: 'DS_PROMETHEUS',
        label: 'Prometheus',
        type: 'datasource',
        query: 'prometheus',
        current: {},
        hide: 0,
        refresh: 1,
        regex: '',
        skipUrlSync: false,
      },
      {
        name: 'job',
        label: 'Job',
        type: 'query',
        datasource: DS,
        definition: 'label_values(ftd_exporter_up, job)',
        query: { query: 'label_values(ftd_exporter_up, job)', refId: 'job' },
        includeAll: true,
        allValue: '.*',
        multi: true,
        current: { text: 'All', value: '$__all' },
        refresh: 1,
        sort: 1,
        hide: 0,
        skipUrlSync: false,
      },
      {
        name: 'instance',
        label: 'Exporter instance',
        type: 'query',
        datasource: DS,
        definition: 'label_values(ftd_exporter_up{job=~"$job"}, instance)',
        query: {
          query: 'label_values(ftd_exporter_up{job=~"$job"}, instance)',
          refId: 'instance',
        },
        includeAll: true,
        allValue: '.*',
        multi: true,
        current: { text: 'All', value: '$__all' },
        refresh: 1,
        sort: 1,
        hide: 0,
        skipUrlSync: false,
      },
      {
        name: 'device',
        label: 'Device',
        type: 'query',
        datasource: DS,
        // Sourced from ftd_cpu_usage_ratio per DESIGN.md §10.1. CPU is the one
        // metric group present for every device on both backends, so it is the
        // only safe source for a device list — an interface- or HA-derived list
        // would silently omit devices.
        definition:
          'label_values(ftd_cpu_usage_ratio{job=~"$job",instance=~"$instance"}, device_name)',
        query: {
          query:
            'label_values(ftd_cpu_usage_ratio{job=~"$job",instance=~"$instance"}, device_name)',
          refId: 'device',
        },
        includeAll: true,
        allValue: '.*',
        multi: true,
        current: { text: 'All', value: '$__all' },
        refresh: 1,
        sort: 1,
        hide: 0,
        skipUrlSync: false,
      },
      {
        name: 'interface',
        label: 'Interface',
        type: 'query',
        datasource: DS,
        // Dependent on $device (Stage 15 testing step 5): selecting a device
        // narrows this list, because the label_values selector itself carries
        // the device filter.
        definition:
          'label_values(ftd_interface_operational_up{job=~"$job",instance=~"$instance",device_name=~"$device"}, interface)',
        query: {
          query:
            'label_values(ftd_interface_operational_up{job=~"$job",instance=~"$instance",device_name=~"$device"}, interface)',
          refId: 'interface',
        },
        includeAll: true,
        allValue: '.*',
        multi: true,
        current: { text: 'All', value: '$__all' },
        refresh: 1,
        sort: 1,
        hide: 0,
        skipUrlSync: false,
      },
    ],
  };
}

export function buildDashboard(): Record<string, unknown> {
  return {
    __generated_by:
      'scripts/generate-dashboard.ts — do not hand-edit this file; edit the generator and regenerate (see docs/DASHBOARDS_AND_ALERTS.md).',
    title: 'Cisco FTD fleet health',
    uid: 'ftd-health',
    description:
      'Cisco FTD firewall fleet health, from ftd-metrics-exporter. Exporter health is row 1 and deliberately first: a dashboard that looks green while the exporter is dead is the worst possible outcome. Conditional rows (HA, VPN, chassis) are empty on fleets without that capability — that is expected, not a fault, and each such panel says so in place of "No data". CAVEATS: chassis/HA/VPN panels are built against synthetic data and are experimental in v1 (DESIGN.md §13); interface throughput axis units are unresolved (DESIGN.md §14.4); and all thresholds are documented starting points, not universal truths.',
    tags: ['cisco', 'ftd', 'firewall', 'prometheus'],
    editable: true,
    graphTooltip: 1,
    schemaVersion: 39,
    // Fixed rather than incremented on regeneration: a bumping version number is
    // exactly the JSON churn this generator exists to avoid.
    version: 1,
    weekStart: '',
    timezone: 'browser',
    time: { from: 'now-6h', to: 'now' },
    timepicker: {},
    refresh: '1m',
    annotations: {
      list: [
        {
          builtIn: 1,
          datasource: { type: 'grafana', uid: '-- Grafana --' },
          enable: true,
          hide: true,
          iconColor: 'rgba(0, 211, 255, 1)',
          name: 'Annotations & Alerts',
          type: 'dashboard',
        },
      ],
    },
    templating: buildTemplating(),
    panels: buildPanels(),
  };
}

/** Exact bytes of the committed dashboards/ftd-health.json. */
export function renderDashboardJson(): string {
  return `${JSON.stringify(buildDashboard(), null, 2)}\n`;
}

export const DASHBOARD_PATH = fileURLToPath(
  new URL('../dashboards/ftd-health.json', import.meta.url),
);

// Only write when run directly, so test/unit/dashboard-and-alerts.test.ts can
// import renderDashboardJson() and assert the committed file matches without
// the import itself rewriting the file it is about to check.
if (process.argv[1] !== undefined && import.meta.filename === process.argv[1]) {
  writeFileSync(DASHBOARD_PATH, renderDashboardJson());
  process.stdout.write(`wrote ${DASHBOARD_PATH}\n`);
}
