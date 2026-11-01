import { describe, expect, it } from 'vitest';
import { createBuiltinRegistry } from '../packages/builtins.js';
import { createSnmpPackage } from '../snmp/package.js';
import { InMemoryTemplateRepository } from './repository.js';
import {
  OFFICIAL_SOURCES, ZABBIX_REFERENCE, convertOfficialTemplate, isSingleItemThreshold, parseOfficialExport,
  type ZabbixExport, type ZabbixItem,
} from './zabbix-official-templates.js';
import { importConvertedTemplate } from './zabbix-template-import.js';

const source = (category: 'database' | 'server' | 'network_device') =>
  OFFICIAL_SOURCES.find(entry => entry.category === category)!;

const item = (uuid: string, name: string, key: string, extra: Partial<ZabbixItem> = {}): ZabbixItem =>
  ({ uuid, name, key, ...extra });

const exportOf = (category: 'database' | 'server' | 'network_device', items: ZabbixItem[], prototypes: ZabbixItem[] = [], triggers: ZabbixExport['zabbix_export']['triggers'] = []): ZabbixExport => ({
  zabbix_export: {
    version: '7.0',
    templates: [{
      uuid: source(category).template_uuid,
      template: source(category).template_name,
      name: source(category).template_name,
      items,
      discovery_rules: prototypes.length ? [{
        uuid: 'disc-1', name: 'discovery', key: 'vfs.fs.get', item_prototypes: prototypes,
      }] : [],
      macros: category === 'database'
        ? [{ macro: '{$MYSQL.USER}', value: 'x' }, { macro: '{$MYSQL.PASSWORD}', value: 'x' }, { macro: '{$MYSQL.DSN}', value: 'x' }]
        : [],
    }],
    triggers,
    graphs: [{ name: 'upstream graph' }],
  },
});

const registry = (category: 'database' | 'server' | 'network_device') =>
  category === 'network_device' ? createSnmpPackage().registry : createBuiltinRegistry();

describe('MAX-237 T3 official Zabbix conversion', () => {
  it('parses only the fixed 7.0 export shape', () => {
    expect(parseOfficialExport('zabbix_export:\n  version: "7.0"\n  templates: []\n').zabbix_export.version).toBe('7.0');
    expect(() => parseOfficialExport('templates: []')).toThrow('ZABBIX_EXPORT_INVALID');
  });

  it('converts only the MySQL read-only Uptime item and drops credential macros', () => {
    const converted = convertOfficialTemplate(exportOf('database', [
      item('70491bf6b6af401c9dfb10c0cbfddee1', 'Get database', 'db.odbc.get[get_database,"{$MYSQL.DSN}"]', { type: 'ODBC', delay: '1h' }),
      item('8fbad224ebdf46e7b25a0be015f21972', 'Uptime', 'mysql.uptime', { type: 'DEPENDENT', delay: '0' }),
      item('2f0ced88c4524455bf790b3bc6512d04', 'Queries per second', 'mysql.queries.rate', { type: 'DEPENDENT', delay: '0' }),
    ]), source('database'), registry('database'));
    expect(converted.items).toHaveLength(1);
    expect(converted.items[0]).toMatchObject({
      item_id: '8fbad224ebdf46e7b25a0be015f21972',
      metric: { id: 'db.uptime_seconds', semantic_version: '1.0.0' },
      unit: 's',
    });
    expect(converted.unsupported.map(entry => entry.reason))
      .toEqual(['odbc_raw_not_a_metric', 'derived_not_selectable']);
    expect(converted.credential_macros_dropped.sort())
      .toEqual(['{$MYSQL.DSN}', '{$MYSQL.PASSWORD}', '{$MYSQL.USER}']);
    expect(converted.triggers).toEqual([]);
  });

  it('converts the Linux items that the existing SSH collector actually measures', () => {
    const converted = convertOfficialTemplate(exportOf('server', [
      item('48528aa936a04c8189375a6eae4033da', 'Load average (1m avg)', 'system.cpu.load[all,avg1]'),
      item('8537f6c6ac6b438c80caf227946df891', 'System uptime', 'system.uptime', { delay: '30s' }),
      item('403cebed115441369e94d35d070ca7b8', 'Memory utilization', 'vm.memory.utilization', { type: 'DEPENDENT', delay: '0' }),
      item('ca4235ec7607469cb0124a6253d3c489', 'CPU utilization', 'system.cpu.util', { type: 'DEPENDENT', delay: '0' }),
      item('df561a0cece94760a78704edf7da7326', 'Host name of Zabbix agent running', 'agent.hostname', { delay: '1h' }),
    ], [
      item('efee06a191aa4e5c8faa2762988b6955', 'FS [{#FSNAME}]: Space: Used', 'vfs.fs.dependent.size[{#FSNAME},used]'),
      item('a6d90e0bc5ef4fb7acee8682687c485f', 'FS [{#FSNAME}]: Space: Total', 'vfs.fs.dependent.size[{#FSNAME},total]'),
    ]), source('server'), registry('server'));
    expect(converted.items.map(entry => entry.metric.id).sort()).toEqual([
      'host.filesystem.size_bytes', 'host.filesystem.used_bytes',
      'linux.load.one_minute', 'linux.memory.used_percent', 'linux.uptime.seconds',
    ]);
    const reasons = Object.fromEntries(converted.unsupported.map(entry => [entry.upstream.key, entry.reason]));
    expect(reasons['agent.hostname']).toBe('zabbix_agent_unsupported');
    expect(reasons['system.cpu.util']).toBe('semantics_mismatch');
    expect(converted.items.find(entry => entry.metric.id === 'linux.memory.used_percent')?.note).toContain('MemAvailable');
  });

  it('converts only Huawei OIDs that SnmpDiscovery already reads', () => {
    const converted = convertOfficialTemplate(exportOf('network_device', [
      item('e9dd0d849aaa499da9e2ef9e21ccd50e', 'Uptime (network)', 'system.net.uptime[sysUpTime.0]', { type: 'SNMP_AGENT', delay: '30s' }),
      item('202c91a61d644285a0d74d88ae1b1a79', 'Uptime (hardware)', 'system.hw.uptime[hrSystemUptime.0]', { type: 'SNMP_AGENT' }),
      item('1cd98c8030f14fbca6abee35eb87e45b', 'ICMP ping', 'icmpping', { type: 'SIMPLE' }),
    ], [
      item('1659d815112945478585fceef9318e68', 'Operational status', 'net.if.status[ifOperStatus.{#SNMPINDEX}]', { type: 'SNMP_AGENT' }),
      item('e5323fadbfbe4773ab450312a2c29164', 'Bits received', 'net.if.in[ifHCInOctets.{#SNMPINDEX}]', { type: 'SNMP_AGENT', units: 'bps' }),
      item('c45208952a8f43e7a4ac90dbc9bf2eac', 'Speed', 'net.if.speed[ifHighSpeed.{#SNMPINDEX}]', { type: 'SNMP_AGENT', units: 'bps' }),
      item('f6135b96b3584060b3a605312748edf4', 'Interface type', 'net.if.type[ifType.{#SNMPINDEX}]', { type: 'SNMP_AGENT' }),
    ]), source('network_device'), registry('network_device'));
    expect(converted.items.map(entry => entry.metric.id).sort()).toEqual([
      'network.interface.oper_up',
      'snmp.agent.uptime_seconds',
      'snmp.interface.rx_octets_total',
      'snmp.interface.speed_bits_per_second',
    ]);
    const reasons = Object.fromEntries(converted.unsupported.map(entry => [entry.upstream.key, entry.reason]));
    expect(reasons['system.hw.uptime[hrSystemUptime.0]']).toBe('snmp_oid_unmapped');
    expect(reasons['icmpping']).toBe('icmp_not_collected');
    expect(reasons['net.if.type[ifType.{#SNMPINDEX}]']).toBe('snmp_oid_unmapped');
    expect(converted.items[0]!.upstream.units).toBeNull();
  });

  it('rejects a commit or export version that is not pinned', () => {
    const doc = exportOf('database', [item('u1', 'Uptime', 'mysql.uptime')]);
    doc.zabbix_export.version = '7.2';
    expect(() => convertOfficialTemplate(doc, source('database'), registry('database')))
      .toThrow('ZABBIX_EXPORT_VERSION_UNSUPPORTED');
    expect(ZABBIX_REFERENCE.commit).toBe('6542e21fe6adc8ab7bf903c2a9d1df80e80366cd');
  });

  it('detects a single-item threshold expression but keeps no expression engine', () => {
    expect(isSingleItemThreshold('last(/MySQL by ODBC/mysql.uptime)>0')).toEqual({ key: 'mysql.uptime' });
    expect(isSingleItemThreshold('last(/Linux by Zabbix agent/proc.num)/last(/Linux by Zabbix agent/kernel.maxproc)*100>80'))
      .toBeNull();
    const converted = convertOfficialTemplate(exportOf('database', [item('u1', 'Uptime', 'mysql.uptime')], [], [{
      uuid: 't1', name: 'restarted', expression: 'last(/MySQL by ODBC/mysql.uptime)>0',
    }]), source('database'), registry('database'));
    expect(converted.triggers).toEqual([{
      upstream: { uuid: 't1', name: 'restarted', expression: 'last(/MySQL by ODBC/mysql.uptime)>0', priority: null },
      reason: 'not_single_converted_item_threshold',
    }]);
  });
});

describe('MAX-237 T3 idempotent import through the repository port', () => {
  const converted = () => convertOfficialTemplate(exportOf('network_device', [
    item('e9dd0d849aaa499da9e2ef9e21ccd50e', 'Uptime (network)', 'system.net.uptime[sysUpTime.0]', { type: 'SNMP_AGENT' }),
  ], [
    item('1659d815112945478585fceef9318e68', 'Operational status', 'net.if.status[ifOperStatus.{#SNMPINDEX}]', { type: 'SNMP_AGENT' }),
    item('e5323fadbfbe4773ab450312a2c29164', 'Bits received', 'net.if.in[ifHCInOctets.{#SNMPINDEX}]', { type: 'SNMP_AGENT' }),
  ]), source('network_device'), registry('network_device'));

  it('creates one template, then reports an identical re-import as a no-op', async () => {
    const repository = new InMemoryTemplateRepository();
    const registry = createSnmpPackage().registry;
    const first = await importConvertedTemplate(repository, registry, converted(), { now: '2026-10-27T00:00:00.000Z' });
    expect(first.action).toBe('created');
    expect(first.item_count).toBe(3);
    expect((await repository.listTemplates({})).items).toHaveLength(1);
    const second = await importConvertedTemplate(repository, registry, converted(), { now: '2026-10-27T00:05:00.000Z' });
    expect(second.action).toBe('noop');
    expect(second.version).toBe(first.version);
    expect(second.item_count).toBe(3);
    expect((await repository.listTemplates({})).items).toHaveLength(1);
    expect(await repository.listVersions(first.template_id)).toHaveLength(1);
  });

  it('never impersonates a user and keeps the pinned source in the migration lineage', async () => {
    const repository = new InMemoryTemplateRepository();
    const result = await importConvertedTemplate(repository, createSnmpPackage().registry, converted(), {
      now: '2026-10-27T00:00:00.000Z',
    });
    expect(result.template.created_by).toBeNull();
    expect(result.current.source_chain.actor_id).toBeNull();
    expect(result.current.source_chain.migration_ref).toContain('zabbix-7.0.21@6542e21f');
    expect(result.current.aggregate.triggers).toEqual([]);
    expect(result.template.status).toBe('active');
  });
});
