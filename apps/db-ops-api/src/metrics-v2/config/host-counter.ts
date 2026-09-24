import { createHash } from 'node:crypto';
import { AdapterError, classifyError, isHostBlockDevice, type DriverEvidence, type Transport } from '../packages/adapters.js';
import { parseProcDiskstatsExact } from '../../server-metric-provider.js';

// No interpolated inventory, commands, names or credentials. Read identity on both sides of counters.
// diskseq is supplied by the kernel; kernels without it cannot establish this counter lifecycle.
export const HOST_BLOCK_SNAPSHOT_COMMAND = `LC_ALL=C; export LC_ALL
identity() {
  printf 'BOOT '; cat /proc/sys/kernel/random/boot_id || return 1
  awk '$1 == "btime" {print "BTIME " $2}' /proc/stat || return 1
  for d in /sys/block/*; do
    [ -d "$d" ] || continue
    n="\${d##*/}"
    case "$n" in loop*|ram*|zram*|fd*|sr*) continue;; esac
    printf 'DEV %s ' "$n"
    cat "$d/diskseq" || return 1
  done
}
identity && printf 'STATS\n' && cat /proc/diskstats && printf 'END\n' && identity`;

function inventory(text: string) {
  const lines = text.trim().split('\n');
  const boot = /^BOOT ([a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12})$/.exec(lines.shift() ?? '')?.[1];
  const seconds = /^BTIME ([1-9]\d{0,9})$/.exec(lines.shift() ?? '')?.[1];
  if (!boot || !seconds || lines.length > 1000) throw new AdapterError('parse_error');
  const devices: Record<string, string> = Object.create(null);
  for (const line of lines) {
    const match = /^DEV ([a-zA-Z0-9_.!-]{1,128}) ([1-9]\d{0,19})$/.exec(line);
    if (!match || Object.hasOwn(devices, match[1]) || BigInt(match[2]) >= 1n << 64n) throw new AdapterError('parse_error');
    devices[match[1]] = match[2];
  }
  return { boot, at: new Date(Number(seconds) * 1000).toISOString(), devices };
}

/** Losing process-local discovery causes a fresh baseline, never a fabricated continuous rate. */
export class HostBlockDiscovery {
  private members = new Map<string, { epoch: string; observed_at: string }>();
  constructor(private readonly clock = () => new Date().toISOString()) {}
  async read(transport: Extract<Transport, { method: 'ssh' }>, timeoutMs: number) {
    let result;
    try { result = await transport.pool.execCommands(transport.client, [HOST_BLOCK_SNAPSHOT_COMMAND], { timeoutMs, maxOutputBytes: 65536 }); }
    catch (error) { throw new AdapterError(classifyError(error)); }
    if (result.length !== 1 || result[0].truncated || Buffer.byteLength(result[0].stdout) > 65536) throw new AdapterError('parse_error');
    if (result[0].exitCode !== 0) throw new AdapterError(/permission denied/i.test(result[0].stderr) ? 'permission_denied' : 'parse_error');
    const parts = result[0].stdout.split(/^STATS\n|^END\n/m);
    if (parts.length !== 3) throw new AdapterError('parse_error');
    const before = inventory(parts[0]), after = inventory(parts[2]);
    if (before.boot !== after.boot || before.at !== after.at || JSON.stringify(before.devices) !== JSON.stringify(after.devices)) throw new AdapterError('parse_error');
    const observed_at = this.clock();
    if (!Number.isFinite(Date.parse(observed_at)) || Date.parse(before.at) > Date.parse(observed_at)) throw new AdapterError('parse_error');
    const current = new Map<string, { epoch: string; observed_at: string }>();
    for (const row of parseProcDiskstatsExact(parts[1])) {
      const name = row.dimensions?.device;
      if (!name || !isHostBlockDevice(name)) continue;
      if (!Object.hasOwn(before.devices, name)) throw new AdapterError('parse_error');
      const epoch = createHash('sha256').update(JSON.stringify([before.boot, before.devices[name]])).digest('hex');
      const old = this.members.get(name);
      current.set(name, old?.epoch === epoch ? old : { epoch, observed_at });
    }
    this.members = current;
    const evidence: DriverEvidence = { host_counter_epochs: { boot: { epoch: before.boot, observed_at: before.at },
      interfaces: {}, devices: Object.fromEntries(current) } };
    return { stdout: parts[1], observed_at, evidence };
  }
}

export class HostBlockDiscoveryCache {
  private readonly entries = new Map<number, { fingerprint: string; discovery: HostBlockDiscovery }>();
  constructor(private readonly limit = 4096) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error('DISCOVERY_CACHE_LIMIT');
  }
  get(id: number, fingerprint: string): HostBlockDiscovery {
    const previous = this.entries.get(id);
    const entry = previous?.fingerprint === fingerprint ? previous : { fingerprint, discovery: new HostBlockDiscovery() };
    this.entries.delete(id); this.entries.set(id, entry);
    if (this.entries.size > this.limit) this.entries.delete(this.entries.keys().next().value!);
    return entry.discovery;
  }
  forget(id: number): void { this.entries.delete(id); }
}
