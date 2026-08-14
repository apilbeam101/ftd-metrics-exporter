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
import {
  allCertificateGauges,
  createCertificateMetrics,
} from '../src/metrics/certificate-metrics.ts';
import { allDeviceGauges, createDeviceMetrics } from '../src/metrics/device-metrics.ts';
import {
  allDeviceInventoryGauges,
  createDeviceInventoryMetrics,
} from '../src/metrics/inventory-metrics.ts';
import { createLicenseMetrics } from '../src/metrics/license-metrics.ts';
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
const deviceInventoryMetrics = createDeviceInventoryMetrics(registry);
const licenseMetrics = createLicenseMetrics(registry);
const certificateMetrics = createCertificateMetrics(registry);
const selfMetrics = createSelfMetrics(registry);

const deviceTable = renderTable(allDeviceGauges(deviceMetrics));
const deviceInventoryTable = renderTable(allDeviceInventoryGauges(deviceInventoryMetrics));
const licenseTable = renderTable(Object.values(licenseMetrics));
const certificateTable = renderTable(allCertificateGauges(certificateMetrics));
const selfTable = renderTable(Object.values(selfMetrics));

const doc = `# Metric reference

Generated from \`src/metrics/device-metrics.ts\`, \`src/metrics/inventory-metrics.ts\`,
\`src/metrics/license-metrics.ts\`, \`src/metrics/certificate-metrics.ts\`, and
\`src/metrics/self.ts\` by \`scripts/generate-metrics-doc.ts\`. Do not hand-edit the tables below —
regenerate instead. For the full design rationale and the metric-surface
stability contract, see [DESIGN.md](DESIGN.md).

## Device health metrics (\`ftd_*\`)

Conditional groups (\`ftd_chassis_*\`, \`ftd_ha_*\`, \`ftd_ravpn_*\`, \`ftd_s2s_*\`) are
emitted only when the corresponding upstream data is present for a device —
never as zero, never as \`NaN\`.

${deviceTable}

## Device inventory metrics (\`ftd_device_*\`, SCC only)

From SCC's device inventory (DESIGN.md §14.6), on its own poll cadence independent of
the health-metrics poll above — populated even for a device absent from every other
\`ftd_*\` series (e.g. one SCC reports UNREACHABLE). Not available on the FMC backend,
which has no equivalent inventory endpoint wired up.

${deviceInventoryTable}

## Smart License status metrics (\`ftd_license_*\`, both backends)

DESIGN.md §4.6.2. Fleet/manager-scoped — the upstream response carries no device
identifier at all, so unlike every other metric group in this project, none of these
gauges carry \`device_uid\`/\`device_name\` labels. On its own poll cadence, independent
of every other poll.

${licenseTable}

## Certificate status metrics (\`ftd_certificate_*\`, both backends)

DESIGN.md §4.6.2. Per enrolled certificate's CA/identity component. A component
reported \`NOT_APPLICABLE\` upstream (e.g. a self-signed certificate has no CA
component) is omitted entirely, never rendered as zero. On its own poll cadence,
independent of every other poll.

${certificateTable}

## Exporter self-metrics (\`ftd_exporter_*\`)

${selfTable}
`;

const outPath = fileURLToPath(new URL('../docs/METRICS.md', import.meta.url));
writeFileSync(outPath, doc);
process.stdout.write(`wrote ${outPath}\n`);
