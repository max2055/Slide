/**
 * MAX-237 / T3 — conversion of the three fixed official Zabbix 7.0.21
 * templates named by the member (`member-inputs-20261027.md`) into Slide
 * template drafts.
 *
 * This is deliberately **not** a general Zabbix importer. Only the three
 * `OFFICIAL_SOURCES` files are accepted, and every item/prototype is matched by
 * its exact upstream key against an explicit rule table. There is no YAML-body
 * copy, no expression engine, no Agent/ODBC transport, no upstream template
 * sync and no second metric catalog: an item is converted only when its
 * upstream key already resolves to a registered Slide capability through
 * `RegisteredCapabilityCatalog`.
 *
 * Unsupported entries keep the upstream identity and a stable reason code; they
 * never enter a template version as a fake item.
 */
import { parse as parseYaml } from 'yaml';
import type { PackageRegistry } from '../packages/model.js';
import { RegisteredCapabilityCatalog, type CapabilityCandidate, type PackagePin } from './catalog.js';
import type { MetricRef } from './model.js';

/** Fixed upstream provenance. The commit is pinned by the member and never follows master. */
export const ZABBIX_REFERENCE = Object.freeze({
  version: '7.0.21',
  commit: '6542e21fe6adc8ab7bf903c2a9d1df80e80366cd',
  license: 'AGPL-3.0-only',
  repository: 'https://github.com/zabbix/zabbix',
  localPath: '/Users/max/Coding/40-Slide-references/zabbix',
});

export type OfficialCategory = 'database' | 'server' | 'network_device';

export interface OfficialSource {
  category: OfficialCategory;
  packageRoot: string;
  path: string;
  url: string;
  template_uuid: string;
  template_name: string;
}

export const OFFICIAL_SOURCES: readonly OfficialSource[] = Object.freeze([
  {
    category: 'database',
    packageRoot: 'builtin',
    path: 'templates/db/mysql_odbc/template_db_mysql_odbc.yaml',
    url: `${ZABBIX_REFERENCE.repository}/blob/${ZABBIX_REFERENCE.commit}/templates/db/mysql_odbc/template_db_mysql_odbc.yaml`,
    template_uuid: 'e19c120027e04da69b130e0f6cea29fc',
    template_name: 'MySQL by ODBC',
  },
  {
    category: 'server',
    packageRoot: 'builtin',
    path: 'templates/os/linux/template_os_linux.yaml',
    url: `${ZABBIX_REFERENCE.repository}/blob/${ZABBIX_REFERENCE.commit}/templates/os/linux/template_os_linux.yaml`,
    template_uuid: 'f8f7908280354f2abeed07dc788c3747',
    template_name: 'Linux by Zabbix agent',
  },
  {
    category: 'network_device',
    packageRoot: 'snmp',
    path: 'templates/net/huawei_snmp/template_net_huawei_snmp.yaml',
    url: `${ZABBIX_REFERENCE.repository}/blob/${ZABBIX_REFERENCE.commit}/templates/net/huawei_snmp/template_net_huawei_snmp.yaml`,
    template_uuid: 'ad4c3dad4b7b492685d1fd3bd3a664f9',
    template_name: 'Huawei VRP by SNMP',
  },
]);

// ---------------------------------------------------------------- upstream shape

export interface ZabbixItem {
  uuid: string;
  name: string;
  key: string;
  type?: string;
  delay?: string;
  units?: string;
  value_type?: string;
  params?: string;
}

export interface ZabbixDiscoveryRule {
  uuid: string;
  name: string;
  key: string;
  type?: string;
  delay?: string;
  item_prototypes?: ZabbixItem[];
}

export interface ZabbixTrigger {
  uuid: string;
  name: string;
  expression: string;
  priority?: string;
}

export interface ZabbixTemplate {
  uuid: string;
  template: string;
  name: string;
  items?: ZabbixItem[];
  discovery_rules?: ZabbixDiscoveryRule[];
  macros?: { macro: string; value?: string }[];
  graphs?: { name: string }[];
}

export interface ZabbixExport {
  zabbix_export: {
    version: string;
    templates: ZabbixTemplate[];
    triggers?: ZabbixTrigger[];
    graphs?: { name: string }[];
  };
}

/** Parse the official YAML document. Only shape is checked here; rules decide meaning. */
export function parseOfficialExport(text: string): ZabbixExport {
  const parsed = parseYaml(text) as ZabbixExport | null;
  if (!parsed || typeof parsed !== 'object' || !parsed.zabbix_export
    || !Array.isArray(parsed.zabbix_export.templates)) {
    throw new Error('ZABBIX_EXPORT_INVALID');
  }
  return parsed;
}

// ---------------------------------------------------------------- conversion rules

interface Rule {
  kind: 'item' | 'prototype';
  key: string;
  metric: MetricRef;
  /** `package.id@version` inside a registry that must be supplied by the caller. */
  package: { id: string; version: string };
  /** Why the upstream item and the Slide metric are the same measurement. */
  note: string;
}

/**
 * The complete conversion table. Every entry was checked against the pinned
 * file; keys not listed here are unsupported by construction.
 */
const RULES: Readonly<Record<OfficialCategory, readonly Rule[]>> = Object.freeze({
  database: [
    {
      kind: 'item', key: 'mysql.uptime',
      metric: { id: 'db.uptime_seconds', semantic_version: '1.0.0' },
      package: { id: 'mysql-basic', version: '1.0.0' },
      note: 'derived from SHOW GLOBAL STATUS Uptime, the same read-only status source as builtin:mysql.status.v1',
    },
  ],
  server: [
    {
      kind: 'item', key: 'system.cpu.load[all,avg1]',
      metric: { id: 'linux.load.one_minute', semantic_version: '1.0.0' },
      package: { id: 'linux-basic', version: '1.0.0' },
      note: 'same /proc/loadavg one-minute field',
    },
    {
      kind: 'item', key: 'system.uptime',
      metric: { id: 'linux.uptime.seconds', semantic_version: '1.0.0' },
      package: { id: 'linux-basic', version: '1.0.0' },
      note: 'same /proc/uptime seconds since boot',
    },
    {
      kind: 'item', key: 'vm.memory.utilization',
      metric: { id: 'linux.memory.used_percent', semantic_version: '1.0.0' },
      package: { id: 'linux-host', version: '1.0.0' },
      note: '(MemTotal - MemAvailable) / MemTotal, i.e. the MemAvailable-based used percent Slide already collects',
    },
    {
      kind: 'prototype', key: 'vfs.fs.dependent.size[{#FSNAME},used]',
      metric: { id: 'host.filesystem.used_bytes', semantic_version: '1.0.0' },
      package: { id: 'linux-host', version: '1.0.0' },
      note: 'per-filesystem used bytes from df; mount/device/fs_type stay dimensions',
    },
    {
      kind: 'prototype', key: 'vfs.fs.dependent.size[{#FSNAME},total]',
      metric: { id: 'host.filesystem.size_bytes', semantic_version: '1.0.0' },
      package: { id: 'linux-host', version: '1.0.0' },
      note: 'per-filesystem total bytes from df; reserved capacity included by the canonical metric',
    },
  ],
  network_device: [
    {
      kind: 'item', key: 'system.net.uptime[sysUpTime.0]',
      metric: { id: 'snmp.agent.uptime_seconds', semantic_version: '1.0.0' },
      package: { id: 'snmp-standard', version: '1.0.0' },
      note: 'MIB-II sysUpTime centiseconds converted to seconds',
    },
    {
      kind: 'prototype', key: 'net.if.status[ifOperStatus.{#SNMPINDEX}]',
      metric: { id: 'network.interface.oper_up', semantic_version: '1.0.0' },
      package: { id: 'snmp-standard', version: '1.0.0' },
      note: 'IF-MIB ifOperStatus up=1/down=0, other enumerants unknown',
    },
    {
      kind: 'prototype', key: 'net.if.speed[ifHighSpeed.{#SNMPINDEX}]',
      metric: { id: 'snmp.interface.speed_bits_per_second', semantic_version: '1.0.0' },
      package: { id: 'snmp-standard', version: '1.0.0' },
      note: 'ifHighSpeed preferred, ifSpeed fallback',
    },
    {
      kind: 'prototype', key: 'net.if.in[ifHCInOctets.{#SNMPINDEX}]',
      metric: { id: 'snmp.interface.rx_octets_total', semantic_version: '1.0.0' },
      package: { id: 'snmp-standard', version: '1.0.0' },
      note: 'raw Counter64 ifHCInOctets; the upstream item presents bits/s, Slide keeps the counter and its rate is a separate derived metric',
    },
    {
      kind: 'prototype', key: 'net.if.out[ifHCOutOctets.{#SNMPINDEX}]',
      metric: { id: 'snmp.interface.tx_octets_total', semantic_version: '1.0.0' },
      package: { id: 'snmp-standard', version: '1.0.0' },
      note: 'raw Counter64 ifHCOutOctets; same counter-versus-rate note as the inbound item',
    },
    {
      kind: 'prototype', key: 'net.if.in.errors[ifInErrors.{#SNMPINDEX}]',
      metric: { id: 'snmp.interface.rx_errors_total', semantic_version: '1.0.0' },
      package: { id: 'snmp-standard', version: '1.0.0' },
      note: 'IF-MIB ifInErrors Counter32',
    },
    {
      kind: 'prototype', key: 'net.if.out.errors[ifOutErrors.{#SNMPINDEX}]',
      metric: { id: 'snmp.interface.tx_errors_total', semantic_version: '1.0.0' },
      package: { id: 'snmp-standard', version: '1.0.0' },
      note: 'IF-MIB ifOutErrors Counter32',
    },
    {
      kind: 'prototype', key: 'net.if.in.discards[ifInDiscards.{#SNMPINDEX}]',
      metric: { id: 'snmp.interface.rx_discards_total', semantic_version: '1.0.0' },
      package: { id: 'snmp-standard', version: '1.0.0' },
      note: 'IF-MIB ifInDiscards Counter32',
    },
    {
      kind: 'prototype', key: 'net.if.out.discards[ifOutDiscards.{#SNMPINDEX}]',
      metric: { id: 'snmp.interface.tx_discards_total', semantic_version: '1.0.0' },
      package: { id: 'snmp-standard', version: '1.0.0' },
      note: 'IF-MIB ifOutDiscards Counter32',
    },
  ],
});

const ruleFor = (category: OfficialCategory, kind: 'item' | 'prototype', key: string): Rule | undefined =>
  RULES[category].find(rule => rule.kind === kind && rule.key === key);

/** Reason codes are stable evidence strings, never free text that hides a gap. */
export type UnsupportedReason =
  | 'zabbix_agent_unsupported'
  | 'snmp_oid_unmapped'
  | 'odbc_raw_not_a_metric'
  | 'derived_not_selectable'
  | 'semantics_mismatch'
  | 'no_matching_slide_metric'
  | 'expression_not_supported'
  | 'internal_not_collectable'
  | 'icmp_not_collected'
  | 'trap_not_collected'
  | 'discovery_not_delivered';

function unsupportedReason(category: OfficialCategory, item: ZabbixItem): UnsupportedReason {
  const type = (item.type ?? 'ZABBIX_PASSIVE').toUpperCase();
  const key = item.key;
  if (type === 'CALCULATED') return 'expression_not_supported';
  if (type === 'INTERNAL' || key.startsWith('zabbix[')) return 'internal_not_collectable';
  if (category === 'database') {
    if (type === 'ODBC' || key.startsWith('db.odbc.')) return 'odbc_raw_not_a_metric';
    if (/\.rate$/.test(key)) return 'derived_not_selectable';
    return 'no_matching_slide_metric';
  }
  if (category === 'server') {
    if (key.startsWith('net.if.')) return 'semantics_mismatch';
    if (key.startsWith('system.cpu.util')) return 'semantics_mismatch';
    if (key.startsWith('vfs.dev.')) return 'no_matching_slide_metric';
    if (key.startsWith('vfs.fs.dependent.inode')) return 'no_matching_slide_metric';
    if (key.startsWith('vm.memory.size')) return 'no_matching_slide_metric';
    if (key.startsWith('system.swap.')) return 'no_matching_slide_metric';
    if (key === 'vfs.fs.get' || key === 'net.if.discovery' || key === 'vfs.dev.discovery') return 'discovery_not_delivered';
    return 'zabbix_agent_unsupported';
  }
  if (type === 'SIMPLE') return 'icmp_not_collected';
  if (type === 'SNMP_TRAP') return 'trap_not_collected';
  return 'snmp_oid_unmapped';
}

// ---------------------------------------------------------------- converted shape

export interface UpstreamEvidence {
  template_uuid: string;
  kind: 'item' | 'prototype';
  uuid: string;
  name: string;
  key: string;
  type: string;
  delay: string | null;
  units: string | null;
  value_type: string | null;
}

export interface ConvertedItem {
  upstream: UpstreamEvidence;
  item_id: string;
  display_name: string;
  metric: MetricRef;
  /** Canonical unit from the registered definition, not the upstream presentation. */
  unit: string;
  dimensions: Record<string, string>;
  package_release: string;
  implementation_id: string;
  raw_field: string;
  note: string;
}

export interface UnsupportedEntry {
  upstream: UpstreamEvidence;
  reason: UnsupportedReason;
}

export interface StoredTrigger {
  upstream: { uuid: string; name: string; expression: string; priority: string | null };
  reason: 'not_single_converted_item_threshold';
}

export interface ConvertedTemplate {
  category: OfficialCategory;
  source: {
    url: string; path: string; commit: string; license: string;
    template_uuid: string; template_name: string; export_version: string;
  };
  template_id: string;
  name: string;
  interval_ms: number;
  parameters: {
    schema: { interval_ms: { type: 'integer'; min: number; max: number } };
    defaults: { interval_ms: number };
  };
  items: ConvertedItem[];
  unsupported: UnsupportedEntry[];
  triggers: StoredTrigger[];
  credential_macros_dropped: string[];
  graphs_not_converted: string[];
}

const upstreamEvidence = (templateUuid: string, kind: 'item' | 'prototype', item: ZabbixItem): UpstreamEvidence => ({
  template_uuid: templateUuid,
  kind,
  uuid: item.uuid,
  name: item.name,
  key: item.key,
  type: item.type ?? 'ZABBIX_PASSIVE',
  delay: item.delay ?? null,
  units: item.units ?? null,
  value_type: item.value_type ?? null,
});

const DEFAULT_INTERVAL_MS = 60_000;
const MIN_INTERVAL_MS = 1_000;
const MAX_INTERVAL_MS = 86_400_000;

/** Official credential/DSN macros are metadata, never persisted. */
const CREDENTIAL_MACROS = new Set(['{$MYSQL.USER}', '{$MYSQL.PASSWORD}', '{$MYSQL.DSN}']);

/**
 * A trigger is convertible only when its whole expression is one comparison
 * against one converted item (`last(/tpl/key)>N` and similar). Threshold values
 * are kept in the report; the stored aggregate only carries the rule reference
 * shape the accepted contract freezes.
 */
export function isSingleItemThreshold(expression: string): { key: string } | null {
  const match = /^\s*(?:last|avg|min|max)\(\/([^/]+)\/([^)]+)\)\s*(?:[<>]=?|=)\s*[^\s]+\s*$/.exec(expression);
  if (!match) return null;
  return { key: match[2]!.trim() };
}

export function convertOfficialTemplate(
  doc: ZabbixExport,
  source: OfficialSource,
  registry: PackageRegistry,
): ConvertedTemplate {
  if (doc.zabbix_export.version !== '7.0') throw new Error('ZABBIX_EXPORT_VERSION_UNSUPPORTED');
  const template = doc.zabbix_export.templates.find(entry => entry.uuid === source.template_uuid);
  if (!template) throw new Error(`ZABBIX_TEMPLATE_MISSING:${source.template_uuid}`);

  const catalog = new RegisteredCapabilityCatalog(registry);
  const pinFor = (rule: Rule): PackagePin => {
    const release = registry.list().find(entry =>
      entry.package.id === rule.package.id && entry.package.version === rule.package.version);
    if (!release) throw new Error(`ZABBIX_PACKAGE_MISSING:${rule.package.id}@${rule.package.version}`);
    return { id: release.package.id, version: release.package.version, digest: release.package.digest };
  };

  const items: ConvertedItem[] = [];
  const unsupported: UnsupportedEntry[] = [];
  const addItem = (kind: 'item' | 'prototype', item: ZabbixItem): void => {
    const rule = ruleFor(source.category, kind, item.key);
    if (!rule) {
      unsupported.push({ upstream: upstreamEvidence(source.template_uuid, kind, item), reason: unsupportedReason(source.category, item) });
      return;
    }
    const candidate: CapabilityCandidate = catalog.autofill({ package: pinFor(rule), metric: rule.metric });
    items.push({
      upstream: upstreamEvidence(source.template_uuid, kind, item),
      item_id: item.uuid,
      display_name: item.name,
      metric: candidate.metric,
      unit: candidate.unit,
      dimensions: Object.fromEntries(candidate.dimensions.map(dimension => [dimension.name, dimension.meaning])),
      package_release: candidate.package_release,
      implementation_id: candidate.implementation_id,
      raw_field: candidate.raw_field,
      note: rule.note,
    });
  };

  for (const item of template.items ?? []) addItem('item', item);
  for (const rule of template.discovery_rules ?? []) {
    // Discovery itself is a later phase; a discovery master is never an item.
    unsupported.push({
      upstream: upstreamEvidence(source.template_uuid, 'prototype', { ...rule, uuid: rule.uuid, name: rule.name, key: rule.key }),
      reason: 'discovery_not_delivered',
    });
    for (const prototype of rule.item_prototypes ?? []) addItem('prototype', prototype);
  }

  // No expression in the three fixed templates is a single converted-item
  // threshold. Even a single-item comparison would only produce a rule
  // reference: rule versions and evaluation belong to MAX-239, which is not
  // implemented here, so every upstream trigger stays unsupported.
  const triggers: StoredTrigger[] = (doc.zabbix_export.triggers ?? []).map(trigger => ({
    upstream: { uuid: trigger.uuid, name: trigger.name, expression: trigger.expression, priority: trigger.priority ?? null },
    reason: 'not_single_converted_item_threshold',
  }));

  const credentialMacros = (template.macros ?? [])
    .map(macro => macro.macro)
    .filter(macro => CREDENTIAL_MACROS.has(macro));

  return {
    category: source.category,
    source: {
      url: source.url,
      path: source.path,
      commit: ZABBIX_REFERENCE.commit,
      license: ZABBIX_REFERENCE.license,
      template_uuid: source.template_uuid,
      template_name: source.template_name,
      export_version: doc.zabbix_export.version,
    },
    template_id: source.template_uuid,
    name: source.template_name,
    interval_ms: DEFAULT_INTERVAL_MS,
    parameters: {
      schema: { interval_ms: { type: 'integer', min: MIN_INTERVAL_MS, max: MAX_INTERVAL_MS } },
      defaults: { interval_ms: DEFAULT_INTERVAL_MS },
    },
    items: items.sort((a, b) => (a.item_id < b.item_id ? -1 : a.item_id > b.item_id ? 1 : 0)),
    unsupported,
    triggers,
    credential_macros_dropped: credentialMacros,
    graphs_not_converted: (doc.zabbix_export.graphs ?? []).map(graph => graph.name), // discovery/graphs are a later phase
  };
}
