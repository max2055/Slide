import { describe, expect, it } from 'vitest';

import { HuaweiAdapter } from './huawei-adapter.js';
import { createHuaweiMibCatalog } from './huawei-mib-catalog.js';
import type { SnmpV3Config, SnmpVarbind } from './snmp-types.js';

const config: SnmpV3Config = {
  host: '192.0.2.10', port: 161, username: 'monitor', securityLevel: 'authPriv',
  authProtocol: 'SHA', authSecret: 'auth-secret-123', privacyProtocol: 'AES', privacySecret: 'priv-secret-123',
};

const fixture = createHuaweiMibCatalog({
  fixtureVersion: 'vrp-test-1', firmwarePattern: '^V8R21',
  vendorMetrics: {
    cpu: { oid: '1.3.6.1.4.1.2011.6.3.1.1.4.1.5.0', unit: 'percent', scale: 1 },
    memory: { oid: '1.3.6.1.4.1.2011.6.3.1.1.4.1.7.0', unit: 'percent', scale: 0.1 },
    temperature: { oid: '1.3.6.1.4.1.2011.6.3.15.1.1.6.1', unit: 'celsius', scale: 0.1 },
  },
});

function vb(oid: string, value: unknown, type = 'Integer'): SnmpVarbind { return { oid, value, type }; }

describe('HuaweiAdapter', () => {
  it('normalizes uptime and fixture-backed system metrics with units', async () => {
    const client = {
      get: async () => [
        vb(fixture.scalars.sysUpTime.oid, 12345, 'TimeTicks'),
        vb(fixture.scalars.sysName.oid, 'edge-1', 'OctetString'),
        vb(fixture.vendorMetrics.cpu!.oid, 42),
        vb(fixture.vendorMetrics.memory!.oid, 655),
        vb(fixture.vendorMetrics.temperature!.oid, 375),
      ],
      table: async () => [],
    };
    const adapter = new HuaweiAdapter(client, fixture, () => new Date('2026-01-01T00:00:00.000Z'));
    const result = await adapter.collectSystemMetrics(config, 'V8R21C00');
    expect(result.find((metric) => metric.metricId === 'device_uptime_seconds')).toMatchObject({ value: 123.45, quality: 'good' });
    expect(result.find((metric) => metric.metricId === 'device_cpu_percent')).toMatchObject({ value: 42 });
    expect(result.find((metric) => metric.metricId === 'device_memory_percent')).toMatchObject({ value: 65.5 });
    expect(result.find((metric) => metric.metricId === 'device_temperature_celsius')).toMatchObject({ value: 37.5 });
  });

  it('marks missing vendor metrics as unknown instead of inventing zero', async () => {
    const client = { get: async () => [vb(fixture.scalars.sysUpTime.oid, 10, 'TimeTicks')], table: async () => [] };
    const adapter = new HuaweiAdapter(client, fixture);
    const result = await adapter.collectSystemMetrics(config, 'V8R21C00');
    expect(result.find((metric) => metric.metricId === 'device_cpu_percent')).toMatchObject({ value: null, quality: 'unknown' });
  });

  it('maps interface statuses and computes 64-bit counter rates with 32-bit fallback', async () => {
    const rows = [
      { index: '1', values: { '2': 'GigabitEthernet0/0/1', '5': 1_000_000_000, '7': 1, '8': 1, '6': 100, '10': 200, '14': 2, '20': 3, '13': 4, '19': 5 } },
    ];
    let calls = 0;
    const client = { get: async () => [], table: async () => { calls++; return rows; } };
    const adapter = new HuaweiAdapter(client, fixture, () => new Date('2026-01-01T00:00:00.000Z'));
    const first = await adapter.collectInterfaces(config);
    expect(first.interfaces[0]).toMatchObject({ ifIndex: 1, name: 'GigabitEthernet0/0/1', adminStatus: 'up', operStatus: 'up' });
    expect(first.observations.find((metric) => metric.metricId === 'interface_in_bps')?.quality).toBe('unknown');

    rows[0].values['6'] = 1_100;
    rows[0].values['10'] = 350;
    rows[0].values['14'] = 5;
    rows[0].values['20'] = 9;
    rows[0].values['13'] = 7;
    rows[0].values['19'] = 11;
    const second = await adapter.collectInterfaces(config);
    expect(second.observations.find((metric) => metric.metricId === 'interface_in_bps')).toMatchObject({ value: 8_000, quality: 'good' });
    expect(second.observations.find((metric) => metric.metricId === 'interface_out_bps')).toMatchObject({ value: 1_200, quality: 'good' });
    expect(second.observations.find((metric) => metric.metricId === 'interface_error_rate' && metric.dimensions?.direction === 'in')).toMatchObject({ value: 3, quality: 'good', dimensions: { direction: 'in' } });
    expect(second.observations.find((metric) => metric.metricId === 'interface_error_rate' && metric.dimensions?.direction === 'out')).toMatchObject({ value: 6, quality: 'good', dimensions: { direction: 'out' } });
    expect(second.observations.find((metric) => metric.metricId === 'interface_drop_rate' && metric.dimensions?.direction === 'in')).toMatchObject({ value: 3, quality: 'good', dimensions: { direction: 'in' } });
    expect(second.observations.find((metric) => metric.metricId === 'interface_drop_rate' && metric.dimensions?.direction === 'out')).toMatchObject({ value: 6, quality: 'good', dimensions: { direction: 'out' } });
    expect(calls).toBe(2);
  });

  it('marks a counter reset/reboot as unknown rather than a huge positive rate', async () => {
    const rows = [{ index: '1', values: { '2': 'eth0', '7': 1, '8': 1, '10': 1_000, '16': 1_000 } }];
    const client = { get: async () => [], table: async () => rows };
    const adapter = new HuaweiAdapter(client, fixture, () => new Date('2026-01-01T00:00:00.000Z'));
    await adapter.collectInterfaces(config);
    rows[0].values['10'] = 10;
    const result = await adapter.collectInterfaces(config);
    expect(result.observations.find((metric) => metric.metricId === 'interface_in_bps')).toMatchObject({ value: null, quality: 'unknown', reason: 'counter_reset' });
  });

  it('handles a genuine 32-bit counter wrap without emitting a negative rate', async () => {
    const inOid = fixture.interfaces.ifInOctets.oid;
    const rows = [{ index: '1', values: { '2': 'eth0', '7': 1, '8': 1, [inOid]: 4_294_967_290 } }];
    const client = { get: async () => [], table: async () => rows };
    const adapter = new HuaweiAdapter(client, fixture, () => new Date('2026-01-01T00:00:00.000Z'));
    await adapter.collectInterfaces(config);
    rows[0].values[inOid] = 5;
    const result = await adapter.collectInterfaces(config);
    expect(result.observations.find((metric) => metric.metricId === 'interface_in_bps')).toMatchObject({ value: 88, quality: 'good' });
  });
});
