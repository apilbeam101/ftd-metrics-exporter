/**
 * Regenerates docs/METRICS.md from the actual metric declarations in
 * src/metrics/device-metrics.ts and src/metrics/self.ts (IMPLEMENTATION_PLAN.md
 * Stage 3 scope: "worth generating from the declarations so it cannot
 * drift"). Reads name/help/type/labels directly off the constructed
 * prom-client metrics — the same objects renderDeviceMetrics writes to —
 * so this file cannot silently fall out of sync with the actual /metrics
 * output the way a hand-maintained table could.
 *
 * Not part of the shipped package; run manually after changing a metric
 * declaration: node --experimental-strip-types scripts/generate-metrics-doc.ts
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Counter, Gauge, Histogram, Registry } from 'prom-client';
import { allDeviceGauges, createDeviceMetrics } from '../src/metrics/device-metrics.ts';
import { createRegistry } from '../src/metrics/registry.ts';
import { createSelfMetrics } from '../src/metrics/self.ts';

type AnyMetric = Gauge<string> | Counter<string> | Histogram<string>;

function describe(metric: AnyMetric): { name: string; help: string; type: string; labels: string } {
  const asRecord = metric as unknown as {
    name: string;
    help: string;
    type: string;
    labelNames: string[];
  };
  const labels = asRecord.labelNames.length > 0 ? asRecord.labelNames.join(', ') : '(none)';
  return { name: asRecord.name, help: asRecord.help, type: asRecord.type, labels };
}

function renderTable(metrics: AnyMetric[]): string {
  const rows = metrics
    .map(describe)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((m) => `| \`${m.name}\` | ${m.type} | ${m.labels} | ${m.help} |`);
  return ['| Metric | Type | Labels | Description |', '|---|---|---|---|', ...rows].join('\n');
}

const registry: Registry = createRegistry(false);
const deviceMetrics = createDeviceMetrics(registry);
const selfMetrics = createSelfMetrics(registry);

const deviceTable = renderTable(allDeviceGauges(deviceMetrics));
const selfTable = renderTable(Object.values(selfMetrics));

const doc = `# Metric reference

Generated from \`src/metrics/device-metrics.ts\` and \`src/metrics/self.ts\` by
\`scripts/generate-metrics-doc.ts\`. Do not hand-edit the tables below —
regenerate instead. For the full design rationale and the metric-surface
stability contract, see [DESIGN.md](DESIGN.md).

## Device health metrics (\`ftd_*\`)

Conditional groups (\`ftd_chassis_*\`, \`ftd_ha_*\`, \`ftd_ravpn_*\`, \`ftd_s2s_*\`) are
emitted only when the corresponding upstream data is present for a device —
never as zero, never as \`NaN\`.

${deviceTable}

## Exporter self-metrics (\`ftd_exporter_*\`)

${selfTable}
`;

const outPath = fileURLToPath(new URL('../docs/METRICS.md', import.meta.url));
writeFileSync(outPath, doc);
process.stdout.write(`wrote ${outPath}\n`);
