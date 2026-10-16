import { describe, expect, it, vi } from 'vitest';
import { compileReviewedSql, collectReviewedSql, sourceDigest, migrationItems } from './reviewed-sql.js';
import { diagnosticReleases, diagnosticReads } from './diagnostics.js';
import { createConfigurationRegistry } from '../config/registry.js';
import { runPackage } from '../packages/runner.js';
const source={id:'tenant_queue',target_type:'instance',unit:'count',value_type:'gauge',default_interval:60,collection_sqls:{mysql:'SELECT COUNT(*) FROM jobs'},compute_expr:null};
const base=diagnosticReleases().find(r=>r.package.id==='mysql-diagnostics'&&r.package.version==='1.1.0')!;
const {id,version,digest}=base.package;
const manifest=()=>({id:'custom-tenant-queue',version:'1.0.0',base:{id,version,digest},engine:'mysql',source_digest:sourceDigest(source,'mysql'),source_id:source.id,sql:source.collection_sqls.mysql,
  definition:{...diagnosticReads.find(r=>r.name==='active_transactions'&&r.engine==='mysql')!.fields[0].definition,namespace:'custom',id:'custom.tenant_queue',meaning:'Exact count of visible jobs in bound database; requires SELECT jobs.'},permissions:['SELECT jobs in bound database'],review:{reference:'review/test-fixture',reviewed_by:'fixture reviewer'}});
describe('reviewed custom SQL uses the unique package runner',()=>{
 it('blocks pending, stale or unsafe definitions with an actionable migration and never executes them',()=>{
   const entry=manifest();
   expect(migrationItems([source],'mysql',[])[0]).toMatchObject({state:'blocked',code:'CUSTOM_SQL_REVIEW_REQUIRED',source_digest:sourceDigest(source,'mysql')});
   expect(migrationItems([{...source,unit:'By'}],'mysql',[entry])[0].state).toBe('blocked');
   for(const sql of ['DELETE FROM jobs','SELECT SLEEP(1)','SELECT COUNT(*) FROM jobs; DELETE FROM jobs','SELECT * INTO OUTFILE \'/tmp/file\' FROM jobs']){
     expect(()=>compileReviewedSql([{...entry,sql}])).toThrow();
   }
   expect(()=>compileReviewedSql([{...entry,definition:{...entry.definition,unit:'invalid'}}])).toThrow();
 });
 it('installs an immutable release and executes the reviewed scalar, preserving exact uint64 and NULL',async()=>{
   const entry=manifest(),compiled=compileReviewedSql([entry]);
   const registry=createConfigurationRegistry([entry]);
   const release=compiled.releases[0].package;
   const pin={id:release.id,version:release.version,digest:release.digest};
   const query=vi.fn(async()=>[[{val:'9007199254740993'}],[]] as [unknown,unknown]);
   const at=new Date().toISOString();
   const result=await runPackage(registry,{package:pin,credential_ref:'credential:fixture',overrides:{}},{resource:{type:'instance',id:'1',attributes:{'db.engine':{value:'mysql',source:'fixture',observed_at:at},'db.version':{value:'9.6',source:'fixture',observed_at:at}}},binding_id:'instance:1',attempt_id:'custom',config_revision:2,observed_at:at,evidence:{},collector_ids:['reviewed_sql'],resolve:async()=>({method:'sql',pool:{query}}),collect:(id,t,e,timeout)=>collectReviewedSql(id,t,timeout,[entry])});
   expect(query).toHaveBeenCalledTimes(1);
   expect(result.observations[0].observation).toMatchObject({metric:{id:'custom.tenant_queue'},value:{encoding:'uint64',value:'9007199254740993'},versions:{config_revision:2}});
   expect(result.attempts[0].status).toBe('succeeded');
   expect(migrationItems([source],'mysql',[entry])[0]).toMatchObject({state:'reviewed',package:pin});
   expect(await collectReviewedSql(compiled.specs[0].id,{method:'sql',pool:{query:async()=>[[{val:null}],[]]}},1000,[entry])).toMatchObject([{fields:{val:null}}]);
   await expect(collectReviewedSql(compiled.specs[0].id,{method:'sql',pool:{query:async()=>[[{val:1},{val:2}],[]]}},1000,[entry])).rejects.toThrow('parse_error');
 });
});
