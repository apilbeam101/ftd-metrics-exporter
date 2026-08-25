import * as http from 'node:http';
import type { DeviceCertificateEntry } from '../src/domain/certificate-status.ts';
import type { DeviceInventoryEntry } from '../src/domain/device-inventory.ts';
import type { LicenseStatus } from '../src/domain/license-status.ts';
import type { DeviceHealthSnapshot } from '../src/domain/snapshot.ts';
import { renderCertificateMetrics } from '../src/metrics/certificate-collector.ts';
import { createCertificateMetrics } from '../src/metrics/certificate-metrics.ts';
import { renderDeviceMetrics } from '../src/metrics/collector.ts';
import { createDeviceMetrics } from '../src/metrics/device-metrics.ts';
import { renderDeviceInventoryMetrics } from '../src/metrics/inventory-collector.ts';
import { createDeviceInventoryMetrics } from '../src/metrics/inventory-metrics.ts';
import { renderLicenseMetrics } from '../src/metrics/license-collector.ts';
import { createLicenseMetrics } from '../src/metrics/license-metrics.ts';
import { createRegistry } from '../src/metrics/registry.ts';
import { createSelfMetrics } from '../src/metrics/self.ts';

/**
 * Fabricates a full-coverage fleet (chassis/HA/RA VPN/S2S VPN/license/
 * certificates/inventory all present at once, which no single real device or
 * tenant in this project's live testing has shown together) and serves it
 * as real `/metrics` output, built through the same render*Metrics functions
 * production uses -- never hand-typed exposition text -- so the rendered
 * names/labels/types can't drift from the real metric surface. Exists only
 * to produce public-facing dashboard screenshots without exposing real
 * tenant/device data. Not shipped, not imported by src/.
 */

const START = Date.now();
const elapsedSeconds = (): number => (Date.now() - START) / 1000;

function wiggle(base: number, amplitude: number, periodSeconds: number, phase = 0): number {
  return base + amplitude * Math.sin((2 * Math.PI * elapsedSeconds()) / periodSeconds + phase);
}

function buildSnapshots(): DeviceHealthSnapshot[] {
  const now = new Date();
  const windowStart = new Date(now.getTime() - 5 * 60 * 1000);

  return [
    {
      deviceUid: '10000000-0000-4000-8000-000000000001',
      deviceName: 'ftd-hq-edge-01',
      windowStart,
      windowEnd: now,
      cpu: { lina: wiggle(18, 4, 90), snort: wiggle(9, 3, 70, 1), system: wiggle(22, 4, 90) },
      memory: {
        lina: wiggle(38, 2, 120),
        snort: wiggle(24, 2, 110, 2),
        system: wiggle(41, 2, 120),
      },
      disk: { totalUsagePercent: wiggle(31, 1, 300) },
      chassis: {
        fans: [
          { fan: '1', rpmAvg: wiggle(4200, 60, 40) },
          { fan: '2', rpmAvg: wiggle(4150, 60, 40, 1) },
          { fan: '3', rpmAvg: wiggle(4180, 60, 40, 2) },
          { fan: '4', rpmAvg: wiggle(4190, 60, 40, 3) },
        ],
        psus: [
          { psu: '1', fanStatus: 'UP', inputStatus: 'UP', outputStatus: 'UP' },
          { psu: '2', fanStatus: 'UP', inputStatus: 'UP', outputStatus: 'UP' },
        ],
      },
      interfaces: [
        {
          interface: 'Ethernet1/1',
          interfaceName: 'outside',
          interfaceType: 'Ethernet',
          linkStatus: 'UP',
          operationalStatus: 'UP',
          duplexMode: 'FULL',
          inputBytesAvg: Math.round(wiggle(52_000_000_000, 2_000_000_000, 60)),
          outputBytesAvg: Math.round(wiggle(34_000_000_000, 1_500_000_000, 60, 1)),
          inputPacketSizeAvg: 512,
          outputPacketSizeAvg: 470,
          inputErrorsAvg: 0,
          outputErrorsAvg: 0,
          dropPacketsAvg: 0,
          bufferOverrunsAvg: 0,
          bufferUnderrunsAvg: 0,
          l2DecodeDropsAvg: 0,
        },
        {
          interface: 'Ethernet1/2',
          interfaceName: 'inside',
          interfaceType: 'Ethernet',
          linkStatus: 'UP',
          operationalStatus: 'UP',
          duplexMode: 'FULL',
          inputBytesAvg: Math.round(wiggle(28_000_000_000, 1_000_000_000, 55, 2)),
          outputBytesAvg: Math.round(wiggle(41_000_000_000, 1_200_000_000, 55, 3)),
          inputPacketSizeAvg: 600,
          outputPacketSizeAvg: 590,
          inputErrorsAvg: 0,
          outputErrorsAvg: 0,
          dropPacketsAvg: 0,
        },
        {
          interface: 'Ethernet1/3',
          interfaceName: 'dmz',
          interfaceType: 'Ethernet',
          linkStatus: 'UP',
          operationalStatus: 'UP',
          duplexMode: 'FULL',
          inputBytesAvg: Math.round(wiggle(3_000_000_000, 200_000_000, 55)),
          outputBytesAvg: Math.round(wiggle(1_800_000_000, 150_000_000, 55)),
        },
        {
          interface: 'Ethernet1/4',
          interfaceName: 'Ethernet1/4',
          interfaceType: 'Ethernet',
          linkStatus: 'DOWN',
          operationalStatus: 'DOWN',
        },
      ],
    },
    {
      deviceUid: '10000000-0000-4000-8000-000000000002',
      deviceName: 'ftd-hq-edge-02',
      windowStart,
      windowEnd: now,
      cpu: { lina: wiggle(61, 6, 80), snort: wiggle(48, 6, 65, 1), system: wiggle(72, 5, 80) },
      memory: { lina: wiggle(70, 3, 100), snort: wiggle(58, 3, 95, 1), system: wiggle(88, 2, 100) },
      disk: { totalUsagePercent: wiggle(93, 1, 300) },
      chassis: {
        fans: [
          { fan: '1', rpmAvg: wiggle(4100, 60, 42) },
          { fan: '2', rpmAvg: wiggle(4050, 60, 42, 1) },
        ],
        psus: [
          { psu: '1', fanStatus: 'UP', inputStatus: 'UP', outputStatus: 'UP' },
          { psu: '2', fanStatus: 'UP', inputStatus: 'UP', outputStatus: 'DOWN' },
        ],
      },
      interfaces: [
        {
          interface: 'Ethernet1/1',
          interfaceName: 'outside',
          interfaceType: 'Ethernet',
          linkStatus: 'UP',
          operationalStatus: 'UP',
          duplexMode: 'FULL',
          inputBytesAvg: Math.round(wiggle(19_000_000_000, 800_000_000, 58)),
          outputBytesAvg: Math.round(wiggle(12_000_000_000, 600_000_000, 58)),
          inputErrorsAvg: Math.round(wiggle(4, 3, 30)),
          outputErrorsAvg: 0,
          dropPacketsAvg: Math.round(wiggle(120, 40, 30)),
        },
        {
          interface: 'Ethernet1/2',
          interfaceName: 'inside',
          interfaceType: 'Ethernet',
          linkStatus: 'UP',
          operationalStatus: 'UP',
          duplexMode: 'FULL',
          inputBytesAvg: Math.round(wiggle(22_000_000_000, 900_000_000, 58, 1)),
          outputBytesAvg: Math.round(wiggle(17_000_000_000, 700_000_000, 58, 1)),
        },
        {
          interface: 'Ethernet1/3',
          interfaceName: 'guest-net',
          interfaceType: 'Ethernet',
          linkStatus: 'DOWN',
          operationalStatus: 'DOWN',
        },
      ],
    },
    {
      deviceUid: '10000000-0000-4000-8000-000000000003',
      deviceName: 'ftd-dc-ha-primary',
      windowStart,
      windowEnd: now,
      cpu: { lina: wiggle(24, 3, 95), system: wiggle(29, 3, 95) },
      memory: { lina: wiggle(44, 2, 110), system: wiggle(52, 2, 110) },
      disk: { totalUsagePercent: wiggle(27, 1, 300) },
      ha: { nodeStatus: 'NORMAL', nodeType: 'PRIMARY' },
      raVpn: {
        activeSessionsAvg: Math.round(wiggle(212, 15, 50)),
        inactiveSessionsAvg: Math.round(wiggle(9, 3, 50, 1)),
        peakConcurrentSessions: 268,
      },
      interfaces: [
        {
          interface: 'Ethernet1/1',
          interfaceName: 'outside',
          interfaceType: 'Ethernet',
          linkStatus: 'UP',
          operationalStatus: 'UP',
          inputBytesAvg: Math.round(wiggle(8_000_000_000, 400_000_000, 66)),
          outputBytesAvg: Math.round(wiggle(6_000_000_000, 300_000_000, 66)),
        },
      ],
    },
    {
      deviceUid: '10000000-0000-4000-8000-000000000003',
      deviceName: 'ftd-dc-ha-secondary',
      windowStart,
      windowEnd: now,
      cpu: { lina: wiggle(21, 3, 95, 1), system: wiggle(26, 3, 95, 1) },
      memory: { lina: wiggle(43, 2, 110, 1), system: wiggle(50, 2, 110, 1) },
      disk: { totalUsagePercent: wiggle(27, 1, 300, 1) },
      ha: { nodeStatus: 'NORMAL', nodeType: 'SECONDARY' },
      interfaces: [
        {
          interface: 'Ethernet1/1',
          interfaceName: 'outside',
          interfaceType: 'Ethernet',
          linkStatus: 'UP',
          operationalStatus: 'UP',
          inputBytesAvg: Math.round(wiggle(300_000_000, 30_000_000, 66)),
          outputBytesAvg: Math.round(wiggle(210_000_000, 20_000_000, 66)),
        },
      ],
    },
    {
      deviceUid: '10000000-0000-4000-8000-000000000005',
      deviceName: 'ftd-branch-05',
      windowStart,
      windowEnd: now,
      cpu: { lina: wiggle(12, 2, 75), system: wiggle(15, 2, 75) },
      memory: { lina: wiggle(30, 2, 105), system: wiggle(35, 2, 105) },
      disk: { totalUsagePercent: wiggle(19, 1, 300) },
      s2sTunnels: [
        { tunnelId: 'tunnel-1', tunnelName: 'branch05-to-hq', tunnelState: 'TUNNEL_UP' },
        { tunnelId: 'tunnel-2', tunnelName: 'branch05-to-dr-site', tunnelState: 'TUNNEL_DOWN' },
      ],
      interfaces: [
        {
          interface: 'Ethernet1/1',
          interfaceName: 'outside',
          interfaceType: 'Ethernet',
          linkStatus: 'UP',
          operationalStatus: 'UP',
          inputBytesAvg: Math.round(wiggle(900_000_000, 80_000_000, 62)),
          outputBytesAvg: Math.round(wiggle(650_000_000, 60_000_000, 62)),
        },
      ],
    },
  ];
}

function buildInventory(): DeviceInventoryEntry[] {
  return [
    {
      deviceUid: '10000000-0000-4000-8000-000000000001',
      deviceName: 'ftd-hq-edge-01',
      connectivityState: 'ONLINE',
      redundancyMode: 'STANDALONE',
    },
    {
      deviceUid: '10000000-0000-4000-8000-000000000002',
      deviceName: 'ftd-hq-edge-02',
      connectivityState: 'ONLINE',
      redundancyMode: 'STANDALONE',
    },
    {
      deviceUid: '10000000-0000-4000-8000-000000000003',
      deviceName: 'ftd-dc-ha-primary',
      connectivityState: 'ONLINE',
      redundancyMode: 'HA',
    },
    {
      deviceUid: '10000000-0000-4000-8000-000000000005',
      deviceName: 'ftd-branch-05',
      connectivityState: 'ONLINE',
      redundancyMode: 'STANDALONE',
    },
    {
      // Absent from every ftd_* health series entirely -- the exact gap
      // ftd_device_connectivity_up was built to close (DESIGN.md §4.6.1).
      deviceUid: '10000000-0000-4000-8000-000000000006',
      deviceName: 'ftd-branch-06',
      connectivityState: 'UNREACHABLE',
      redundancyMode: 'STANDALONE',
    },
  ];
}

function buildLicense(): LicenseStatus {
  return {
    regStatus: 'REGISTERED',
    authStatus: 'AUTHORIZED',
    evalUsed: false,
    lastSynchronizedTime: new Date(Date.now() - 8 * 60 * 1000),
    lastRenewedTime: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000),
  };
}

function buildCertificates(): DeviceCertificateEntry[] {
  const soon = new Date(Date.now() + 25 * 24 * 60 * 60 * 1000);
  const far = new Date(Date.now() + 320 * 24 * 60 * 60 * 1000);
  return [
    {
      deviceUid: '10000000-0000-4000-8000-000000000001',
      deviceName: 'ftd-hq-edge-01',
      certName: 'ftd-hq-edge-01-identity',
      certType: 'identity',
      status: 'AVAILABLE',
      expiresAt: far,
    },
    {
      deviceUid: '10000000-0000-4000-8000-000000000001',
      deviceName: 'ftd-hq-edge-01',
      certName: 'ftd-hq-edge-01-identity',
      certType: 'ca',
      status: 'AVAILABLE',
      expiresAt: far,
    },
    {
      deviceUid: '10000000-0000-4000-8000-000000000002',
      deviceName: 'ftd-hq-edge-02',
      certName: 'ftd-hq-edge-02-identity',
      certType: 'identity',
      status: 'AVAILABLE',
      expiresAt: soon,
    },
    {
      deviceUid: '10000000-0000-4000-8000-000000000003',
      deviceName: 'ftd-dc-ha-primary',
      certName: 'ftd-dc-ha-identity',
      certType: 'identity',
      status: 'AVAILABLE',
      expiresAt: far,
    },
  ];
}

const registry = createRegistry(true);
const deviceMetrics = createDeviceMetrics(registry);
const deviceInventoryMetrics = createDeviceInventoryMetrics(registry);
const licenseMetrics = createLicenseMetrics(registry);
const certificateMetrics = createCertificateMetrics(registry);
const selfMetrics = createSelfMetrics(registry, {
  cacheAgeSecondsCollect: () => wiggle(12, 8, 60),
});

selfMetrics.buildInfo.set(
  { version: '0.2.0', commit: 'demo', node_version: process.version, backend: 'scc' },
  1,
);
selfMetrics.tlsVerificationDisabled.set(0);

function render(): void {
  const healthResult = renderDeviceMetrics(
    {
      metrics: deviceMetrics,
      unknownEnumTotal: selfMetrics.unknownEnumTotal,
      series: selfMetrics.series,
    },
    buildSnapshots(),
  );
  const inventoryResult = renderDeviceInventoryMetrics(
    { metrics: deviceInventoryMetrics, unknownEnumTotal: selfMetrics.unknownEnumTotal },
    buildInventory(),
  );
  renderLicenseMetrics(
    { metrics: licenseMetrics, unknownEnumTotal: selfMetrics.unknownEnumTotal },
    buildLicense(),
  );
  renderCertificateMetrics(
    { metrics: certificateMetrics, unknownEnumTotal: selfMetrics.unknownEnumTotal },
    buildCertificates(),
  );
  selfMetrics.series.set(healthResult.seriesCount + inventoryResult.seriesCount);

  const elapsed = elapsedSeconds();
  selfMetrics.up.set(1);
  selfMetrics.devices.set(5);
  selfMetrics.lastSuccessfulPollTimestampSeconds.set(Date.now() / 1000);
  selfMetrics.pollTotal.reset();
  selfMetrics.pollTotal.inc(1200 + Math.floor(elapsed / 60));
  selfMetrics.pollErrorsTotal.reset();
  selfMetrics.pollErrorsTotal.inc({ reason: 'rate_limited' }, 3);
  selfMetrics.rateLimitDeferralsTotal.reset();
  selfMetrics.rateLimitDeferralsTotal.inc(2);
  selfMetrics.upstreamRequestsTotal.reset();
  selfMetrics.upstreamRequestsTotal.inc(
    { endpoint: '/health/metrics', status_code: '200' },
    1200 + Math.floor(elapsed / 60),
  );
  selfMetrics.upstreamRequestsTotal.inc({ endpoint: '/health/metrics', status_code: '429' }, 3);
  selfMetrics.pollDurationSeconds.observe(0.6 + Math.random() * 0.4);
  selfMetrics.upstreamRequestDurationSeconds.observe(
    { endpoint: '/health/metrics' },
    0.4 + Math.random() * 0.3,
  );
}

const port = Number(process.env.METRICS_PORT ?? 10049);
const bindAddress = process.env.METRICS_BIND_ADDRESS ?? '0.0.0.0';

const server = http.createServer((req, res) => {
  if (req.url === '/healthz' || req.url === '/readyz') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
    return;
  }
  if (req.url === '/metrics') {
    render();
    registry
      .metrics()
      .then((body) => {
        res.writeHead(200, { 'content-type': registry.contentType });
        res.end(body);
      })
      .catch((err: unknown) => {
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end(String(err));
      });
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found');
});

server.listen(port, bindAddress, () => {
  // biome-ignore lint/suspicious/noConsole: offline dev script, not shipped -- its own startup log.
  console.error(`demo metrics server listening on ${bindAddress}:${port}`);
});
