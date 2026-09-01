import { describe, expect, it, vi } from 'vitest';

import { NetworkDeviceCollector, type NetworkDeviceCollectionStore } from './network-device-collector.js';
import type { HuaweiInterfaceCollection, HuaweiMetricObservation, HuaweiProbeResult } from './huawei-adapter.js';
import type { SnmpV3Config } from './snmp-types.js';

const target = { id: 7, host: '10.20.30.40', snmpPort: 161, collectionEnabled: true };
const credentials = {
  protocol: 'snmpv3' as const, username: 'monitor', securityLevel: 'authPriv' as const,
  authProtocol: 'SHA' as const, authSecret: 'auth-secret-123', privacyProtocol: 'AES' as const, privacySecret: 'priv-secret-123',
};

function observation(metricId: string, value: number | null, quality: HuaweiMetricObservation['quality'] = 'good'): HuaweiMetricObservation {
  return { metricId, value, quality, source: 'snmpv3', observedAt: new Date('2026-01-01T00:00:00.000Z') };
}

function store(overrides: Partial<NetworkDeviceCollectionStore> = {}): NetworkDeviceCollectionStore {
  return {
    getDevice: vi.fn(async () => target),
    getCredentials: vi.fn(async () => credentials),
    updateStatus: vi.fn(async () => undefined),
    upsertInterface: vi.fn(async () => undefined),
    insertObservations: vi.fn(async () => undefined),
    ...overrides,
  };
}

function adapter(overrides: Partial<{
  probe: (config: SnmpV3Config) => Promise<HuaweiProbeResult>;
  collectSystemMetrics: (config: SnmpV3Config) => Promise<HuaweiMetricObservation[]>;
  collectInterfaces: (config: SnmpV3Config) => Promise<HuaweiInterfaceCollection>;
}> = {}) {
  return {
    probe: vi.fn(async () => ({ reachable: true, uptimeSeconds: 10, observedAt: new Date(), quality: 'good' as const })),
    collectSystemMetrics: vi.fn(async () => [observation('device_cpu_percent', 10)]),
    collectInterfaces: vi.fn(async () => ({ interfaces: [], observations: [], observedAt: new Date() })),
    ...overrides,
  };
}

describe('NetworkDeviceCollector', () => {
  it('fails closed on a denied target before reading credentials or opening SNMP', async () => {
    const persistence = store();
    const snmp = adapter();
    const authorizeTarget = vi.fn(async () => {
      throw Object.assign(new Error('target denied'), { reasonCode: 'SNMP_TARGET_ADDRESS_DENIED' });
    });
    const collector = new NetworkDeviceCollector(persistence, snmp as any, {
      authorizeTarget,
      targetPolicy: { allowedCidrs: '10.0.0.0/8', allowedPorts: [161], production: true },
    });

    await expect(collector.collectDevice(7)).resolves.toEqual({ success: false, error: 'SNMP_TARGET_DENIED' });
    expect(authorizeTarget).toHaveBeenCalledWith(
      { host: target.host, port: target.snmpPort },
      expect.objectContaining({ allowedCidrs: '10.0.0.0/8', allowedPorts: [161], production: true }),
    );
    expect(persistence.getCredentials).not.toHaveBeenCalled();
    expect(snmp.probe).not.toHaveBeenCalled();
    expect(persistence.updateStatus).toHaveBeenCalledWith(7, 'error');
  });

  it('collects in production without a network-specific CIDR policy', async () => {
    const persistence = store();
    const snmp = adapter();
    const collector = new NetworkDeviceCollector(persistence, snmp as any, {
      targetPolicy: { production: true, allowedPorts: [161] },
    });

    await expect(collector.collectDevice(7)).resolves.toMatchObject({ success: true });
    expect(persistence.getCredentials).toHaveBeenCalledWith(7);
    expect(snmp.probe).toHaveBeenCalledWith(expect.objectContaining({ host: target.host, port: target.snmpPort }));
  });

  it('collects system and interface evidence, then marks the device online', async () => {
    const persistence = store();
    const snmp = adapter({
      collectInterfaces: vi.fn(async () => ({
        interfaces: [{ ifIndex: 1, name: 'GE0/0/1', speedBps: 1_000_000_000, adminStatus: 'up' as const, operStatus: 'up' as const }],
        observations: [observation('interface_in_bps', 8000)], observedAt: new Date(),
      })),
    });
    const collector = new NetworkDeviceCollector(persistence, snmp as any);

    await expect(collector.collectDevice(7)).resolves.toMatchObject({ success: true, observations: 2 });
    expect(snmp.probe).toHaveBeenCalledWith(expect.objectContaining({ host: target.host, port: target.snmpPort }));
    expect(persistence.upsertInterface).toHaveBeenCalledWith(7, expect.objectContaining({ ifIndex: 1 }), expect.any(Date));
    expect(persistence.insertObservations).toHaveBeenCalledWith(7, expect.arrayContaining([
      expect.objectContaining({ metricId: 'device_cpu_percent' }),
      expect.objectContaining({ metricId: 'interface_in_bps' }),
    ]));
    expect(persistence.updateStatus).toHaveBeenLastCalledWith(7, 'online');
  });

  it('collects an SNMPv2c device using its community credential', async () => {
    const persistence = store({ getCredentials: vi.fn(async () => ({ protocol: 'snmpv2c' as const, username: '', community: 'readonly' })) });
    const snmp = adapter();
    const collector = new NetworkDeviceCollector(persistence, snmp as any);
    await expect(collector.collectDevice(7)).resolves.toMatchObject({ success: true });
    expect(snmp.probe).toHaveBeenCalledWith(expect.objectContaining({ version: 2, community: 'readonly' }));
  });

  it('serializes concurrent polls for one device', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const persistence = store();
    const snmp = adapter({
      probe: vi.fn(async () => { await gate; return { reachable: true, observedAt: new Date(), quality: 'good' as const }; }),
    });
    const collector = new NetworkDeviceCollector(persistence, snmp as any);
    const first = collector.collectDevice(7);
    const second = await collector.collectDevice(7);
    expect(second).toEqual({ success: false, error: 'COLLECTION_IN_PROGRESS' });
    release();
    await first;
    expect(snmp.probe).toHaveBeenCalledTimes(1);
  });

  it('keeps transient timeouts below unreachable threshold and recovers after success', async () => {
    const persistence = store();
    const snmp = adapter({ probe: vi.fn(async () => { throw Object.assign(new Error('timeout'), { code: 'SNMP_TIMEOUT' }); }) });
    const collector = new NetworkDeviceCollector(persistence, snmp as any, { maxFailuresBeforeUnreachable: 3 });
    await expect(collector.collectDevice(7)).resolves.toMatchObject({ success: false, error: 'SNMP_TIMEOUT' });
    await expect(collector.collectDevice(7)).resolves.toMatchObject({ success: false, error: 'SNMP_TIMEOUT' });
    expect(persistence.updateStatus).toHaveBeenCalledWith(7, 'error');
    await expect(collector.collectDevice(7)).resolves.toMatchObject({ success: false, error: 'SNMP_TIMEOUT' });
    expect(persistence.updateStatus).toHaveBeenCalledWith(7, 'unreachable');
  });

  it('re-reads stored credentials and recovers on the next collection', async () => {
    let storedCredentials: typeof credentials | null = null;
    const persistence = store({ getCredentials: vi.fn(async () => storedCredentials) });
    const snmp = adapter();
    const collector = new NetworkDeviceCollector(persistence, snmp as any);

    await expect(collector.collectDevice(7)).resolves.toEqual({ success: false, error: 'SNMP_AUTH_FAILED' });
    storedCredentials = credentials;
    await expect(collector.collectDevice(7)).resolves.toMatchObject({ success: true });

    expect(persistence.getCredentials).toHaveBeenCalledTimes(2);
    expect(snmp.probe).toHaveBeenCalledTimes(1);
    expect(persistence.updateStatus).toHaveBeenLastCalledWith(7, 'online');
  });

  it('does not persist unknown observations as zeroes', async () => {
    const persistence = store();
    const snmp = adapter({ collectSystemMetrics: vi.fn(async () => [observation('device_temperature_celsius', null, 'unknown')]) });
    const collector = new NetworkDeviceCollector(persistence, snmp as any);
    await collector.collectDevice(7);
    const rows = (persistence.insertObservations as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(rows[0]).toMatchObject({ value: null, quality: 'unknown' });
  });
});
