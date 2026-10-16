import { describe, expect, it } from 'vitest';
import { createConfigurationRegistry } from '../config/registry.js';
import { collectDatabase } from './collector.js';
import { implementationId } from './catalog.js';
import { diagnosticReads } from './diagnostics.js';

describe('compatible former realtime diagnostic fields', () => {
  it('keeps frozen releases and offers valid fields in a distinct release', () => {
    const releases = createConfigurationRegistry().list();
    const expected = {
      mysql: ['mysql.innodb.row_lock_average_ms','mysql.innodb.deadlocks_total','mysql.temporary.disk_tables_total','mysql.thread_cache.hit_percent','mysql.transactions.active','mysql.replication.behind_source_seconds'],
      postgresql: ['postgresql.database.tuples_returned_total','postgresql.database.blocks_read_total','postgresql.database.temp_files_total','postgresql.database.deadlocks_total','postgresql.transactions.active'],
      oracle: ['oracle.library_cache.pin_hit_percent','oracle.tablespaces.user_max_allocated_used_percent'],
      dameng: ['dameng.memory_pool.allocated_bytes','dameng.os.allocated_memory_bytes','dameng.sessions.active'],
    };
    for (const [engine, ids] of Object.entries(expected)) {
      const old = releases.find(r=>r.package.id===`${engine}-diagnostics`&&r.package.version==='1.0.0')!;
      const next = releases.find(r=>r.package.id===`${engine}-diagnostics`&&r.package.version==='1.1.0');
      expect(next, engine).toBeDefined();
      const outputs = next!.package.collectors.flatMap(c=>c.mappings.map(m=>m.metric.id));
      expect(outputs).toEqual(expect.arrayContaining(ids));
      expect(next!.package.digest).not.toBe(old.package.digest);
      expect(old.package.collectors.flatMap(c=>c.mappings.map(m=>m.metric.id))).not.toContain(ids[0]);
    }
  });
  it('keeps each replication channel and NULL lag, decodes status explicitly', async () => {
    const read=diagnosticReads.find(r=>r.name==='replication_channels')!;
    expect(read).toBeDefined();
    const rows=[{Channel_Name:'one',Seconds_Behind_Source:null,Replica_IO_Running:'Connecting',Replica_SQL_Running:'Yes'},
      {Channel_Name:'two',Seconds_Behind_Source:7,Replica_IO_Running:'Yes',Replica_SQL_Running:'No'}];
    const [a,b]=await collectDatabase(implementationId(read),{method:'sql',pool:{query:async()=>[rows,[]]}},{},1000);
    expect(a.dimensions).toEqual({channel:'one'});
    expect(a.fields).toMatchObject({lag:null,io_running:{encoding:'uint64',value:'0'},sql_running:{encoding:'uint64',value:'1'}});
    expect(b.dimensions).toEqual({channel:'two'});
    expect(b.fields.lag).toEqual({encoding:'float64',value:7});
    expect(await collectDatabase(implementationId(read),{method:'sql',pool:{query:async()=>[[],[]]}},{},1000)).toEqual([]);
  });
});
