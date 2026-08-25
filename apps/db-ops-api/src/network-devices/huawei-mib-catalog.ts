import type { SnmpVarbind } from './snmp-types.js';

export interface HuaweiOidDefinition {
  oid: string;
  unit: 'raw' | 'ticks' | 'bytes' | 'bits_per_second' | 'percent' | 'celsius' | 'status' | 'text';
  scale: number;
}

export interface HuaweiVendorMetricDefinition extends HuaweiOidDefinition {
  unit: 'percent' | 'celsius';
}

export interface HuaweiMibCatalog {
  fixtureVersion: string;
  firmwarePattern: string;
  scalars: {
    sysUpTime: HuaweiOidDefinition;
    sysName: HuaweiOidDefinition;
    sysDescr: HuaweiOidDefinition;
  };
  interfaces: {
    tableOid: string;
    ifIndex: HuaweiOidDefinition;
    ifDescr: HuaweiOidDefinition;
    ifAlias: HuaweiOidDefinition;
    ifSpeed: HuaweiOidDefinition;
    ifAdminStatus: HuaweiOidDefinition;
    ifOperStatus: HuaweiOidDefinition;
    ifHCInOctets: HuaweiOidDefinition;
    ifHCOutOctets: HuaweiOidDefinition;
    ifInOctets: HuaweiOidDefinition;
    ifOutOctets: HuaweiOidDefinition;
    ifInErrors: HuaweiOidDefinition;
    ifOutErrors: HuaweiOidDefinition;
    ifInDiscards: HuaweiOidDefinition;
    ifOutDiscards: HuaweiOidDefinition;
  };
  vendorMetrics: {
    cpu?: HuaweiVendorMetricDefinition;
    memory?: HuaweiVendorMetricDefinition;
    temperature?: HuaweiVendorMetricDefinition;
  };
}

export interface HuaweiMibFixture {
  fixtureVersion: string;
  firmwarePattern: string;
  vendorMetrics: Partial<{
    cpu: HuaweiVendorMetricDefinition;
    memory: HuaweiVendorMetricDefinition;
    temperature: HuaweiVendorMetricDefinition;
  }>;
}

const scalar = (oid: string, unit: HuaweiOidDefinition['unit'], scale = 1): HuaweiOidDefinition => ({ oid, unit, scale });

export const DEFAULT_HUAWEI_MIB_CATALOG: HuaweiMibCatalog = Object.freeze({
  fixtureVersion: 'standard-mib-2',
  firmwarePattern: '.*',
  scalars: {
    sysUpTime: scalar('1.3.6.1.2.1.1.3.0', 'ticks', 0.01),
    sysName: scalar('1.3.6.1.2.1.1.5.0', 'text'),
    sysDescr: scalar('1.3.6.1.2.1.1.1.0', 'text'),
  },
  interfaces: {
    tableOid: '1.3.6.1.2.1.2.2',
    ifIndex: scalar('1.3.6.1.2.1.2.2.1.1', 'raw'),
    ifDescr: scalar('1.3.6.1.2.1.2.2.1.2', 'text'),
    ifAlias: scalar('1.3.6.1.2.1.31.1.1.1.18', 'text'),
    ifSpeed: scalar('1.3.6.1.2.1.2.2.1.5', 'raw'),
    ifAdminStatus: scalar('1.3.6.1.2.1.2.2.1.7', 'status'),
    ifOperStatus: scalar('1.3.6.1.2.1.2.2.1.8', 'status'),
    ifHCInOctets: scalar('1.3.6.1.2.1.31.1.1.1.6', 'bytes'),
    ifHCOutOctets: scalar('1.3.6.1.2.1.31.1.1.1.10', 'bytes'),
    ifInOctets: scalar('1.3.6.1.2.1.2.2.1.10', 'bytes'),
    ifOutOctets: scalar('1.3.6.1.2.1.2.2.1.16', 'bytes'),
    ifInErrors: scalar('1.3.6.1.2.1.2.2.1.14', 'raw'),
    ifOutErrors: scalar('1.3.6.1.2.1.2.2.1.20', 'raw'),
    ifInDiscards: scalar('1.3.6.1.2.1.2.2.1.13', 'raw'),
    ifOutDiscards: scalar('1.3.6.1.2.1.2.2.1.19', 'raw'),
  },
  // Huawei enterprise OIDs are intentionally absent until a versioned MIB
  // fixture has been captured and reviewed.
  vendorMetrics: {},
});

const OID_PATTERN = /^(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*))+$/;

function validateOidDefinition(value: unknown, vendor: boolean): HuaweiOidDefinition {
  if (!value || typeof value !== 'object') throw new Error('HUAWEI_MIB_FIXTURE_INVALID');
  const definition = value as Partial<HuaweiOidDefinition>;
  if (typeof definition.oid !== 'string' || !OID_PATTERN.test(definition.oid) || definition.oid.length > 128) {
    throw new Error('HUAWEI_MIB_FIXTURE_INVALID');
  }
  if (vendor && !definition.oid.startsWith('1.3.6.1.4.1.2011.')) {
    throw new Error('HUAWEI_MIB_FIXTURE_INVALID');
  }
  if (typeof definition.scale !== 'number' || !Number.isFinite(definition.scale) || definition.scale <= 0) {
    throw new Error('HUAWEI_MIB_FIXTURE_INVALID');
  }
  const units = vendor ? ['percent', 'celsius'] : ['raw', 'ticks', 'bytes', 'bits_per_second', 'percent', 'celsius', 'status', 'text'];
  if (typeof definition.unit !== 'string' || !units.includes(definition.unit)) {
    throw new Error('HUAWEI_MIB_FIXTURE_INVALID');
  }
  return { oid: definition.oid, unit: definition.unit as HuaweiOidDefinition['unit'], scale: definition.scale };
}

export function createHuaweiMibCatalog(fixture: HuaweiMibFixture): HuaweiMibCatalog {
  if (!fixture || typeof fixture.fixtureVersion !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(fixture.fixtureVersion)) {
    throw new Error('HUAWEI_MIB_FIXTURE_INVALID');
  }
  if (typeof fixture.firmwarePattern !== 'string' || fixture.firmwarePattern.length > 128) {
    throw new Error('HUAWEI_MIB_FIXTURE_INVALID');
  }
  try { new RegExp(fixture.firmwarePattern); } catch { throw new Error('HUAWEI_MIB_FIXTURE_INVALID'); }
  if (!fixture.vendorMetrics || typeof fixture.vendorMetrics !== 'object') throw new Error('HUAWEI_MIB_FIXTURE_INVALID');
  const vendorMetrics: HuaweiMibCatalog['vendorMetrics'] = {};
  for (const key of ['cpu', 'memory', 'temperature'] as const) {
    const value = fixture.vendorMetrics[key];
    if (value !== undefined) vendorMetrics[key] = validateOidDefinition(value, true) as HuaweiVendorMetricDefinition;
  }
  return {
    fixtureVersion: fixture.fixtureVersion,
    firmwarePattern: fixture.firmwarePattern,
    scalars: DEFAULT_HUAWEI_MIB_CATALOG.scalars,
    interfaces: DEFAULT_HUAWEI_MIB_CATALOG.interfaces,
    vendorMetrics,
  };
}

export function getHuaweiMibCatalog(firmware: string | null | undefined, catalogs: HuaweiMibCatalog[] = []): HuaweiMibCatalog {
  if (typeof firmware !== 'string') return DEFAULT_HUAWEI_MIB_CATALOG;
  for (const catalog of catalogs) {
    try {
      if (new RegExp(catalog.firmwarePattern).test(firmware)) return catalog;
    } catch {
      // Invalid runtime catalog entries are ignored; startup validation should
      // normally prevent them from being registered.
    }
  }
  return DEFAULT_HUAWEI_MIB_CATALOG;
}

export function valueFromVarbind(varbind: SnmpVarbind | undefined): unknown {
  return varbind && typeof varbind === 'object' && 'value' in varbind ? varbind.value : undefined;
}
