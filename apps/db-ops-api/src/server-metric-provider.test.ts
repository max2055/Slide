import { describe, expect, it } from 'vitest';
import serverMetricProvider, {
  canonicalDimensions,
  parseMemoryUsage,
  parseDiskStats,
  parseNetworkInterfaceStats,
  parseProcessCount,
  parseTopProcesses,
  parseTopProcessesWithDiagnostics,
} from './server-metric-provider.js';
import { classifyCollectionFailure } from './migrations/metric-history/server-collector.js';

describe('server metric provider fixed parsers', () => {
  it('MAX-237 uses MemAvailable and leaves absent or inconsistent memory unknown', () => {
    expect(parseMemoryUsage('MemTotal: 1000 kB\nMemFree: 100 kB\nMemAvailable: 600 kB\n')).toBe(40);
    for (const output of ['', 'MemTotal: 1000 kB\nMemFree: 100 kB', 'MemTotal: 0 kB\nMemAvailable: 0 kB',
      'MemTotal: 1000 kB\nMemAvailable: 1001 kB', 'MemTotal: 1000 kB\nMemAvailable: -1 kB', 'MemTotal: 1000 kB\nMemAvailable: 5 MB',
      'MemTotal: 1000 kB\nMemAvailable: invalid\nMemAvailable: 500 kB',
      'MemTotal: 1000 kB\nMemAvailable: 500 kB\nMemAvailable: 600 kB']) expect(parseMemoryUsage(output)).toBeNull();
    expect(serverMetricProvider.getDefinitions('rhel').find(d => d.name === 'memory_usage')!.command).toBe('LC_ALL=C LANG=C cat /proc/meminfo');
  });
  it('parses bounded network dimensions and rx/tx counters', () => {
    const rows = parseNetworkInterfaceStats(' eth0: 100 1 2 3 4 5 6 7 200 8 9 10 11 12 13 14\n');
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'network_rx_bytes', value: 100, dimensions: { direction: 'rx', interface: 'eth0' } }),
      expect.objectContaining({ name: 'network_tx_drops', value: 10, dimensions: { direction: 'tx', interface: 'eth0' } }),
    ]));
    expect(rows.every((row) => Object.keys(row.dimensions ?? {}).every((key) => ['interface', 'direction'].includes(key)))).toBe(true);
  });

  it('converts disk sectors to bytes and keeps device cardinality bounded', () => {
    const rows = parseDiskStats('8 0 sda 1 2 3 4 5 6 7 8 9 10 11\n');
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'disk_read_bytes', value: 1536, dimensions: { device: 'sda' } }),
      expect.objectContaining({ name: 'disk_write_bytes', value: 3584 }),
      expect.objectContaining({ name: 'disk_io_time_ms', value: 10 }),
    ]));
  });

  it('parses process count and no more than twenty structured processes', () => {
    expect(parseProcessCount('42\n')).toBe(42);
    const rows = parseTopProcesses(Array.from({ length: 30 }, (_, i) => `${i + 1} proc${i} ${i}.5 1.0`).join('\n'));
    expect(rows).toHaveLength(20);
    expect(rows[0]).toMatchObject({ pid: 1, command: 'proc0', cpuPercent: 0.5 });
  });

  it('MAX-403/MAX-405 preserves spaced comm and multi-core pcpu and reports malformed rows', () => {
    const output = '123 my worker 250.5 3.0\n7 java 812.5 10.0\n42 sshd 1.0 0.2\nbad row\n8 invalid 20 100.1\n';
    expect(parseTopProcessesWithDiagnostics(output)).toEqual({ items: [
      { pid: 123, command: 'my worker', cpuPercent: 250.5, memoryPercent: 3 },
      { pid: 7, command: 'java', cpuPercent: 812.5, memoryPercent: 10 },
      { pid: 42, command: 'sshd', cpuPercent: 1, memoryPercent: 0.2 },
    ], malformedLines: 2 });
    expect(serverMetricProvider.parseMetric('top_processes_cpu', output)).toBeNull();
    expect(serverMetricProvider.parseMetric('top_processes_cpu', '7 java worker 812.5 10.0')).toBe(812.5);
    expect(serverMetricProvider.parseMetric('top_processes_memory', '7 java worker 812.5 100')).toBe(100);
  });

  it('rejects arbitrary dimension keys and unsupported OS labels', () => {
    expect(canonicalDimensions({ interface: 'eth0', arbitrary: 'x' })).toEqual({ interface: 'eth0' });
    expect(serverMetricProvider.getDefinitions('Ubuntu 22.04')).toEqual([]);
    expect(serverMetricProvider.getDefinitions('linux')).toEqual([]);
    expect(serverMetricProvider.getDefinitions('Kylin V10').length).toBeGreaterThan(0);
  });

  it('classifies SSH failures without collapsing authentication/network into command errors', () => {
    expect(classifyCollectionFailure(new Error('All configured authentication methods failed'))).toBe('authentication');
    expect(classifyCollectionFailure(new Error('connect ECONNREFUSED 10.0.0.1:22'))).toBe('network');
    expect(classifyCollectionFailure(new Error('SSH_COMMAND_TIMEOUT'))).toBe('command');
  });
});
