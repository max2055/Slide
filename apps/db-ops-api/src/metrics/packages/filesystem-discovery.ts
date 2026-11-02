import { createHash } from 'node:crypto';
import { AdapterError, classifyError, type Transport, type DecodedRow } from './adapters.js';

// Fixed, read-only helper. Only filesystem roots are discovered: subvolume/bind
// subroots and other filesystem types are outside this registered capability.
export const FILESYSTEM_DISCOVERY_COMMAND = `LC_ALL=C python3 - <<'SLIDE_FILESYSTEM'
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
    rows.append(dict(row, fsid=str(s.f_fsid), used=str((s.f_blocks-s.f_bfree)*s.f_frsize)))
after = inventory()
if before != after: raise ValueError('inventory changed')
print(json.dumps(dict(boot=boot, namespace=namespace, before=before, rows=rows, after=after)))
SLIDE_FILESYSTEM`;

export async function collectFilesystems(transport:Extract<Transport,{method:'ssh'}>,timeoutMs:number,maxRows:number):Promise<DecodedRow[]> {
  try {
    const started=Date.now();
    const results=await transport.pool.execCommands(transport.client,[FILESYSTEM_DISCOVERY_COMMAND],{timeoutMs,maxOutputBytes:65536});
    if(Date.now()-started>=timeoutMs)throw new AdapterError('timeout');
    const r=results[0];
    if(results.length!==1||!r||r.truncated||Buffer.byteLength(r.stdout)>65536||r.exitCode!==0)throw new AdapterError(r?.stderr.match(/permission denied/i)?'permission_denied':'parse_error');
    const v=JSON.parse(r.stdout);
    if(!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(v.boot)||!/^mnt:\[[1-9]\d*\]$/.test(v.namespace)
      ||!Array.isArray(v.before)||!Array.isArray(v.after)||!Array.isArray(v.rows)||v.rows.length>Math.min(maxRows,100)
      ||JSON.stringify(v.before)!==JSON.stringify(v.after)||v.before.length!==v.rows.length)throw new AdapterError('parse_error');
    const seen=new Set<string>(),paths=new Set<string>();
    return v.rows.map((row:any,i:number)=>{
      const {fsid,used,...metadata}=row;
      if(JSON.stringify(metadata)!==JSON.stringify(v.before[i])||!/^\d+:\d+$/.test(row.device)||!/^\d+$/.test(row.mount_id)
        ||typeof row.mount!=='string'||!row.mount.startsWith('/')||row.mount.length>128||paths.has(row.mount)
        ||!['ext4','xfs','btrfs','tmpfs'].includes(row.fs_type)||!(/^[1-9]\d{0,19}$/).test(fsid)||!(/^\d{1,20}$/).test(used)||BigInt(used)>=(1n<<64n))throw new AdapterError('parse_error');
      paths.add(row.mount);
      // mount ID and display path may change on remount/move. FSID owns identity;
      // duplicate bind roots cannot be distinguished, so reject rather than split.
      const epoch=createHash('sha256').update(JSON.stringify([v.boot,v.namespace,row.device,row.fs_type,fsid])).digest('hex');
      if(seen.has(epoch))throw new AdapterError('parse_error');seen.add(epoch);
      return {display_name:row.mount,dimensions:{mount:row.mount,filesystem_epoch:epoch,fs_type:row.fs_type},fields:{used:{encoding:'uint64' as const,value:used}}};
    });
  }catch(e){throw e instanceof AdapterError?e:new AdapterError(e instanceof SyntaxError?'parse_error':classifyError(e));}
}
