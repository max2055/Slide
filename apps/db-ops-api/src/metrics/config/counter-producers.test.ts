import { describe, expect, it } from 'vitest';
import { collectFixed, type Transport } from '../packages/adapters.js';
import { databaseReads } from '../database/catalog.js';
import { diagnosticReads } from '../database/diagnostics.js';
import { MysqlCounterDiscovery, mysqlCounterTransport } from './mysql-counter.js';
import { HostInterfaceDiscovery } from './host-interface-counter.js';

const counterSql = databaseReads.find(r => r.engine === 'mysql' && r.name === 'transactions')!.sql;
function statusRows(state: { uptime: number; flush: number; commits?: string }) {
  return [{ Variable_name: 'Uptime', Value: String(state.uptime) },
    { Variable_name: 'Uptime_since_flush_status', Value: String(state.flush) },
    { Variable_name: 'Com_commit', Value: state.commits ?? '10' }, { Variable_name: 'Com_rollback', Value: '2' }];
}
function transportFor(rows: () => unknown[], clock: () => string) {
  return mysqlCounterTransport(async () => ({ rows: rows() }), new MysqlCounterDiscovery(clock));
}

describe('trusted MySQL counter lifecycle', () => {
  it('keeps one epoch while both durations advance with elapsed time', async () => {
    let now = '2026-10-24T10:00:00.000Z';
    let state = { uptime: 100, flush: 40, commits: '10' };
    const transport = transportFor(() => statusRows(state), () => now);
    const first = await transport.counterQuery!({ sql: counterSql, timeout: 1000 });
    now = '2026-10-24T10:01:00.000Z'; state = { uptime: 160, flush: 100, commits: '20' };
    const second = await transport.counterQuery!({ sql: counterSql, timeout: 1000 });
    expect(first.counter!.discontinuity!.epoch).toBe(second.counter!.discontinuity!.epoch);
    expect(second.rows).toEqual([{ Variable_name: 'Com_commit', Value: '20' }, { Variable_name: 'Com_rollback', Value: '2' }]);
    expect(second.observed_at).toBe('2026-10-24T10:01:00.000Z');
  });

  it('starts a new epoch on FLUSH STATUS and on restart', async () => {
    let now = '2026-10-24T10:00:00.000Z';
    let state = { uptime: 100, flush: 40 };
    const transport = transportFor(() => statusRows(state), () => now);
    const initial = await transport.counterQuery!({ sql: counterSql, timeout: 1000 });
    now = '2026-10-24T10:01:00.000Z'; state = { uptime: 160, flush: 1 };
    const afterFlush = await transport.counterQuery!({ sql: counterSql, timeout: 1000 });
    expect(afterFlush.counter!.discontinuity!.epoch).not.toBe(initial.counter!.discontinuity!.epoch);
    expect(afterFlush.counter!.discontinuity!.reason).toBe('reset');
    now = '2026-10-24T10:02:00.000Z'; state = { uptime: 5, flush: 5 };
    const restarted = await transport.counterQuery!({ sql: counterSql, timeout: 1000 });
    expect(restarted.counter!.discontinuity!.epoch).not.toBe(afterFlush.counter!.discontinuity!.epoch);
    expect(restarted.counter!.discontinuity!.reason).toBe('boot');
  });

  it('rejects ordinary SQL, missing flush lifecycle and malformed snapshots', async () => {
    let now = '2026-10-24T10:00:00.000Z';
    const transport = transportFor(() => statusRows({ uptime: 100, flush: 40 }), () => now);
    await expect(transport.counterQuery!({ sql: 'SHOW GLOBAL STATUS', timeout: 1000 })).rejects.toMatchObject({ code: 'parse_error' });
    const missing = mysqlCounterTransport(async () => ({ rows: [{ Variable_name: 'Uptime', Value: '100' },
      { Variable_name: 'Com_commit', Value: '1' }, { Variable_name: 'Com_rollback', Value: '1' }] }), new MysqlCounterDiscovery(() => now));
    await expect(missing.counterQuery!({ sql: counterSql, timeout: 1000 })).rejects.toMatchObject({ code: 'parse_error', evidenceCode: 'MYSQL_COUNTER_LIFECYCLE_UNAVAILABLE' });
    const duplicate = mysqlCounterTransport(async () => ({ rows: [...statusRows({ uptime: 100, flush: 40 }), { Variable_name: 'Uptime', Value: '101' }] }),
      new MysqlCounterDiscovery(() => now));
    await expect(duplicate.counterQuery!({ sql: counterSql, timeout: 1000 })).rejects.toMatchObject({ code: 'parse_error' });
  });

  it('omits an unavailable business variable without inventing zero or losing the epoch', async () => {
    const innodb = diagnosticReads.find(r => r.engine === 'mysql' && r.name === 'innodb_diagnostics')!;
    const transport = mysqlCounterTransport(async () => ({ rows: [
      { Variable_name: 'Innodb_row_lock_time_avg', Value: '106' }, { Variable_name: 'Created_tmp_disk_tables', Value: '3' },
      ...statusRows({ uptime: 100, flush: 40 })] }), new MysqlCounterDiscovery(() => '2026-10-24T10:00:00.000Z'));
    const result = await transport.counterQuery!({ sql: innodb.sql, timeout: 1000 });
    expect((result.rows as Array<{ Variable_name: string }>).map(row => row.Variable_name)).toEqual(['Innodb_row_lock_time_avg', 'Created_tmp_disk_tables']);
    expect(result.counter!.discontinuity!.epoch).toBeTruthy();
  });

  it('does not reuse a generation when the observation clock moves backwards', async () => {
    let now = '2026-10-24T10:00:00.000Z';
    const transport = transportFor(() => statusRows({ uptime: 100, flush: 40 }), () => now);
    const first = await transport.counterQuery!({ sql: counterSql, timeout: 1000 });
    now = '2026-10-24T09:00:00.000Z';
    const second = await transport.counterQuery!({ sql: counterSql, timeout: 1000 });
    expect(second.counter!.discontinuity!.epoch).not.toBe(first.counter!.discontinuity!.epoch);
    expect(second.counter!.discontinuity!.reason).toBe('source_change');
  });

  it('binds every counter-bearing MySQL read to one lifecycle statement', async () => {
    const lifecycle = { uptime: 100, flush: 40 };
    let seen = '';
    const counters = diagnosticReads.find(r => r.engine === 'mysql' && r.name === 'diagnostic_counters')!;
    const status = mysqlCounterTransport(async sql => { seen = sql; return { rows: [
      { Variable_name: 'Slow_queries', Value: '3' }, { Variable_name: 'Bytes_received', Value: '100' },
      { Variable_name: 'Bytes_sent', Value: '200' }, { Variable_name: 'Handler_read_rnd_next', Value: '7' },
      { Variable_name: 'Aborted_connects', Value: '1' }, ...statusRows(lifecycle)] }; }, new MysqlCounterDiscovery(() => '2026-10-24T10:00:00.000Z'));
    const statusResult = await status.counterQuery!({ sql: counters.sql, timeout: 1000 });
    expect(seen).toContain('SHOW GLOBAL STATUS');
    expect(seen).toContain('Uptime_since_flush_status');
    expect(statusResult.rows).toHaveLength(5);
    expect(statusResult.counter!.discontinuity!.reason).toBe('reset');
  });
});

const boot = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const net = 'Inter-|   Receive                                                |  Transmit\n face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed\n  eth0: 100 1 0 0 0 0 0 0 200 2 0 0 0 0 0 0\n';
function identity(index = '2', ns = 'net:[4026531840]', bootId = boot) {
  return `BOOT ${bootId}\nBTIME 1700000000\nNETNS ${ns}\nIF eth0 ${index}\nIF lo 1\n`;
}
function sshTransport(parts: () => string[]) {
  return { method: 'ssh' as const, client: undefined as never, pool: { execCommands: async () => [{ stdout: parts().join('STATS\n' + net + 'END\n'),
    stderr: '', exitCode: 0, signal: null, truncated: false }] } } satisfies Transport;
}

describe('trusted Linux interface lifecycle', () => {
  it('uses the kernel interface index and netns in the epoch', async () => {
    const discovery = new HostInterfaceDiscovery();
    let before = identity(), after = identity();
    const transport = sshTransport(() => [before, after]);
    const first = await discovery.read(transport as Extract<Transport, { method: 'ssh' }>, 1000);
    expect(first.evidence.host_counter_epochs!.interfaces.eth0.epoch).toMatch(/^[a-f0-9]{64}$/);
    const second = await discovery.read(transport as Extract<Transport, { method: 'ssh' }>, 1000);
    expect(second.evidence.host_counter_epochs!.interfaces.eth0.epoch).toBe(first.evidence.host_counter_epochs!.interfaces.eth0.epoch);
    before = identity('7'); after = identity('7');
    const recreated = await discovery.read(transport as Extract<Transport, { method: 'ssh' }>, 1000);
    expect(recreated.evidence.host_counter_epochs!.interfaces.eth0.epoch).not.toBe(first.evidence.host_counter_epochs!.interfaces.eth0.epoch);
    before = identity('7', 'net:[4026531999]'); after = before;
    const namespaced = await discovery.read(transport as Extract<Transport, { method: 'ssh' }>, 1000);
    expect(namespaced.evidence.host_counter_epochs!.interfaces.eth0.epoch).not.toBe(recreated.evidence.host_counter_epochs!.interfaces.eth0.epoch);
  });

  it('refuses an interface identity that changes between the counters', async () => {
    const discovery = new HostInterfaceDiscovery();
    const transport = sshTransport(() => [identity('2'), identity('3')]);
    await expect(discovery.read(transport as Extract<Transport, { method: 'ssh' }>, 1000)).rejects.toMatchObject({ code: 'parse_error' });
  });

  it('lets the network package produce counters only with discovery evidence', async () => {
    const discovery = new HostInterfaceDiscovery();
    const transport = sshTransport(() => [identity(), identity()]);
    const evidence = { host_interfaces: discovery } as never;
    const rows = await collectFixed('builtin:linux.network.v1', transport as Extract<Transport, { method: 'ssh' }>, evidence, 1000, 100);
    expect(rows).toHaveLength(2);
    expect(rows[0].counter!.discontinuity!.epoch).toMatch(/^[a-f0-9-]{36}:[a-f0-9]{64}$/);
    await expect(collectFixed('builtin:linux.network.v1', transport as Extract<Transport, { method: 'ssh' }>, {}, 1000, 100))
      .rejects.toMatchObject({ code: 'parse_error', evidenceCode: 'HOST_INTERFACE_LIFECYCLE_UNAVAILABLE' });
  });
});

describe('network rows carry the same moment as their fresh generation', () => {
  const fakeClock = () => '2026-10-24T12:00:05.000Z';
  it('stamps rows from the snapshot so COUNTER_TIME holds on the first cycle', async () => {
    const discovery = new HostInterfaceDiscovery(fakeClock);
    const transport = sshTransport(() => [identity(), identity()]);
    const rows = await collectFixed('builtin:linux.network.v1', transport as Extract<Transport, { method: 'ssh' }>,
      { host_interfaces: discovery } as never, 1000, 100);
    for (const row of rows) expect(row.observed_at).toBe(fakeClock());
    expect(rows[0].counter!.discontinuity!.observed_at).toBe(fakeClock());
  });
  it('keeps the row moment at or after the generation stamp after reuse', async () => {
    let now = '2026-10-24T12:00:05.000Z';
    const discovery = new HostInterfaceDiscovery(() => now);
    const transport = sshTransport(() => [identity(), identity()]);
    await collectFixed('builtin:linux.network.v1', transport as Extract<Transport, { method: 'ssh' }>, { host_interfaces: discovery } as never, 1000, 100);
    now = '2026-10-24T12:01:05.000Z';
    const rows = await collectFixed('builtin:linux.network.v1', transport as Extract<Transport, { method: 'ssh' }>, { host_interfaces: discovery } as never, 1000, 100);
    for (const row of rows) {
      expect(Date.parse(row.counter!.discontinuity!.observed_at)).toBeLessThanOrEqual(Date.parse(row.observed_at!));
    }
  });
});

it('reports filesystems without inode accounting as not applicable', async () => {
  const bytes = 'Filesystem 1-blocks Used Available Use% Mounted on\n/dev/x 100 40 60 40% /\n/dev/y 100 1 99 1% /boot/efi\n';
  const inodes = 'Filesystem Inodes IUsed IFree IUse% Mounted on\n/dev/x 100 10 90 10% /\n/dev/y 0 0 0 - /boot/efi\n';
  const mounts = '/dev/x / xfs\n/dev/y /boot/efi vfat\n';
  const transport = { method: 'ssh' as const, client: undefined as never, pool: { execCommands: async (_client: unknown, commands: string[]) => {
    const outputs = [bytes, inodes, mounts];
    return commands.map((_command, index) => ({ stdout: outputs[index], stderr: '', exitCode: 0, signal: null, truncated: false }));
  } } };
  const rows = await collectFixed('builtin:linux.filesystem-diagnostics.v1', transport as Extract<Transport, { method: 'ssh' }>, {}, 1000, 100);
  const efi = rows.find(row => row.dimensions.mount === '/boot/efi')!;
  expect(efi.fields.inode_usage).toBeNull();
  expect(efi.field_evidence?.inode_usage).toEqual({ quality: { status: 'unknown', reason: 'not_applicable' } });
  const root = rows.find(row => row.dimensions.mount === '/')!;
  expect(root.field_evidence?.inode_usage).toBeUndefined();
});
