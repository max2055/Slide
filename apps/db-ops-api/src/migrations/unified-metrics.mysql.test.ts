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
    const label=JSON.parse(execFileSync('docker',['inspect',container!],{encoding:'utf8'}))[0].Config.Labels['slide.task'];expect(label).toBe('MAX-189');
    root=mysql.createPool({host:'127.0.0.1',port,user:'root',password:''});await root.query(`CREATE DATABASE ${database}`);
    pool=mysql.createPool({host:'127.0.0.1',port,user:'root',password:'',database,connectionLimit:10});
    directory=await mkdtemp(join(tmpdir(),'max189-migrations-'));
    for(const name of await readdir(source))if(name.endsWith('.sql')&&name<'121_')await copyFile(new URL(name,source),join(directory,name));
    await new MigrationRunner(pool as unknown as MigrationPool,directory).run();
    await pool.query("INSERT INTO metric_v2_observations(id,series_hash,stage,observed_at,stored_at,valid_value,payload,payload_hash) VALUES('retained-evidence',REPEAT('a',64),'raw',NOW(),NOW(),1,'{\"lineage\":[\"original\"],\"revision\":7}',REPEAT('b',64))");
    dump=execFileSync('docker',['exec',container!,'mysqldump','-uroot','--single-transaction','--skip-comments',database],{maxBuffer:64*1024*1024});
    if(artifacts){await mkdir(artifacts,{recursive:true});await writeFile(join(artifacts,'pre-unified-metrics.sql'),dump);await writeFile(join(artifacts,'pre-unified-metrics.sha256'),createHash('sha256').update(dump).digest('hex')+'\n');}
  },120000);
  afterAll(async()=>{await pool?.end();if(root){await root.query(`DROP DATABASE IF EXISTS ${database}`);await root.end();}if(directory)await rm(directory,{recursive:true,force:true});});
  it('fails atomically on an old/new table collision and recovers only through checksum-bound explicit repair',async()=>{
    await pool.query("CREATE TABLE metric_observations(sentinel INT COMMENT 'Collision sentinel') COMMENT='Unrelated user table'");
    await expect(runner().run()).rejects.toThrow();
    const [old]=await pool.query<any[]>("SELECT payload FROM metric_v2_observations WHERE id='retained-evidence'");expect(old[0].payload).toEqual({lineage:['original'],revision:7});
    await pool.query('DROP TABLE metric_observations'); // Only the sentinel created by this test.
    const migration=(await loadMigrations()).find(m=>m.id==='121_unified_metric_names.sql')!;
    for(const statement of splitSqlStatements(migration.sql))await pool.query(statement);
    const repair=new MigrationRunner(pool as unknown as MigrationPool,undefined,{[migration.id]:{checksum:migration.checksum,verify:async c=>{
      const [rows]=await c.query<any[]>("SELECT payload FROM metric_observations WHERE id='retained-evidence'");expect(rows[0].payload).toEqual({lineage:['original'],revision:7});
      const [oldTables]=await c.query<any[]>("SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME LIKE 'metric_v2_%'");expect(oldTables).toEqual([]);
    }}});
    await repair.acknowledgeExternallyRepairedMigration(migration.id,'MAX189','Atomic rename and indexes verified against retained lineage');
    await Promise.all([repair.run(),runner().run()]);await runner().run();
    const [rows]=await pool.query<any[]>("SELECT payload,payload_hash FROM metric_observations WHERE id='retained-evidence'");
    expect(rows[0]).toEqual({payload:{lineage:['original'],revision:7},payload_hash:'b'.repeat(64)});
    const inspection=await runner().inspect();expect(inspection.every(m=>m.status==='completed'||m.status==='baselined')).toBe(true);
    if(artifacts)await writeFile(join(artifacts,'migration-gates.json'),JSON.stringify({collision:'atomic rejection',repair_checksum:migration.checksum,concurrent_and_repeated_runs:'passed',lineage:'unchanged',backup_bytes:dump.length},null,2));
  },30000);
  it('restores the original schema and evidence into an isolated recovery database',async()=>{
    const recovery=`${database}_restore`;await root.query(`CREATE DATABASE ${recovery}`);
    try{
      execFileSync('docker',['exec','-i',container!,'mysql','-uroot',recovery],{input:dump,maxBuffer:64*1024*1024});
      const [rows]=await root.query<any[]>(`SELECT payload,payload_hash FROM ${recovery}.metric_v2_observations WHERE id='retained-evidence'`);
      expect(rows[0]).toEqual({payload:{lineage:['original'],revision:7},payload_hash:'b'.repeat(64)});
      const [ledger]=await root.query<any[]>(`SELECT COUNT(*) AS n FROM ${recovery}.app_schema_migrations WHERE migration_id>='121_'`);expect(Number(ledger[0].n)).toBe(0);
      if(artifacts)await writeFile(join(artifacts,'rollback-restore.json'),JSON.stringify({restored_pre_upgrade_schema:true,lineage_preserved:true,new_migrations_absent:true},null,2));
    }finally{await root.query(`DROP DATABASE ${recovery}`);}
  },30000);
});
