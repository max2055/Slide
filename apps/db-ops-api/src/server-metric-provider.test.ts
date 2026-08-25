import { describe, expect, it } from 'vitest';
import serverMetricProvider, {
  canonicalDimensions,
  parseDiskStats,
  parseNetworkInterfaceStats,
  parseProcessCount,
  parseTopProcesses,
} from './server-metric-provider.js';
import { classifyCollectionFailure } from './server-collector.js';

describe('server metric provider fixed parsers', () => {
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
