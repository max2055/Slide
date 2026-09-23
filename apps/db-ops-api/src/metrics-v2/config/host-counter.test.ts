import { describe, expect, it, vi } from 'vitest';
import { HostBlockDiscovery, HostBlockDiscoveryCache, HOST_BLOCK_SNAPSHOT_COMMAND } from './host-counter.js';
import { collectFixed, type Transport } from '../packages/adapters.js';

const boot = '00000000-1111-2222-3333-444444444444';
const at = '2026-09-23T03:00:00.000Z';
const inventory = (seq = '12', bootId = boot) => `BOOT ${bootId}\nBTIME 1700000000\nDEV sda ${seq}\n`;
const diskstats = '8 0 sda 1 0 20 0 1 0 40 0 0 50 0\n';
const snapshot = (before = inventory(), after = before, stats = diskstats) => before + 'STATS\n' + stats + 'END\n' + after;
function setup(discovery = new HostBlockDiscovery(() => at)) {
  const exec = vi.fn(async () => [{ stdout: snapshot(), stderr: '', exitCode: 0, signal: null, truncated: false }]);
  const transport: Transport = { method: 'ssh', client: undefined as never, pool: { execCommands: exec } };
  return { discovery, exec, run: () => collectFixed('builtin:linux.block.v1', transport, { host_blocks: discovery }, 1000, 100) };
}
describe('host block lifecycle discovery', () => {
  it('binds exact proc counters to boot identity and kernel diskseq within one bounded command', async () => {
    const s = setup(), rows = await s.run();
    expect(s.exec).toHaveBeenCalledExactlyOnceWith(undefined, [HOST_BLOCK_SNAPSHOT_COMMAND], { timeoutMs: 1000, maxOutputBytes: 65536 });
    expect(rows[0]).toMatchObject({ dimensions: { device: 'sda' }, observed_at: at,
      fields: { disk_read_bytes: { encoding: 'uint64', value: '10240' }, disk_write_bytes: { encoding: 'uint64', value: '20480' }, disk_io_time_ms: { encoding: 'uint64', value: '50' } }, counter: { bits: '64' } });
  });
  it('retains discovery time during continuity, resets on disk replacement or disappearance', async () => {
    let now = at;
    const s = setup(new HostBlockDiscovery(() => now));
    const first = (await s.run())[0].counter;
    now = '2026-09-23T03:01:00.000Z';
    expect((await s.run())[0].counter).toEqual(first);
    s.exec.mockResolvedValue([{ stdout: snapshot(inventory('13')), stderr: '', exitCode: 0, signal: null, truncated: false }]);
    expect((await s.run())[0].counter?.discontinuity?.epoch).not.toEqual(first?.discontinuity?.epoch);
    s.exec.mockResolvedValue([{ stdout: snapshot(`BOOT ${boot}\nBTIME 1700000000\n`, undefined, ''), stderr: '', exitCode: 0, signal: null, truncated: false }]);
    expect(await s.run()).toEqual([]);
    now = '2026-09-23T03:02:00.000Z';
    s.exec.mockResolvedValue([{ stdout: snapshot(), stderr: '', exitCode: 0, signal: null, truncated: false }]);
    expect((await s.run())[0].counter?.discontinuity?.observed_at).toBe(now);
  });
  it.each([
    snapshot(inventory(), inventory('13')),
    snapshot(inventory(), inventory('12', 'ffffffff-1111-2222-3333-444444444444')),
    snapshot(inventory().replace('DEV sda 12', 'DEV sda missing')),
    snapshot(inventory() + 'DEV sda 12\n'),
    snapshot(inventory().replace('BTIME 1700000000', 'BTIME 9999999999')),
    snapshot(inventory().replace('DEV sda 12\n', '')),
  ])('rejects reset during IO or missing/invalid authority', async stdout => {
    const s = setup(); s.exec.mockResolvedValue([{ stdout, stderr: '', exitCode: 0, signal: null, truncated: false }]);
    await expect(s.run()).rejects.toThrow('parse_error');
  });
  it('rejects truncated output and preserves authentication error category', async () => {
    const s = setup();
    s.exec.mockResolvedValueOnce([{ stdout: snapshot(), stderr: '', exitCode: 0, signal: null, truncated: true }]);
    await expect(s.run()).rejects.toThrow('parse_error');
    s.exec.mockRejectedValueOnce(Object.assign(new Error('secret detail'), { level: 'client-authentication' }));
    await expect(s.run()).rejects.toThrow('permission_denied');
  });
  it('isolates assets and discards continuity on identity changes, eviction and forget', () => {
    const cache = new HostBlockDiscoveryCache(2), a = cache.get(1, 'identity-a');
    expect(cache.get(1, 'identity-a')).toBe(a);
    expect(cache.get(2, 'identity-a')).not.toBe(a);
    expect(cache.get(1, 'identity-b')).not.toBe(a);
    cache.get(3, 'identity-c');
    expect(cache.get(2, 'identity-a')).not.toBe(a);
    const current = cache.get(1, 'identity-b'); cache.forget(1);
    expect(cache.get(1, 'identity-b')).not.toBe(current);
  });
});
