/**
 * Fixed, locale-independent metrics supported by the server collector.
 *
 * The provider is deliberately data-only: callers can execute the commands
 * returned here, but cannot inject a command or a path. Parsers are bounded
 * because remote hosts are untrusted input and cardinality must stay finite.
 */

import { getServerOsProfile, isSupportedServerOs } from './server-os-profile.js';

export type ServerDimension = 'interface' | 'device' | 'mount' | 'direction';
export type MetricDimensions = Partial<Record<ServerDimension, string>>;

export interface MetricSample {
  name: string;
  value: number;
  dimensions: MetricDimensions | null;
}

export interface ProcessSample {
  pid: number;
  command: string;
  cpuPercent: number;
  memoryPercent: number;
}

export interface MetricDefinition {
  name: string;
  command: string;
  parse: (stdout: string) => number | null;
  /** Parse one command into bounded, dimensioned samples. */
  parseRows?: (stdout: string) => MetricSample[];
  /** Parse structured process evidence; not persisted as unbounded rows. */
  parseProcesses?: (stdout: string) => ProcessSample[];
  dimensions?: readonly ServerDimension[];
  osType: string;
  unit?: string;
  aggregation?: 'avg' | 'max' | 'min' | 'sum' | 'last';
  higherIsWorse?: boolean;
}

const MAX_INTERFACES = 128;
const MAX_DEVICES = 256;
const MAX_PROCESSES = 20;
const MAX_DIMENSION_LENGTH = 128;
const SECTOR_BYTES = 512;

const NETWORK_COMMAND = 'LC_ALL=C LANG=C cat /proc/net/dev';
const DISKSTATS_COMMAND = 'LC_ALL=C LANG=C cat /proc/diskstats';
const PROCESS_COUNT_COMMAND = 'LC_ALL=C LANG=C ps -e --no-headers | wc -l';
const PROCESS_LIST_COMMAND = 'LC_ALL=C LANG=C ps -eo pid=,comm=,pcpu=,pmem= --sort=-pcpu | head -n 20';

function boundedToken(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().replace(/[\u0000-\u001f\u007f]/g, ' ');
  if (!normalized || normalized.length > MAX_DIMENSION_LENGTH) return null;
  return normalized;
}

/**
 * Canonicalize dimensions and reject unknown keys. `fs_type` is retained as
 * The legacy filesystem collector keeps its richer filesystem shape outside
 * this function; new persisted dimensions use only the four canonical keys.
 */
export function canonicalDimensions(input: unknown): MetricDimensions | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const source = input as Record<string, unknown>;
  const allowed = new Set(['interface', 'device', 'mount', 'direction']);
  const result: MetricDimensions = {};
  for (const key of Object.keys(source).sort()) {
    if (!allowed.has(key)) continue;
    const value = boundedToken(source[key]);
    if (value !== null) result[key as keyof MetricDimensions] = value;
  }
  return Object.keys(result).length > 0 ? result : null;
}

function finiteNumber(value: string): number | null {
  if (!/^-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim())) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function finiteInteger(value: string): number | null {
  if (!/^\d+$/.test(value.trim())) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function scalar(stdout: string): number | null {
  return finiteNumber(stdout.trim().split(/\s+/)[0] ?? '');
}

function percent(stdout: string): number | null {
  const value = scalar(stdout);
  return value === null ? null : Math.round(value * 100) / 100;
}

/** Parse Linux /proc/net/dev into stable per-interface samples. */
export function parseProcNetDev(stdout: string): MetricSample[] {
  const samples: MetricSample[] = [];
  const seen = new Set<string>();
  for (const line of stdout.split(/\r?\n/).slice(0, MAX_INTERFACES + 2)) {
    // Data rows have one colon and sixteen whitespace-delimited counters;
    // the pipe characters exist only in the human-readable header.
    const match = /^\s*([^:]{1,128}):\s*(.*)$/.exec(line);
    if (!match) continue;
    const iface = boundedToken(match[1]);
    if (!iface || seen.has(iface) || seen.size >= MAX_INTERFACES) continue;
    const counters = match[2].trim().split(/\s+/);
    if (counters.length < 16) continue;
    const receive = counters.slice(0, 8);
    const transmit = counters.slice(8, 16);
    const values: Array<[string, string, string]> = [
      ['network_rx_bytes', 'rx', receive[0]],
      ['network_rx_errors', 'rx', receive[2]],
      ['network_rx_drops', 'rx', receive[3]],
      ['network_tx_bytes', 'tx', transmit[0]],
      ['network_tx_errors', 'tx', transmit[2]],
      ['network_tx_drops', 'tx', transmit[3]],
    ];
    const parsed = values.map(([name, direction, raw]) => ({
      name,
      direction,
      value: finiteInteger(raw),
    }));
    if (parsed.some((entry) => entry.value === null)) continue;
    seen.add(iface);
    for (const entry of parsed) {
      samples.push({
        name: entry.name,
        value: entry.value!,
        dimensions: canonicalDimensions({ interface: iface, direction: entry.direction }),
      });
    }
  }
  return samples;
}

/** Alias used by callers that refer to the proc file by name. */
export const parseNetworkInterfaceStats = parseProcNetDev;

/** Parse /proc/diskstats into byte and I/O-time samples. */
export function parseProcDiskstats(stdout: string): MetricSample[] {
  const samples: MetricSample[] = [];
  const seen = new Set<string>();
  for (const line of stdout.split(/\r?\n/).slice(0, MAX_DEVICES)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 14) continue;
    const device = boundedToken(fields[2]);
    if (!device || seen.has(device) || seen.size >= MAX_DEVICES || !/^[-_.A-Za-z0-9]+$/.test(device)) continue;
    const numbers = fields.slice(3, 14).map(finiteInteger);
    if (numbers.some((value) => value === null)) continue;
    // Linux fields: reads completed, merged, sectors read, time read,
    // writes completed, merged, sectors written, time written, in-flight,
    // time doing I/O, weighted time doing I/O.
    const sectorsRead = numbers[2]!;
    const sectorsWritten = numbers[6]!;
    const ioTimeMs = numbers[9]!;
    seen.add(device);
    const dimensions = canonicalDimensions({ device });
    samples.push(
      { name: 'disk_read_bytes', value: sectorsRead * SECTOR_BYTES, dimensions },
      { name: 'disk_write_bytes', value: sectorsWritten * SECTOR_BYTES, dimensions },
      { name: 'disk_io_time_ms', value: ioTimeMs, dimensions },
    );
  }
  return samples.filter((sample) => Number.isSafeInteger(sample.value) || Number.isFinite(sample.value));
}

export const parseDiskStats = parseProcDiskstats;

export function parseProcessCount(stdout: string): number | null {
  const value = finiteInteger(stdout.trim().split(/\s+/)[0] ?? '');
  return value === null || value > 1_000_000 ? null : value;
}

/** Parse the fixed ps projection, never returning more than 20 processes. */
export function parseTopProcesses(stdout: string): ProcessSample[] {
  const result: ProcessSample[] = [];
  for (const line of stdout.split(/\r?\n/).slice(0, MAX_PROCESSES)) {
    const match = /^\s*(\d+)\s+(\S+)\s+([\d.]+)\s+([\d.]+)\s*$/.exec(line);
    if (!match) continue;
    const pid = finiteInteger(match[1]);
    const cpu = finiteNumber(match[3]);
    const memory = finiteNumber(match[4]);
    const command = boundedToken(match[2]);
    if (pid === null || cpu === null || memory === null || !command || cpu < 0 || memory < 0) continue;
    result.push({ pid, command, cpuPercent: Math.min(cpu, 100), memoryPercent: Math.min(memory, 100) });
  }
  return result;
}

function maxProcessCpu(stdout: string): number | null {
  const rows = parseTopProcesses(stdout);
  return rows.length ? Math.max(...rows.map((row) => row.cpuPercent)) : null;
}

function maxProcessMemory(stdout: string): number | null {
  const rows = parseTopProcesses(stdout);
  return rows.length ? Math.max(...rows.map((row) => row.memoryPercent)) : null;
}

const baseDefinitions = (osType: string): MetricDefinition[] => [
  {
    name: 'cpu_usage',
    command: 'LC_ALL=C LANG=C top -bn1 | grep "Cpu(s)" | awk \'{print $2+$4}\'',
    parse: percent, osType, unit: '%', aggregation: 'avg', higherIsWorse: true,
  },
  {
    name: 'memory_usage',
    command: 'LC_ALL=C LANG=C free | grep Mem | awk \'{print $3/$2 * 100.0}\'',
    parse: percent, osType, unit: '%', aggregation: 'avg', higherIsWorse: true,
  },
  {
    name: 'memory_used',
    command: "LC_ALL=C LANG=C free -b | grep Mem | awk '{print $3}'",
    parse: scalar, osType, unit: 'bytes', aggregation: 'last', higherIsWorse: true,
  },
  {
    name: 'memory_total',
    command: "LC_ALL=C LANG=C free -b | grep Mem | awk '{print $2}'",
    parse: scalar, osType, unit: 'bytes', aggregation: 'last', higherIsWorse: false,
  },
  {
    name: 'swap_usage',
    command: "LC_ALL=C LANG=C free | grep Swap | awk '{if($2>0) print $3/$2*100; else print 0}'",
    parse: percent, osType, unit: '%', aggregation: 'avg', higherIsWorse: true,
  },
  {
    name: 'disk_usage',
    command: "LC_ALL=C LANG=C df -P | awk 'NR>1 {print $6,$5}'",
    parse: () => null, osType, unit: '%', aggregation: 'last', higherIsWorse: true,
  },
  { name: 'load_1min', command: "LC_ALL=C LANG=C cat /proc/loadavg | awk '{print $1}'", parse: scalar, osType, unit: 'load', aggregation: 'avg', higherIsWorse: true },
  { name: 'load_5min', command: "LC_ALL=C LANG=C cat /proc/loadavg | awk '{print $2}'", parse: scalar, osType, unit: 'load', aggregation: 'avg', higherIsWorse: true },
  { name: 'load_15min', command: "LC_ALL=C LANG=C cat /proc/loadavg | awk '{print $3}'", parse: scalar, osType, unit: 'load', aggregation: 'avg', higherIsWorse: true },
  { name: 'uptime', command: "LC_ALL=C LANG=C cat /proc/uptime | awk '{print $1}'", parse: scalar, osType, unit: 'seconds', aggregation: 'last', higherIsWorse: false },
  { name: 'disk_detail', command: 'LC_ALL=C LANG=C df -P -B1', parse: () => null, osType, unit: 'bytes', aggregation: 'last' },
  ...(['network_rx_bytes', 'network_tx_bytes', 'network_rx_errors', 'network_tx_errors', 'network_rx_drops', 'network_tx_drops'] as const).map((name) => ({
    name,
    command: NETWORK_COMMAND,
    parse: () => null,
    parseRows: parseProcNetDev,
    dimensions: ['interface', 'direction'] as const,
    osType,
    unit: name.endsWith('bytes') ? 'bytes' : 'count',
    aggregation: 'last' as const,
    higherIsWorse: !name.endsWith('bytes'),
  })),
  ...(['disk_read_bytes', 'disk_write_bytes', 'disk_io_time_ms'] as const).map((name) => ({
    name,
    command: DISKSTATS_COMMAND,
    parse: () => null,
    parseRows: parseProcDiskstats,
    dimensions: ['device'] as const,
    osType,
    unit: name === 'disk_io_time_ms' ? 'ms' : 'bytes',
    aggregation: 'last' as const,
    higherIsWorse: true,
  })),
  {
    name: 'process_count', command: PROCESS_COUNT_COMMAND, parse: parseProcessCount,
    osType, unit: 'count', aggregation: 'last', higherIsWorse: true,
  },
  {
    name: 'top_processes_cpu', command: PROCESS_LIST_COMMAND, parse: maxProcessCpu,
    parseProcesses: parseTopProcesses, osType, unit: '%', aggregation: 'max', higherIsWorse: true,
  },
  {
    name: 'top_processes_memory', command: PROCESS_LIST_COMMAND, parse: maxProcessMemory,
    parseProcesses: parseTopProcesses, osType, unit: '%', aggregation: 'max', higherIsWorse: true,
  },
];

export function isSupportedLinuxOsType(osType: string): boolean {
  return isSupportedServerOs(osType);
}

class ServerMetricProvider {
  private definitions = new Map<string, MetricDefinition>();

  getDefinitions(osType: string): MetricDefinition[] {
    const profile = getServerOsProfile(osType);
    const effective = profile?.canonical ?? null;
    if (!effective) return [];
    const definitions = baseDefinitions(effective);
    for (const definition of definitions) this.definitions.set(definition.name, definition);
    return definitions;
  }

  parseMetric(name: string, stdout: string): number | null {
    const definition = [...this.definitions.values()].find((entry) => entry.name === name)
      ?? baseDefinitions('rhel').find((entry) => entry.name === name);
    return definition?.parse(stdout) ?? null;
  }

  getAllCommands(osType: string): string[] {
    return [...new Set(this.getDefinitions(osType).map((definition) => definition.command))];
  }

  getCollectionBatches(osType: string): Array<{ command: string; definitions: MetricDefinition[] }> {
    const batches = new Map<string, MetricDefinition[]>();
    for (const definition of this.getDefinitions(osType)) {
      const list = batches.get(definition.command) ?? [];
      list.push(definition);
      batches.set(definition.command, list);
    }
    return [...batches.entries()].map(([command, definitions]) => ({ command, definitions }));
  }
}

const serverMetricProvider = new ServerMetricProvider();
export default serverMetricProvider;
export { ServerMetricProvider, NETWORK_COMMAND, DISKSTATS_COMMAND, PROCESS_COUNT_COMMAND, PROCESS_LIST_COMMAND };
