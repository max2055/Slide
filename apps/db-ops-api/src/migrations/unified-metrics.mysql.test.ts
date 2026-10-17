import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readdir, copyFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import mysql, { type Pool } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadMigrations, MigrationRunner, splitSqlStatements } from './runner.js';
import type { MigrationPool } from './types.js';

const port=Number(process.env.METRICS_TEST_MYSQL_PORT),container=process.env.UNIFIED_MIGRATION_CONTAINER;
describe.skipIf(!port||!container)('unified metric names: data preserving upgrade, collision, restart, concurrency and restore',()=>{
  const database=`max189_upgrade_${process.pid}`;
  let root:Pool,pool:Pool,directory:string,dump:Buffer;
  const source=new URL('../../sql/migrations/',import.meta.url),artifacts=process.env.UNIFIED_METRICS_EVIDENCE;
  const runner=()=>new MigrationRunner(pool as unknown as MigrationPool);
  beforeAll(async()=>{
    const label=JSON.parse(execFileSync('docker',['inspect',container!],{encoding:'utf8'}))[0].Config.Labels['slide.task'];expect(['MAX-189','MAX-192']).toContain(label);
    root=mysql.createPool({host:'127.0.0.1',port,user:'root',password:''});await root.query(`CREATE DATABASE ${database}`);
    pool=mysql.createPool({host:'127.0.0.1',port,user:'root',password:'',database,connectionLimit:10});
    directory=await mkdtemp(join(tmpdir(),'max189-migrations-'));
    for(const name of await readdir(source))if(name.endsWith('.sql')&&name<'121_')await copyFile(new URL(name,source),join(directory,name));
    await new MigrationRunner(pool as unknown as MigrationPool,directory).run();
    await pool.query("INSERT INTO metric_v2_observations(id,series_hash,stage,observed_at,stored_at,valid_value,payload,payload_hash) VALUES('retained-evidence',REPEAT('a',64),'raw','2026-01-02 03:04:05.123','2026-01-02 03:04:06.123',1,'{\"lineage\":[\"original\"],\"revision\":7,\"quality\":\"unknown\",\"epoch\":null}',REPEAT('b',64))");
    await pool.query("INSERT INTO metric_v2_policy_audit(target,payload) VALUES('instance:1','{\"request_id\":\"retained-publication\",\"revision\":7,\"action\":\"publish\"}')");
    dump=execFileSync('docker',['exec',container!,'mysqldump','-uroot','--single-transaction','--skip-comments',database],{maxBuffer:64*1024*1024});
    if(artifacts){await mkdir(artifacts,{recursive:true});await writeFile(join(artifacts,'pre-unified-metrics.sql'),dump);await writeFile(join(artifacts,'pre-unified-metrics.sha256'),createHash('sha256').update(dump).digest('hex')+'\n');}
  },120000);
  afterAll(async()=>{await pool?.end();if(root){await root.query(`DROP DATABASE IF EXISTS ${database}`);await root.end();}if(directory)await rm(directory,{recursive:true,force:true});});
  it('fails atomically on an old/new table collision and recovers only through checksum-bound explicit repair',async()=>{
    await pool.query("CREATE TABLE metric_observations(sentinel INT COMMENT 'Collision sentinel') COMMENT='Unrelated user table'");
    await expect(runner().run()).rejects.toThrow();
    const [old]=await pool.query<any[]>("SELECT payload FROM metric_v2_observations WHERE id='retained-evidence'");expect(old[0].payload).toEqual({lineage:['original'],revision:7,quality:'unknown',epoch:null});
    await pool.query('DROP TABLE metric_observations'); // Only the sentinel created by this test.
    const migration=(await loadMigrations()).find(m=>m.id==='121_unified_metric_names.sql')!;
    for(const statement of splitSqlStatements(migration.sql))await pool.query(statement);
    const repair=new MigrationRunner(pool as unknown as MigrationPool,undefined,{[migration.id]:{checksum:migration.checksum,verify:async c=>{
      const [rows]=await c.query<any[]>("SELECT payload FROM metric_observations WHERE id='retained-evidence'");expect(rows[0].payload).toEqual({lineage:['original'],revision:7,quality:'unknown',epoch:null});
      const [oldTables]=await c.query<any[]>("SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME LIKE 'metric_v2_%'");expect(oldTables).toEqual([]);
    }}});
    await repair.acknowledgeExternallyRepairedMigration(migration.id,'MAX189','Atomic rename and indexes verified against retained lineage');
    await Promise.all([repair.run(),runner().run()]);await runner().run();
    const [rows]=await pool.query<any[]>("SELECT payload,payload_hash FROM metric_observations WHERE id='retained-evidence'");
    expect(rows[0]).toEqual({payload:{lineage:['original'],revision:7,quality:'unknown',epoch:null},payload_hash:'b'.repeat(64)});
    const inspection=await runner().inspect();expect(inspection.every(m=>m.status==='completed'||m.status==='baselined')).toBe(true);
    if(artifacts)await writeFile(join(artifacts,'migration-gates.json'),JSON.stringify({collision:'atomic rejection',repair_checksum:migration.checksum,concurrent_and_repeated_runs:'passed',lineage:'unchanged',backup_bytes:dump.length},null,2));
  },30000);
  it('restores the original schema and evidence into an isolated recovery database',async()=>{
    const recovery=`${database}_restore`;await root.query(`CREATE DATABASE ${recovery}`);
    try{
      execFileSync('docker',['exec','-i',container!,'mysql','-uroot',recovery],{input:dump,maxBuffer:64*1024*1024});
      const [rows]=await root.query<any[]>(`SELECT payload,payload_hash FROM ${recovery}.metric_v2_observations WHERE id='retained-evidence'`);
      expect(rows[0]).toEqual({payload:{lineage:['original'],revision:7,quality:'unknown',epoch:null},payload_hash:'b'.repeat(64)});
      const [ledger]=await root.query<any[]>(`SELECT COUNT(*) AS n FROM ${recovery}.app_schema_migrations WHERE migration_id>='121_'`);expect(Number(ledger[0].n)).toBe(0);
      if(artifacts)await writeFile(join(artifacts,'rollback-restore.json'),JSON.stringify({restored_pre_upgrade_schema:true,lineage_preserved:true,new_migrations_absent:true},null,2));
    }finally{await root.query(`DROP DATABASE ${recovery}`);}
  },30000);
  it('restores the final schema including 126 queue cancellation, idempotency, audit and unchanged evidence time',async()=>{
    const recovery=`${database}_final_restore`;
    const queuePayload={id:'retained-bulk-job',state:'running',results:[{resource:{type:'instance',id:1},state:'published',request_id:'retained-publication',revision:7}]};
    await pool.execute("INSERT INTO metric_bulk_jobs(id,owner_id,idempotency_key,state,payload,cancel_requested,expires_at) VALUES(?,1,'retained-key','running',?,TRUE,'2026-01-02 03:05:00')",[queuePayload.id,JSON.stringify(queuePayload)]);
    await runner().run();
    const upgraded=execFileSync('docker',['exec',container!,'mysqldump','-uroot','--single-transaction','--skip-comments',database],{maxBuffer:64*1024*1024});
    await root.query(`CREATE DATABASE ${recovery}`);
    const snapshot=async(schema:string)=>{
      const [queue]=await root.query<any[]>(`SELECT id,owner_id,idempotency_key,state,payload,cancel_requested,DATE_FORMAT(expires_at,'%Y-%m-%d %H:%i:%s.%f') AS expires_at FROM ${schema}.metric_bulk_jobs ORDER BY id`);
      const [observations]=await root.query<any[]>(`SELECT id,payload,payload_hash,DATE_FORMAT(observed_at,'%Y-%m-%d %H:%i:%s.%f') AS observed_at,DATE_FORMAT(stored_at,'%Y-%m-%d %H:%i:%s.%f') AS stored_at FROM ${schema}.metric_observations ORDER BY id`);
      const [audit]=await root.query<any[]>(`SELECT target,payload FROM ${schema}.metric_policy_audit ORDER BY id`);
      const [ledger]=await root.query<any[]>(`SELECT migration_id,checksum,status FROM ${schema}.app_schema_migrations ORDER BY migration_id`);
      return {queue,observations,audit,ledger};
    };
    try{
      execFileSync('docker',['exec','-i',container!,'mysql','-uroot',recovery],{input:upgraded,maxBuffer:64*1024*1024});
      const restored=await snapshot(recovery);
      expect(restored).toEqual(await snapshot(database));
      expect(restored.queue[0]).toMatchObject({payload:queuePayload,cancel_requested:1,state:'running'});
      expect(restored.observations[0]).toMatchObject({observed_at:'2026-01-02 03:04:05.123000',stored_at:'2026-01-02 03:04:06.123000',payload:{quality:'unknown',epoch:null,revision:7,lineage:['original']}});
      expect(restored.audit[0].payload.request_id).toBe(queuePayload.results[0].request_id);
      expect(restored.ledger.find(m=>m.migration_id==='126_metric_bulk_jobs.sql')?.status).toBe('completed');
      await expect(root.execute(`INSERT INTO ${recovery}.metric_bulk_jobs(id,owner_id,idempotency_key,state,payload,expires_at) VALUES('duplicate',1,'retained-key','queued','{}',NOW())`)).rejects.toMatchObject({code:'ER_DUP_ENTRY'});
      await root.execute(`UPDATE ${recovery}.metric_bulk_jobs SET state='cancelled' WHERE id=?`,[queuePayload.id]);
      const [cancelled]=await root.query<any[]>(`SELECT state,cancel_requested,payload FROM ${recovery}.metric_bulk_jobs WHERE id=?`,[queuePayload.id]);
      expect(cancelled[0]).toEqual({state:'cancelled',cancel_requested:1,payload:queuePayload});
      if(artifacts){
        await writeFile(join(artifacts,'post-unified-metrics.sql'),upgraded);
        await writeFile(join(artifacts,'final-schema-restore.json'),JSON.stringify({database,recovery,container,code_head:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),post_upgrade_sha256:createHash('sha256').update(upgraded).digest('hex'),post_upgrade_bytes:upgraded.length,queue_cancel_and_unique_key_preserved:true,read_write_after_restore:true,snapshot:restored},null,2));
      }
    }finally{await root.query(`DROP DATABASE ${recovery}`);}
  },30000);
  it('has no generation names in active metric tables, columns, indexes or constraints',async()=>{
    const [tables]=await pool.query<any[]>("SELECT TABLE_NAME AS name,TABLE_COMMENT AS description FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME LIKE 'metric%'");
    const [columns]=await pool.query<any[]>("SELECT CONCAT(TABLE_NAME,'.',COLUMN_NAME) AS name,COLUMN_COMMENT AS description FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME LIKE 'metric%'");
    const [indexes]=await pool.query<any[]>("SELECT DISTINCT CONCAT(TABLE_NAME,'.',INDEX_NAME) AS name FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME LIKE 'metric%'");
    const [constraints]=await pool.query<any[]>("SELECT CONCAT(TABLE_NAME,'.',CONSTRAINT_NAME) AS name FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME LIKE 'metric%'");
    const residuals=[...tables,...columns,...indexes,...constraints].filter(row=>/\bv[12]\b|metric[_-]v[12]/i.test(`${row.name} ${row.description??''}`));
    if(artifacts)await writeFile(join(artifacts,'active-schema-names.json'),JSON.stringify({database,tables:tables.length,columns:columns.length,indexes:indexes.length,constraints:constraints.length,residuals},null,2));
    expect(residuals).toEqual([]);
  });
});
