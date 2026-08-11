/**
 * Guards the Stage 15 deliverables (dashboards/ftd-health.json,
 * alerts/ftd-health.yaml) against drifting away from the exporter's actual
 * metric surface.
 *
 * The failure this exists to prevent is silent: renaming a metric in
 * src/metrics/ leaves every dashboard panel and alert rule referencing the old
 * name syntactically valid — `promtool check rules` passes, Grafana imports
 * cleanly, and the only symptom is a panel that reads "No data" forever and an
 * alert that can never fire. Nothing in the build, the type system, or promtool
 * can see it, because a PromQL query is a string as far as all three are
 * concerned.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { Counter, Gauge, Histogram } from 'prom-client';
import { renderDashboardJson } from '../../scripts/generate-dashboard.ts';
import { allDeviceGauges, createDeviceMetrics } from '../../src/metrics/device-metrics.ts';
import {
  allDeviceInventoryGauges,
  createDeviceInventoryMetrics,
} from '../../src/metrics/inventory-metrics.ts';
import { createRegistry } from '../../src/metrics/registry.ts';
import { createSelfMetrics } from '../../src/metrics/self.ts';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

function read(relative: string): string {
  return readFileSync(`${repoRoot}${relative}`, 'utf8');
}

const DASHBOARD_JSON = read('dashboards/ftd-health.json');
const ALERTS_YAML = read('alerts/ftd-health.yaml');
const ALERTS_TEST_YAML = read('alerts/ftd-health.test.yaml');

// Grafana's own variable-interpolation syntax, which happens to collide with
// JS template-literal syntax. Named rather than repeated inline so it reads as
// one datasource reference instead of four string literals a typo could
// silently diverge.
// biome-ignore lint/suspicious/noTemplateCurlyInString: Grafana's variable syntax, not a JS placeholder.
const DS_VAR = '${DS_PROMETHEUS}';

/**
 * ALERTS_YAML with comment lines removed. Load-bearing for any check of the form
 * "this file must NOT contain X": the rule file deliberately documents the
 * rejected `interface_name != ""` filter and quotes expression fragments in its
 * comments, so a naive substring search over the raw text reports a violation
 * that exists only in prose. Found by exactly that false positive.
 */
const ALERTS_EXPRESSIONS = ALERTS_YAML.split('\n')
  .filter((line) => !line.trimStart().startsWith('#'))
  .join('\n');

/**
 * Real metric names, taken off constructed prom-client instances rather than
 * parsed out of source — the same technique scripts/generate-metrics-doc.ts
 * uses, and the reason this test cannot be fooled by a stale declaration.
 * Histograms are expanded to their `_bucket`/`_sum`/`_count` suffixed series,
 * since a dashboard querying a histogram quantile references `_bucket`, which is
 * a real series name even though it is not a declared metric name.
 */
function declaredMetricNames(): Set<string> {
  const registry = createRegistry(false);
  const device = createDeviceMetrics(registry);
  const inventory = createDeviceInventoryMetrics(registry);
  const self = createSelfMetrics(registry);
  const all = [
    ...allDeviceGauges(device),
    ...allDeviceInventoryGauges(inventory),
    ...(Object.values(self) as Array<Gauge<string> | Counter<string> | Histogram<string>>),
  ];

  const names = new Set<string>();
  for (const metric of all) {
    const record = metric as unknown as { name: string; type: string };
    names.add(record.name);
    if (record.type === 'histogram') {
      names.add(`${record.name}_bucket`);
      names.add(`${record.name}_sum`);
      names.add(`${record.name}_count`);
    }
  }
  return names;
}

/**
 * Every distinct `ftd_`-prefixed identifier appearing in a text blob. Deliberately
 * broader than "parse the PromQL properly": an `ftd_`-prefixed token anywhere in
 * the file — a query, an annotation's `{{ }}` template referencing a metric an
 * operator should query, a comment naming a metric — should be a metric that
 * exists. A regex over the raw text catches all of those uniformly, and there is
 * no legitimate `ftd_`-prefixed identifier in either file that is not a metric
 * name.
 */
function referencedMetricNames(text: string): string[] {
  return [...new Set(text.match(/\bftd_[a-z0-9_]+/g) ?? [])].sort();
}

/** Label names each real metric declares, for the label cross-check below. */
function declaredLabels(): Map<string, Set<string>> {
  const registry = createRegistry(false);
  const device = createDeviceMetrics(registry);
  const inventory = createDeviceInventoryMetrics(registry);
  const self = createSelfMetrics(registry);
  const all = [
    ...allDeviceGauges(device),
    ...allDeviceInventoryGauges(inventory),
    ...(Object.values(self) as Array<Gauge<string> | Counter<string> | Histogram<string>>),
  ];
  const map = new Map<string, Set<string>>();
  for (const metric of all) {
    const record = metric as unknown as { name: string; labelNames: string[] };
    map.set(record.name, new Set(record.labelNames));
  }
  return map;
}

describe('Stage 15 dashboard and alert rules', () => {
  describe('metric-name cross-check against real declarations', () => {
    const declared = declaredMetricNames();

    it('the alert rules reference no metric that does not exist', () => {
      const referenced = referencedMetricNames(ALERTS_YAML);
      assert.ok(referenced.length > 0, 'no ftd_* metric names found — regex or file is wrong');
      const unknown = referenced.filter((name) => !declared.has(name));
      assert.deepEqual(
        unknown,
        [],
        `alerts/ftd-health.yaml references metric names that src/metrics/ does not declare: ${unknown.join(', ')}`,
      );
    });

    it('the alert unit tests reference no metric that does not exist', () => {
      const referenced = referencedMetricNames(ALERTS_TEST_YAML);
      assert.ok(referenced.length > 0, 'no ftd_* metric names found in the alert unit tests');
      const unknown = referenced.filter((name) => !declared.has(name));
      assert.deepEqual(unknown, [], `alerts/ftd-health.test.yaml: unknown ${unknown.join(', ')}`);
    });

    it('the dashboard references no metric that does not exist', () => {
      const referenced = referencedMetricNames(DASHBOARD_JSON);
      assert.ok(referenced.length > 0, 'no ftd_* metric names found in the dashboard');
      const unknown = referenced.filter((name) => !declared.has(name));
      assert.deepEqual(
        unknown,
        [],
        `dashboards/ftd-health.json references metric names that src/metrics/ does not declare: ${unknown.join(', ')}`,
      );
    });

    it('detects a renamed metric (negative control)', () => {
      // Proves the check above is not vacuous: the same comparison run against
      // a deliberately mutated copy must fail. Without this, a broken regex or
      // an empty `declared` set would make every assertion above pass silently.
      const mutated = DASHBOARD_JSON.replaceAll('ftd_cpu_usage_ratio', 'ftd_cpu_usage_percent');
      assert.notEqual(mutated, DASHBOARD_JSON, 'mutation did not apply — fixture assumption stale');
      const unknown = referencedMetricNames(mutated).filter((name) => !declared.has(name));
      assert.deepEqual(unknown, ['ftd_cpu_usage_percent']);
    });
  });

  describe('label cross-check', () => {
    const labels = declaredLabels();

    /**
     * Label selectors and legend/annotation templates are the second silent
     * failure mode: `{component="system"}` against a metric with no `component`
     * label matches nothing, and `{{device_name}}` in a legend on a self-metric
     * renders empty. Both look fine in review.
     */
    const cases: Array<{ metric: string; label: string; where: string }> = [
      { metric: 'ftd_cpu_usage_ratio', label: 'component', where: 'CPU alert + panels' },
      { metric: 'ftd_memory_usage_ratio', label: 'component', where: 'memory alert + panels' },
      { metric: 'ftd_cpu_usage_ratio', label: 'device_name', where: 'device template variable' },
      { metric: 'ftd_interface_operational_up', label: 'interface', where: 'named-iface filter' },
      {
        metric: 'ftd_interface_operational_up',
        label: 'interface_name',
        where: 'named-iface filter',
      },
      { metric: 'ftd_interface_operational_up', label: 'device_uid', where: 'unless on(...)' },
      { metric: 'ftd_interface_input_errors_avg', label: 'interface_name', where: 'errors alert' },
      { metric: 'ftd_ha_node_status', label: 'status', where: 'HA state-set alert' },
      { metric: 'ftd_ha_node_info', label: 'node_type', where: 'HA role table' },
      { metric: 'ftd_s2s_tunnel_state', label: 'state', where: 'tunnel-down alert' },
      { metric: 'ftd_s2s_tunnel_state', label: 'tunnel_name', where: 'tunnel-down annotation' },
      { metric: 'ftd_chassis_psu_input_up', label: 'psu', where: 'PSU alert' },
      { metric: 'ftd_chassis_psu_output_up', label: 'psu', where: 'PSU alert' },
      { metric: 'ftd_chassis_fan_rpm', label: 'fan', where: 'fan panel legend' },
      {
        metric: 'ftd_exporter_poll_errors_total',
        label: 'reason',
        where: 'errors-by-reason panel',
      },
      {
        metric: 'ftd_exporter_upstream_requests_total',
        label: 'status_code',
        where: 'upstream-by-status panel',
      },
      { metric: 'ftd_exporter_build_info', label: 'version', where: 'build-info table' },
      { metric: 'ftd_exporter_build_info', label: 'backend', where: 'build-info table' },
    ];

    for (const { metric, label, where } of cases) {
      it(`${metric} declares the ${label} label (used by: ${where})`, () => {
        const declaredFor = labels.get(metric);
        assert.ok(declaredFor !== undefined, `${metric} is not a declared metric`);
        assert.ok(
          declaredFor.has(label),
          `${metric} does not declare label "${label}" — ${where} would match nothing`,
        );
      });
    }

    it('exporter self-metrics carry no device labels', () => {
      // The reason every self-metric query in the dashboard is scoped with
      // job/instance only and never device_name: adding device_name there would
      // silently match nothing.
      for (const name of ['ftd_exporter_up', 'ftd_exporter_cache_age_seconds']) {
        const declaredFor = labels.get(name);
        assert.ok(declaredFor !== undefined);
        assert.ok(!declaredFor.has('device_name'), `${name} unexpectedly has a device_name label`);
      }
      assert.ok(
        !/ftd_exporter_[a-z_]*\{[^}]*device_name/.test(DASHBOARD_JSON),
        'a self-metric query in the dashboard filters on device_name, which matches nothing',
      );
      assert.ok(
        !/ftd_exporter_[a-z_]*\{[^}]*device_name/.test(ALERTS_YAML),
        'a self-metric query in the alerts filters on device_name, which matches nothing',
      );
    });
  });

  describe('enum label values used in queries are real', () => {
    /**
     * A state-set query hardcodes a label VALUE (`{status="normal"}`,
     * `{state="down"}`), and the rendered value is the lowercased enum from
     * src/domain/enums.ts. A query against `{status="NORMAL"}` or
     * `{state="TUNNEL_DOWN"}` is syntactically fine and permanently matches
     * nothing — the exact class of bug that makes a critical HA alert
     * unfireable.
     */
    it('HA status values queried in the alerts are rendered values', async () => {
      const { HA_NODE_STATUS_VALUES } = await import('../../src/domain/enums.ts');
      const rendered = new Set(HA_NODE_STATUS_VALUES.map((v) => v.toLowerCase()));
      for (const match of ALERTS_YAML.matchAll(/ftd_ha_node_status\{status="([^"]+)"/g)) {
        assert.ok(
          rendered.has(match[1] as string),
          `alerts query status="${match[1]}" which is not a rendered HA status value`,
        );
      }
      for (const match of DASHBOARD_JSON.matchAll(
        /ftd_ha_node_status\{[^}]*status=\\?"([^"\\]+)/g,
      )) {
        assert.ok(rendered.has(match[1] as string), `dashboard queries status="${match[1]}"`);
      }
    });

    it('tunnel state values queried are rendered values', async () => {
      const { tunnelStateLabel, TUNNEL_STATE_VALUES } = await import('../../src/domain/enums.ts');
      const rendered = new Set(TUNNEL_STATE_VALUES.map((v) => tunnelStateLabel(v)));
      const queried = [
        ...ALERTS_YAML.matchAll(/ftd_s2s_tunnel_state\{state="([^"]+)"/g),
        ...DASHBOARD_JSON.matchAll(/ftd_s2s_tunnel_state\{[^}]*state!?=\\?"([^"\\]+)/g),
      ].map((m) => m[1] as string);
      assert.ok(queried.length > 0, 'no tunnel-state queries found — regex or files are stale');
      for (const value of queried) {
        assert.ok(rendered.has(value), `queried tunnel state "${value}" is never rendered`);
      }
    });

    it('component label values queried are values the mappers emit', () => {
      // `component="system"` is load-bearing for FtdHighCpu/FtdHighMemory: a
      // typo makes both permanently unfireable with no other symptom.
      const queried = new Set(
        [
          ...ALERTS_YAML.matchAll(/component="([^"]+)"/g),
          ...DASHBOARD_JSON.matchAll(/component=\\?"([^"\\]+)/g),
        ].map((m) => m[1] as string),
      );
      assert.ok(queried.size > 0, 'no component selectors found');
      for (const value of queried) {
        assert.ok(
          ['system', 'lina', 'snort'].includes(value),
          `component="${value}" is not a component the CPU/memory mappers emit`,
        );
      }
    });
  });

  describe('the committed dashboard JSON matches its generator', () => {
    it('is byte-identical to scripts/generate-dashboard.ts output', () => {
      // The anti-drift guarantee the generator exists for. A dashboard edited
      // in the Grafana UI and pasted back in — rather than round-tripped
      // through the generator per docs/DASHBOARDS_AND_ALERTS.md — fails here.
      assert.equal(
        DASHBOARD_JSON,
        renderDashboardJson(),
        'dashboards/ftd-health.json is out of date — run: node --experimental-strip-types scripts/generate-dashboard.ts',
      );
    });
  });

  describe('dashboard structural requirements (DESIGN.md §10.1/§10.2)', () => {
    const dashboard = JSON.parse(DASHBOARD_JSON) as {
      uid: string;
      title: string;
      templating: { list: Array<{ name: string; type: string; query?: unknown }> };
      panels: Array<{
        id: number;
        type: string;
        title: string;
        description?: string;
        datasource?: { uid?: string };
        targets?: Array<{ expr: string; datasource?: { uid?: string } }>;
        fieldConfig?: { defaults?: Record<string, unknown> };
        gridPos: { h: number; w: number; x: number; y: number };
      }>;
    };

    const rows = dashboard.panels.filter((p) => p.type === 'row');
    const nonRowPanels = dashboard.panels.filter((p) => p.type !== 'row');

    it('has the eight rows DESIGN.md §10.2 specifies, in order', () => {
      assert.equal(rows.length, 8);
      const titles = rows.map((r) => r.title.toLowerCase());
      assert.match(titles[0] as string, /overview/);
      assert.match(titles[1] as string, /cpu|memory/);
      assert.match(titles[2] as string, /disk/);
      assert.match(titles[3] as string, /interface/);
      assert.match(titles[4] as string, /high availability|ha\b/);
      assert.match(titles[5] as string, /vpn/);
      assert.match(titles[6] as string, /chassis/);
      assert.match(titles[7] as string, /freshness|diagnostic/);
    });

    it('puts exporter health first and prominently (§10.2)', () => {
      // "A dashboard that looks green while the exporter is dead is the worst
      // possible outcome" — so the very first data panel must be an
      // exporter-health panel, not a device panel.
      const first = nonRowPanels[0];
      assert.ok(first !== undefined);
      assert.ok(
        first.targets?.some((t) => t.expr.includes('ftd_exporter_up')),
        `first panel is "${first.title}", which does not query ftd_exporter_up`,
      );
      assert.equal(first.gridPos.y, 1, 'the exporter-up panel is not at the very top of the grid');
    });

    it('every panel and every target uses the datasource variable', () => {
      for (const panel of nonRowPanels) {
        assert.equal(
          panel.datasource?.uid,
          DS_VAR,
          `panel "${panel.title}" does not use the datasource variable`,
        );
        for (const target of panel.targets ?? []) {
          assert.equal(
            target.datasource?.uid,
            DS_VAR,
            `a target on "${panel.title}" does not use the datasource variable`,
          );
        }
      }
    });

    it('hardcodes no datasource uid anywhere (§10.1: imports with no hand-editing)', () => {
      // Only `datasource.uid` occurrences count: the dashboard's own top-level
      // `uid` ("ftd-health") is its stable identity for provisioning and must
      // stay literal. The one legitimate literal datasource uid is Grafana's
      // built-in annotation source, which is not a Prometheus reference.
      const uids = [...DASHBOARD_JSON.matchAll(/"datasource":\s*\{[^}]*"uid":\s*"([^"]+)"/g)].map(
        (m) => m[1] as string,
      );
      assert.ok(uids.length > 0, 'no datasource uids found — regex is stale');
      const unexpected = uids.filter((uid) => uid !== DS_VAR && uid !== '-- Grafana --');
      assert.deepEqual(unexpected, [], `hardcoded datasource uid(s): ${unexpected.join(', ')}`);
      assert.equal(
        (JSON.parse(DASHBOARD_JSON) as { uid: string }).uid,
        'ftd-health',
        'the dashboard uid must stay stable for provisioning',
      );
    });

    it('declares the device/interface/job/instance template variables', () => {
      const names = dashboard.templating.list.map((v) => v.name);
      for (const required of ['DS_PROMETHEUS', 'job', 'instance', 'device', 'interface']) {
        assert.ok(names.includes(required), `missing template variable: ${required}`);
      }
      const ds = dashboard.templating.list.find((v) => v.name === 'DS_PROMETHEUS');
      assert.equal(ds?.type, 'datasource');
    });

    it('makes $interface depend on $device (testing step 5)', () => {
      const iface = dashboard.templating.list.find((v) => v.name === 'interface') as
        | { definition?: string }
        | undefined;
      assert.ok(iface?.definition !== undefined);
      assert.match(
        iface.definition,
        /device_name=~"\$device"/,
        'the interface variable does not filter on $device, so the cascade does not work',
      );
    });

    it('sources the device list from CPU, the one always-present group (§10.1)', () => {
      const device = dashboard.templating.list.find((v) => v.name === 'device') as
        | { definition?: string }
        | undefined;
      assert.ok(device?.definition !== undefined);
      assert.match(device.definition, /ftd_cpu_usage_ratio/);
      assert.match(device.definition, /device_name/);
    });

    it('every non-row panel has a description', () => {
      const missing = nonRowPanels
        .filter((p) => p.description === undefined || p.description.trim() === '')
        .map((p) => p.title);
      assert.deepEqual(missing, [], `panels without a description: ${missing.join(', ')}`);
    });

    it('every device-level query is scoped by the device template variable', () => {
      // A panel that ignores $device silently makes the variable decorative.
      for (const panel of nonRowPanels) {
        for (const target of panel.targets ?? []) {
          if (!/\bftd_(?!exporter_)/.test(target.expr)) continue;
          assert.match(
            target.expr,
            /device_name=~"\$device"/,
            `a device-level query on "${panel.title}" ignores $device: ${target.expr}`,
          );
        }
      }
    });

    it('every interface-level query is scoped by the interface template variable', () => {
      for (const panel of nonRowPanels) {
        for (const target of panel.targets ?? []) {
          if (!target.expr.includes('ftd_interface_')) continue;
          assert.match(
            target.expr,
            /interface=~"\$interface"/,
            `an interface query on "${panel.title}" ignores $interface`,
          );
        }
      }
    });

    it('conditional-group panels explain their own emptiness in the panel body', () => {
      // Testing step 3's graceful degradation: a hovering-only explanation is
      // not enough, the panel must say it in place of "No data" (noValue).
      // Deliberately checked on both the description and noValue, since the
      // description is what a reviewer reads and noValue is what an operator
      // sees.
      const conditional = nonRowPanels.filter((p) =>
        (p.targets ?? []).some((t) => /ftd_(ha_|ravpn_|s2s_|chassis_)/.test(t.expr)),
      );
      assert.ok(
        conditional.length >= 6,
        `expected conditional panels, found ${conditional.length}`,
      );
      for (const panel of conditional) {
        assert.match(
          panel.description ?? '',
          /expected|good case|good outcome/i,
          `conditional panel "${panel.title}" does not explain that emptiness is expected`,
        );
        const noValue = panel.fieldConfig?.defaults?.noValue;
        assert.equal(
          typeof noValue,
          'string',
          `conditional panel "${panel.title}" has no noValue text, so an appliance fleet just sees "No data"`,
        );
      }
    });

    it('ratio panels use percentunit, never percent (§14.13: values are 0-1)', () => {
      for (const panel of nonRowPanels) {
        // Only panels whose displayed value IS the ratio. A panel that counts
        // devices breaching a ratio threshold (`count(... > 0.85)`) renders a
        // device count, correctly in "short" — checking it for percentunit was
        // the test's own bug, not the dashboard's.
        const usesRatio = (panel.targets ?? []).some(
          (t) =>
            t.expr.includes('_usage_ratio') && !/\bcount\s*(\s*by\s*\([^)]*\)\s*)?\(/.test(t.expr),
        );
        if (!usesRatio) continue;
        const unit = panel.fieldConfig?.defaults?.unit;
        if (unit === undefined) continue;
        assert.equal(
          unit,
          'percentunit',
          `panel "${panel.title}" renders a 0-1 ratio with unit "${unit as string}" — percentunit is required or the axis is off by 100x`,
        );
      }
    });

    it('hedges the interface throughput units (§14.4 is unresolved)', () => {
      const throughput = nonRowPanels.find((p) =>
        (p.targets ?? []).some((t) => t.expr.includes('ftd_interface_input_bytes_avg')),
      );
      assert.ok(throughput !== undefined);
      assert.match(
        throughput.description ?? '',
        /§14\.4/,
        'the throughput panel does not carry the §14.4 unit caveat',
      );
    });

    it('no panel exceeds the 24-column grid or overlaps another', () => {
      const occupied = new Map<string, string>();
      for (const panel of dashboard.panels) {
        const { x, y, w, h } = panel.gridPos;
        assert.ok(x + w <= 24, `panel "${panel.title}" overflows the grid (x=${x} w=${w})`);
        for (let yy = y; yy < y + h; yy++) {
          for (let xx = x; xx < x + w; xx++) {
            const key = `${xx},${yy}`;
            const existing = occupied.get(key);
            assert.equal(
              existing,
              undefined,
              `panel "${panel.title}" overlaps "${existing}" at ${key}`,
            );
            occupied.set(key, panel.title);
          }
        }
      }
    });

    it('panel ids are unique', () => {
      const ids = dashboard.panels.map((p) => p.id);
      assert.equal(new Set(ids).size, ids.length, 'duplicate panel ids');
    });
  });

  describe('the named-interface filter is used consistently', () => {
    /**
     * The dashboard's "down interfaces" count and the FtdInterfaceDown alert
     * must agree, or an operator sees a dashboard reading 0 while a page fires
     * (or vice versa) — a support call with no code-level explanation.
     */
    it('the dashboard and the alerts use the same label_replace construct', () => {
      const construct = /unless on\(job, instance, device_uid, device_name, interface\)/;
      assert.match(ALERTS_EXPRESSIONS, construct);
      assert.match(DASHBOARD_JSON, construct);
      const dashboardUses = [...DASHBOARD_JSON.matchAll(/label_replace/g)].length;
      assert.ok(
        dashboardUses >= 2,
        'expected the named-interface filter on both the fleet stat and the per-device table',
      );
    });

    it('every use of the filter folds duplicate labelsets before label_replace', () => {
      // The fleet-wide silent-abort bug, as an invariant. label_replace
      // overwrites `interface`, so two interfaces on one device sharing an
      // `interface_name` mint an identical labelset and PromQL aborts the
      // ENTIRE rule/panel with "vector cannot contain metrics with the same
      // labelset" — every device goes unalerted, not just the colliding pair,
      // and the colliding interfaces need not even be down. Reproduced against
      // real promtool and a real Prometheus before this guard was added.
      const fold = /max by \(job, instance, device_uid, device_name, interface_name\) \(/;
      for (const [label, text] of [
        ['alerts', ALERTS_EXPRESSIONS],
        ['dashboard', DASHBOARD_JSON],
      ] as const) {
        const uses = [...text.matchAll(/label_replace/g)].length;
        const folds = [...text.matchAll(new RegExp(fold.source, 'g'))].length;
        assert.equal(
          folds,
          uses,
          `${label}: ${uses} label_replace uses but ${folds} max-by folds — an unfolded one aborts fleet-wide`,
        );
      }
    });

    it('the filter matches per-exporter, never across instances', () => {
      // Without job/instance in the `unless on(...)` list, two exporters
      // scraping one device match each other: the one reporting DESIGN.md
      // §4.3's hardware-id fallback suppresses the other's genuine alert.
      assert.ok(
        !/unless on\(device_uid, ?interface\)/.test(ALERTS_EXPRESSIONS),
        'the filter omits job/instance — a second exporter silences real alerts',
      );
      assert.ok(
        !/unless on\(device_uid, ?interface\)/.test(DASHBOARD_JSON),
        'the dashboard filter omits job/instance — see the alerts assertion above',
      );
    });

    it('the filter matches per-device-name, never across an HA pair sharing one device_uid', () => {
      // Review finding: on SCC, both nodes of an HA pair report the SAME
      // device_uid (DESIGN.md §14.14, confirmed live). Without device_name
      // in both the `unless on(...)` list and the `max by (...)` fold, an
      // unnamed interface on one peer can suppress a genuinely-down NAMED
      // interface on the other peer at the same hardware id.
      assert.ok(
        !/unless on\(job, instance, device_uid, interface\)(?!,)/.test(ALERTS_EXPRESSIONS),
        'the alerts filter omits device_name — an HA pair sharing one device_uid can suppress across peers',
      );
      assert.ok(
        !/unless on\(job, instance, device_uid, interface\)(?!,)/.test(DASHBOARD_JSON),
        'the dashboard filter omits device_name — see the alerts assertion above',
      );
      assert.ok(
        !/max by \(job, instance, device_uid, interface_name\) \(/.test(ALERTS_EXPRESSIONS),
        'the alerts max-by fold omits device_name — see above',
      );
      assert.ok(
        !/max by \(job, instance, device_uid, interface_name\) \(/.test(DASHBOARD_JSON),
        'the dashboard max-by fold omits device_name — see above',
      );
    });

    it('the down-interface alert does not use the naive interface_name != "" filter', () => {
      // The filter the plan explicitly identified as wrong: DESIGN.md §4.3's
      // fallback means interface_name is never empty, so this matches every
      // interface including unused ones.
      assert.ok(
        !/interface_name\s*!=\s*""/.test(ALERTS_EXPRESSIONS),
        'the alerts use interface_name != "", which never excludes anything (DESIGN.md §4.3)',
      );
      // The rejected filter is still expected to appear in the comments, where
      // the decision is recorded — asserted so this check can never be
      // "fixed" by deleting the rationale.
      assert.match(ALERTS_YAML, /interface_name != ""/);
    });
  });

  describe('distinct-device counts group by device_uid AND device_name', () => {
    /**
     * SCC's live behavior, confirmed against a real HA pair: both nodes of an
     * HA pair share one `device_uid` (only `device_name` differs — see
     * DESIGN.md §2.3's device_uid caveat). Any aggregation meant to count
     * distinct *devices* that groups by `device_uid` alone silently collapses
     * two different HA peers breaching different thresholds into one.
     */
    it('the "unhealthy devices" panel groups by device_uid and device_name together', () => {
      // DASHBOARD_JSON is the raw JSON *text*: the panel's real newline is
      // encoded as the two literal characters `\` + `n`, not an actual
      // newline byte, so the pattern below matches that literal escape.
      assert.match(
        DASHBOARD_JSON,
        /count by \(device_uid, device_name\) \(\\n\s*\(ftd_cpu_usage_ratio/,
      );
    });

    it('no panel or alert aggregates distinct devices by device_uid alone', () => {
      // A bare `count by (device_uid)` / `count(count by (device_uid) (` with no
      // trailing `, device_name)` is the exact regression this guards: it
      // compiles, runs, and silently undercounts only once a real HA pair
      // exists to expose it. `interface`-scoped aggregations are exempt —
      // they legitimately group by (device_uid, interface) or similar for a
      // different reason (per-interface identity, not per-device counting)
      // and already carry other disambiguating labels.
      const bareDeviceUidGroup = /count by \(device_uid\)(?!\s*,)/;
      assert.ok(
        !bareDeviceUidGroup.test(DASHBOARD_JSON),
        'dashboard aggregates by device_uid alone somewhere — HA pairs share one device_uid',
      );
      assert.ok(
        !bareDeviceUidGroup.test(ALERTS_EXPRESSIONS),
        'alerts aggregate by device_uid alone somewhere — HA pairs share one device_uid',
      );
    });

    it('detects a regression to the bare form (negative control)', () => {
      const mutated = DASHBOARD_JSON.replace(
        'count by (device_uid, device_name) (\\n  (ftd_cpu_usage_ratio',
        'count by (device_uid) (\\n  (ftd_cpu_usage_ratio',
      );
      assert.notEqual(
        mutated,
        DASHBOARD_JSON,
        'mutation did not apply — panel text changed upstream',
      );
      assert.match(mutated, /count by \(device_uid\)(?!\s*,)/);
    });
  });

  describe('alert-rule invariants', () => {
    it('every rule has a severity label and both annotations', () => {
      // Structural, without a YAML parser: each `- alert:` block must be
      // followed by severity/summary/description before the next one starts.
      const blocks = ALERTS_EXPRESSIONS.split(/^\s+- alert: /m).slice(1);
      assert.ok(blocks.length >= 13, `expected at least 13 rules, found ${blocks.length}`);
      for (const block of blocks) {
        const name = (block.split('\n')[0] ?? '').trim();
        assert.match(block, /severity: (critical|warning|info)/, `${name}: no severity label`);
        assert.match(block, /summary:/, `${name}: no summary annotation`);
        assert.match(block, /description:/, `${name}: no description annotation`);
      }
    });

    it('thresholds are on the 0-1 ratio scale, never 0-100 (§14.13)', () => {
      // `> 85` against a 0-1 ratio can never fire. This is the single most
      // likely silent bug in the whole rule file.
      for (const match of ALERTS_EXPRESSIONS.matchAll(
        /ftd_(?:cpu|memory|disk)_usage_ratio[^\n]*?>\s*([0-9.]+)/g,
      )) {
        const threshold = Number(match[1]);
        assert.ok(
          threshold > 0 && threshold <= 1,
          `ratio threshold ${threshold} is outside 0-1 — a 0-100 threshold can never fire`,
        );
      }
    });

    // Comment-stripped: the rule file's own comments quote expression
    // fragments, which would otherwise land in the wrong block after splitting.
    const staleBlock =
      ALERTS_EXPRESSIONS.split('- alert: FtdExporterStale')[1]?.split('- alert:')[0] ?? '';

    it('FtdExporterStale guards against the gauge being 0 before the first poll', () => {
      assert.notEqual(staleBlock, '', 'FtdExporterStale not found');
      assert.match(
        staleBlock,
        /ftd_exporter_last_successful_poll_timestamp_seconds > 0/,
        'without the > 0 guard this rule fires on every exporter start',
      );
    });

    it('FtdExporterStale reports the staleness gap, not the raw timestamp', () => {
      // PromQL's `and` returns the LEFT operand's value, so the time()
      // subtraction has to be on the left or {{ $value }} becomes a unix
      // timestamp rendered as "1m 0s ago". Caught once for real by promtool.
      const expr = staleBlock.split('for:')[0] ?? '';
      const timeIndex = expr.indexOf('time() -');
      const andIndex = expr.search(/^\s+and$/m);
      assert.ok(timeIndex >= 0, 'the time() subtraction is gone from FtdExporterStale');
      assert.ok(andIndex >= 0, 'the `and` guard is gone from FtdExporterStale');
      assert.ok(
        timeIndex < andIndex,
        'the time() subtraction must be the left operand of `and`, or $value is the raw timestamp',
      );
    });

    it('at least one rule is built on `up`, not an ftd_* series', () => {
      // The dead-exporter gap, as an invariant rather than a one-off rule
      // check. Every ftd_*-based rule goes silent when the exporter process
      // dies, because an instant-vector comparison against a series that no
      // longer exists matches nothing — verified against a live Prometheus,
      // where killing the exporter left /api/v1/alerts completely empty. So the
      // rule set needs at least one rule whose expression does not depend on
      // the exporter answering at all, and Prometheus's own `up` is the only
      // such signal available here.
      assert.match(
        ALERTS_EXPRESSIONS,
        /expr: up\{job=/,
        'no rule is built on `up` — if the exporter dies, every rule here is silent',
      );
    });

    it('the `up`-based rule is scoped to a job, never a bare up == 0', () => {
      // A bare `up == 0` fires for every unrelated down target in the cluster,
      // which is how a rule gets routed to a muted channel and stops being
      // read. This is the one rule in the file that cannot be job-agnostic.
      assert.ok(
        !/expr: up\s*==/.test(ALERTS_EXPRESSIONS),
        'a bare `up == 0` fires for every down target in the cluster, not just this exporter',
      );
    });

    it('every rule that can flap carries a `for` duration', () => {
      const blocks = ALERTS_EXPRESSIONS.split(/^\s+- alert: /m).slice(1);
      const withoutFor = blocks
        .filter((b) => !/^\s+for: /m.test(b))
        .map((b) => (b.split('\n')[0] ?? '').trim());
      // FtdExporterInsecureTls is the one deliberate exception: it is set at
      // startup and cannot clear on its own, so a `for` only delays it.
      assert.deepEqual(withoutFor, ['FtdExporterInsecureTls']);
    });
  });
});
