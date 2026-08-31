import { describe, expect, it } from 'vitest';

import {
  DEFAULT_HUAWEI_MIB_CATALOG,
  createHuaweiMibCatalog,
  getHuaweiMibCatalog,
} from './huawei-mib-catalog.js';

describe('Huawei MIB catalog', () => {
  it('contains verified standard system and interface roots', () => {
    expect(DEFAULT_HUAWEI_MIB_CATALOG.scalars.sysUpTime.oid).toBe('1.3.6.1.2.1.1.3.0');
    expect(DEFAULT_HUAWEI_MIB_CATALOG.scalars.sysName.oid).toBe('1.3.6.1.2.1.1.5.0');
    expect(DEFAULT_HUAWEI_MIB_CATALOG.interfaces.tableOid).toBe('1.3.6.1.2.1.2.2');
    expect(DEFAULT_HUAWEI_MIB_CATALOG.interfaces.ifHCInOctets.oid).toBe('1.3.6.1.2.1.31.1.1.1.6');
    expect(DEFAULT_HUAWEI_MIB_CATALOG.interfaces.ifHCOutOctets.oid).toBe('1.3.6.1.2.1.31.1.1.1.10');
  });

  it('does not claim Huawei CPU, memory, or temperature support without a fixture', () => {
    expect(DEFAULT_HUAWEI_MIB_CATALOG.vendorMetrics.cpu).toBeUndefined();
    expect(DEFAULT_HUAWEI_MIB_CATALOG.vendorMetrics.memory).toBeUndefined();
    expect(DEFAULT_HUAWEI_MIB_CATALOG.vendorMetrics.temperature).toBeUndefined();
    expect(getHuaweiMibCatalog('VRP V8R20')).toBe(DEFAULT_HUAWEI_MIB_CATALOG);
  });

  it('accepts a versioned fixture and validates its OIDs and transforms', () => {
    const catalog = createHuaweiMibCatalog({
      fixtureVersion: 'vrp-test-1', firmwarePattern: '^V8R21',
      vendorMetrics: {
        cpu: { oid: '1.3.6.1.4.1.2011.6.3.1.1.4.1.5.0', unit: 'percent', scale: 1 },
        memory: { oid: '1.3.6.1.4.1.2011.6.3.1.1.4.1.7.0', unit: 'percent', scale: 0.1 },
        temperature: { oid: '1.3.6.1.4.1.2011.6.3.15.1.1.6.1', unit: 'celsius', scale: 0.1 },
      },
    });
    expect(catalog.fixtureVersion).toBe('vrp-test-1');
    expect(catalog.vendorMetrics.memory?.scale).toBe(0.1);
    expect(getHuaweiMibCatalog('V8R21C00', [catalog])).toBe(catalog);
  });

  it('rejects unverified or malformed fixture entries', () => {
    expect(() => createHuaweiMibCatalog({
      fixtureVersion: 'bad', firmwarePattern: '[',
      vendorMetrics: { cpu: { oid: '1.2', unit: 'percent', scale: 1 } },
    })).toThrow('HUAWEI_MIB_FIXTURE_INVALID');
  });
});
