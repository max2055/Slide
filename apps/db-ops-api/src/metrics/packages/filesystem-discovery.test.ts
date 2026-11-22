import { describe,it,expect } from 'vitest';
import { collectFilesystems, FILESYSTEM_CAPACITY_COMMAND } from './filesystem-discovery.js';
import type { Transport } from './adapters.js';
const row=(mount='/data',fsid='42')=>({mount_id:'7',device:'0:22',mount,fs_type:'tmpfs',fsid,used:'4096'});
const packet=(rows=[row()])=>({boot:'12345678-1234-1234-1234-123456789abc',namespace:'mnt:[32]',before:rows.map(({fsid,used,...r})=>r),rows,after:rows.map(({fsid,used,...r})=>r)});
const read=(v:any,truncated=false,max=100)=>collectFilesystems({method:'ssh',client:null as never,pool:{execCommands:async()=>[{stdout:typeof v==='string'?v:JSON.stringify(v),stderr:'',exitCode:0,signal:null,truncated}]}} as Transport & {method:'ssh'},5000,max);
describe('MAX245 filesystem complete inventory and stable identity',()=>{
  it('retains identity across mount move and reader restart, separates newly created filesystem',async()=>{const a=(await read(packet()))[0],b=(await read(packet([row('/renamed')])))[0],c=(await read(packet([row('/data','43')])))[0];expect(a.dimensions.filesystem_epoch).toBe(b.dimensions.filesystem_epoch);expect(a.dimensions.filesystem_epoch).not.toBe(c.dimensions.filesystem_epoch);expect(a.fields.used).toEqual({encoding:'uint64',value:'4096'});});
  it('separates boot and namespace lifetimes',async()=>{const p=packet(),a=(await read(p))[0];p.namespace='mnt:[33]';expect((await read(p))[0].dimensions.filesystem_epoch).not.toBe(a.dimensions.filesystem_epoch);p.namespace='mnt:[32]';p.boot='22345678-1234-1234-1234-123456789abc';expect((await read(p))[0].dimensions.filesystem_epoch).not.toBe(a.dimensions.filesystem_epoch);});
  it('rejects incomplete, truncated, changed and over-budget inventory rather than accepting empty',async()=>{await expect(read('{}')).rejects.toThrow();await expect(read(packet(),true)).rejects.toThrow();await expect(read(packet(),false,0)).rejects.toThrow();const p=packet();p.after=[];await expect(read(p)).rejects.toThrow();p.after=p.before;p.rows=[];await expect(read(p)).rejects.toThrow();expect(await read(packet([]))).toEqual([]);});
  it('rejects ambiguous duplicate bind roots, invalid fsid and uint64 overflow',async()=>{await expect(read(packet([row(),row('/bind')]))).rejects.toThrow();for(const fsid of ['0','-1','unknown'])await expect(read(packet([row('/data',fsid)]))).rejects.toThrow();const p=packet();p.rows[0].used='18446744073709551616';await expect(read(p)).rejects.toThrow();});
});

describe('filesystem capacity from one statvfs record per member', () => {
  const readCapacity = (fsType: string, stats = { total: '100', available: '19', inodes_total: '120',
    inodes_free: '40', inodes_available: '20' }) => {
    const data = { ...row(), fs_type: fsType, used: '76' };
    const output = { ...packet([data]), rows: [{ ...data, capacity: stats }] };
    return collectFilesystems({ method: 'ssh', client: null as never, pool: {
      async execCommands(_client, commands) {
        expect(commands).toEqual([FILESYSTEM_CAPACITY_COMMAND]);
        return [{ stdout: JSON.stringify(output), stderr: '', exitCode: 0, signal: null, truncated: false }];
      },
    } }, 5000, 100, true);
  };

  it('uses nonprivileged block and inode denominators and keeps the old member identity', async () => {
    const [old] = await read(packet());
    const [current] = await readCapacity('tmpfs');
    expect(current.dimensions).toEqual(old.dimensions);
    expect(current.fields).toEqual({
      total: { encoding: 'uint64', value: '100' }, available: { encoding: 'uint64', value: '19' },
      used: { encoding: 'uint64', value: '76' }, used_percent: { encoding: 'float64', value: 80 },
      inode_available_percent: { encoding: 'float64', value: 20 },
    });
  });

  it('keeps capacity on btrfs without fabricating a free inode percentage', async () => {
    const [current] = await readCapacity('btrfs');
    expect(current.fields.used_percent).toEqual({ encoding: 'float64', value: 80 });
    expect(current.fields.inode_available_percent).toBeNull();
    expect(current.field_evidence?.inode_available_percent.quality).toEqual({ status: 'unknown', reason: 'not_applicable' });
  });

  it('rejects inconsistent capacity as an incomplete enumeration', async () => {
    await expect(readCapacity('ext4', { total: '80', available: '19', inodes_total: '120', inodes_free: '40',
      inodes_available: '20' })).rejects.toMatchObject({ code: 'parse_error' });
  });
});
