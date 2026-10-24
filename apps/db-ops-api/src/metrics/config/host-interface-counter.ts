import { createHash } from 'node:crypto';
import { AdapterError, classifyError, type DriverEvidence, type Transport } from '../packages/adapters.js';

// Identity and counters come from one SSH batch. The interface index is
// kernel-assigned, so a recreated eth0 is a new generation; the network
// namespace inode separates otherwise identical names across namespaces.
export const HOST_INTERFACE_SNAPSHOT_COMMAND = `LC_ALL=C; export LC_ALL
identity() {
  printf 'BOOT '; cat /proc/sys/kernel/random/boot_id || return 1
  printf 'BTIME '; awk '$1 == "btime" {print $2}' /proc/stat || return 1
  printf 'NETNS '; readlink /proc/self/ns/net || return 1
  for d in /sys/class/net/*; do
    [ -d "$d" ] || continue
    n="\${d##*/}"
    printf 'IF %s ' "$n"
    cat "$d/ifindex" || return 1
  done
}
identity && printf 'STATS\n' && cat /proc/net/dev && printf 'END\n' && identity`;

function inventory(text: string) {
  const lines = text.trim().split('\n');
  const boot = /^BOOT ([a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12})$/.exec(lines.shift() ?? '')?.[1];
  const seconds = /^BTIME ([1-9]\d{0,9})$/.exec(lines.shift() ?? '')?.[1];
  const netns = /^NETNS (\S{1,128})$/.exec(lines.shift() ?? '')?.[1];
  if (!boot || !seconds || !netns || !/^net:\[[1-9]\d{0,19}\]$/.test(netns) || lines.length > 1000) throw new AdapterError('parse_error');
  const interfaces: Record<string, string> = Object.create(null);
  for (const line of lines) {
    const match = /^IF ([a-zA-Z0-9_.:-]{1,15}) ([1-9]\d{0,9})$/.exec(line);
    if (!match || Object.hasOwn(interfaces, match[1])) throw new AdapterError('parse_error');
    interfaces[match[1]] = match[2];
  }
  return { boot, at: new Date(Number(seconds) * 1000).toISOString(), netns, interfaces };
}

/** Losing process-local discovery causes a fresh baseline, never a fabricated rate. */
export class HostInterfaceDiscovery {
  private members = new Map<string, { epoch: string; observed_at: string }>();
  constructor(private readonly clock = () => new Date().toISOString()) {}
  async read(transport: Extract<Transport, { method: 'ssh' }>, timeoutMs: number) {
    let result;
    try { result = await transport.pool.execCommands(transport.client, [HOST_INTERFACE_SNAPSHOT_COMMAND], { timeoutMs, maxOutputBytes: 65536 }); }
    catch (error) { throw new AdapterError(classifyError(error)); }
    if (result.length !== 1 || result[0].truncated || Buffer.byteLength(result[0].stdout) > 65536) throw new AdapterError('parse_error');
    if (result[0].exitCode !== 0) throw new AdapterError(/permission denied/i.test(result[0].stderr) ? 'permission_denied' : 'parse_error');
    const parts = result[0].stdout.split(/^STATS\n|^END\n/m);
    if (parts.length !== 3) throw new AdapterError('parse_error');
    const before = inventory(parts[0]), after = inventory(parts[2]);
    if (before.boot !== after.boot || before.at !== after.at || before.netns !== after.netns
      || JSON.stringify(before.interfaces) !== JSON.stringify(after.interfaces)) throw new AdapterError('parse_error');
    const observed_at = this.clock();
    if (!Number.isFinite(Date.parse(observed_at)) || Date.parse(before.at) > Date.parse(observed_at)) throw new AdapterError('parse_error');
    const current = new Map<string, { epoch: string; observed_at: string }>();
    for (const [name, index] of Object.entries(before.interfaces)) {
      const epoch = createHash('sha256').update(JSON.stringify([before.boot, before.netns, index])).digest('hex');
      const old = this.members.get(name);
      current.set(name, old?.epoch === epoch ? old : { epoch, observed_at });
    }
    this.members = current;
    const evidence: DriverEvidence = { host_counter_epochs: { boot: { epoch: before.boot, observed_at: before.at },
      interfaces: Object.fromEntries(current), devices: {} } };
    return { stdout: parts[1], observed_at, evidence };
  }
}

export class HostInterfaceDiscoveryCache {
  private readonly entries = new Map<number, { fingerprint: string; discovery: HostInterfaceDiscovery }>();
  constructor(private readonly limit = 4096) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error('DISCOVERY_CACHE_LIMIT');
  }
  get(id: number, fingerprint: string): HostInterfaceDiscovery {
    const previous = this.entries.get(id);
    const entry = previous?.fingerprint === fingerprint ? previous : { fingerprint, discovery: new HostInterfaceDiscovery() };
    this.entries.delete(id); this.entries.set(id, entry);
    if (this.entries.size > this.limit) this.entries.delete(this.entries.keys().next().value!);
    return entry.discovery;
  }
  forget(id: number): void { this.entries.delete(id); }
}
