import { createHash } from 'node:crypto';
import { AdapterError, classifyError, type Transport, type DecodedRow } from './adapters.js';

// Fixed, read-only helper. Only filesystem roots are discovered: subvolume/bind
// subroots and other filesystem types are outside this registered capability.
const discoveryCommand = (capacity: boolean) => `LC_ALL=C python3 - <<'SLIDE_FILESYSTEM'
import os, json, re
def inventory():
    text = open('/proc/self/mountinfo').read()
    if not text.endswith('\\n') or not text or len(text) > 262144: raise ValueError('inventory limit or incomplete record')
    rows = []
    roots = 0
    for line in text.splitlines():
        fields, rest = line.split(' - ', 1)
        f, r = fields.split(), rest.split()
        if len(f) < 6 or len(r) < 3: raise ValueError('mount record')
        if f[4] == '/': roots += 1
        if r[0] not in ('ext4', 'xfs', 'btrfs', 'tmpfs') or f[3] != '/': continue
        path = re.sub(r'\\\\([0-7]{3})', lambda m: chr(int(m[1], 8)), f[4])
        if any(path == p or path.startswith(p+'/') for p in ('/proc', '/sys', '/dev')): continue
        rows.append(dict(mount_id=f[0], device=f[2], mount=path, fs_type=r[0]))
    if len(rows) > 100 or roots != 1: raise ValueError('member limit or missing root')
    return rows
boot = open('/proc/sys/kernel/random/boot_id').read().strip()
namespace = os.readlink('/proc/self/ns/mnt')
before = inventory()
rows = []
for row in before:
    dev = os.stat(row['mount']).st_dev
    if str(os.major(dev))+':'+str(os.minor(dev)) != row['device']: raise ValueError('overmounted or changed filesystem')
    s = os.statvfs(row['mount'])
    ${capacity ? `entry = dict(row, fsid=str(s.f_fsid), used=str((s.f_blocks-s.f_bfree)*s.f_frsize))
    entry['capacity'] = dict(total=str(s.f_blocks*s.f_frsize), available=str(max(s.f_bavail, 0)*s.f_frsize),
        inodes_total=str(s.f_files), inodes_free=str(s.f_ffree), inodes_available=str(s.f_favail))
    rows.append(entry)` : 'rows.append(dict(row, fsid=str(s.f_fsid), used=str((s.f_blocks-s.f_bfree)*s.f_frsize)))'}
after = inventory()
if before != after: raise ValueError('inventory changed')
print(json.dumps(dict(boot=boot, namespace=namespace, before=before, rows=rows, after=after)))
SLIDE_FILESYSTEM`;

export const FILESYSTEM_DISCOVERY_COMMAND = discoveryCommand(false);
export const FILESYSTEM_CAPACITY_COMMAND = discoveryCommand(true);
export const FILESYSTEM_INODE_AVAILABLE_METRIC = 'linux.filesystem.discovered_inode_available_percent';

function unsigned(value: unknown): bigint {
  if (typeof value !== 'string' || !/^\d{1,20}$/.test(value)) throw new AdapterError('parse_error');
  const parsed = BigInt(value);
  if (parsed >= (1n << 64n)) throw new AdapterError('parse_error');
  return parsed;
}

function capacityFields(value: {total?: unknown; available?: unknown; inodes_total?: unknown;
  inodes_free?: unknown; inodes_available?: unknown} | undefined, used: bigint, fsType: string): Pick<DecodedRow, 'fields' | 'field_evidence'> {
  const total = unsigned(value?.total), available = unsigned(value?.available);
  if (used + available > total) throw new AdapterError('parse_error');
  const utilized = used + available;
  // Match the Linux pused denominator, which excludes blocks reserved for privileged users.
  const usedPercent = utilized ? 100 * (Number(used) / Number(utilized)) : 0;
  let inodePercent: { encoding: 'float64'; value: number } | null = null;
  if (fsType !== 'btrfs') {
    const inodesTotal = unsigned(value?.inodes_total), inodesFree = unsigned(value?.inodes_free);
    const inodesAvailable = unsigned(value?.inodes_available);
    if (inodesAvailable > inodesFree || inodesFree > inodesTotal) throw new AdapterError('parse_error');
    const inodesUsable = inodesTotal - inodesFree + inodesAvailable;
    if (inodesUsable) inodePercent = { encoding: 'float64', value: 100 * (Number(inodesAvailable) / Number(inodesUsable)) };
  }
  return {
    fields: { total: { encoding: 'uint64', value: String(total) }, available: { encoding: 'uint64', value: String(available) },
      used_percent: { encoding: 'float64', value: usedPercent }, inode_available_percent: inodePercent },
    ...(inodePercent ? {} : { field_evidence: { inode_available_percent: { quality: { status: 'unknown', reason: 'not_applicable' } } } }),
  };
}

export async function collectFilesystems(transport:Extract<Transport,{method:'ssh'}>,timeoutMs:number,maxRows:number,capacity=false):Promise<DecodedRow[]> {
  try {
    const started=Date.now();
    const results=await transport.pool.execCommands(transport.client,[capacity ? FILESYSTEM_CAPACITY_COMMAND : FILESYSTEM_DISCOVERY_COMMAND],{timeoutMs,maxOutputBytes:65536});
    if(Date.now()-started>=timeoutMs)throw new AdapterError('timeout');
    const r=results[0];
    if(results.length!==1||!r||r.truncated||Buffer.byteLength(r.stdout)>65536||r.exitCode!==0)throw new AdapterError(r?.stderr.match(/permission denied/i)?'permission_denied':'parse_error');
    const v=JSON.parse(r.stdout);
    if(!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(v.boot)||!/^mnt:\[[1-9]\d*\]$/.test(v.namespace)
      ||!Array.isArray(v.before)||!Array.isArray(v.after)||!Array.isArray(v.rows)||v.rows.length>Math.min(maxRows,100)
      ||JSON.stringify(v.before)!==JSON.stringify(v.after)||v.before.length!==v.rows.length)throw new AdapterError('parse_error');
    const seen=new Set<string>(),paths=new Set<string>();
    return v.rows.map((row:any,i:number)=>{
      const {fsid,used,capacity:stats,...metadata}=row;
      const usedBytes = unsigned(used);
      if(JSON.stringify(metadata)!==JSON.stringify(v.before[i])||!/^\d+:\d+$/.test(row.device)||!/^\d+$/.test(row.mount_id)
        ||typeof row.mount!=='string'||!row.mount.startsWith('/')||row.mount.length>128||paths.has(row.mount)
        ||!['ext4','xfs','btrfs','tmpfs'].includes(row.fs_type)||!(/^[1-9]\d{0,19}$/).test(fsid)||(!capacity && stats !== undefined))throw new AdapterError('parse_error');
      paths.add(row.mount);
      // mount ID and display path may change on remount/move. FSID owns identity;
      // duplicate bind roots cannot be distinguished, so reject rather than split.
      const epoch=createHash('sha256').update(JSON.stringify([v.boot,v.namespace,row.device,row.fs_type,fsid])).digest('hex');
      if(seen.has(epoch))throw new AdapterError('parse_error');seen.add(epoch);
      const extra = capacity ? capacityFields(stats, usedBytes, row.fs_type) : { fields: {} };
      return { ...extra, display_name:row.mount,dimensions:{mount:row.mount,filesystem_epoch:epoch,fs_type:row.fs_type},
        fields:{...extra.fields,used:{encoding:'uint64',value:used}} };
    });
  }catch(e){throw e instanceof AdapterError?e:new AdapterError(e instanceof SyntaxError?'parse_error':classifyError(e));}
}
