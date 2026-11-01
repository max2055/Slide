/** MAX-239 / MAX-238 integrated production path; isolated MySQL, controlled SQL transport. */
import mysql, { type Pool, type RowDataPacket } from 'mysql2/promise';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createOwnedDatabase, generateRunNonce, type OwnedDatabase } from '../../testing/owned-fixture.js';
import { MigrationRunner } from '../../migrations/runner.js';
import { dbConnection } from '../../db-connection.js';
import { actorContextService } from '../../auth/actor-context.js';
import { createConfigurationRegistry } from '../config/registry.js';
import { configurationInventory } from '../config/inventory.js';
import { MySqlTemplateRepository } from '../templates/mysql-repository.js';
import { MetricTemplateService } from '../templates/service.js';
import { TemplateBindingService } from '../templates/binding-service.js';
import { CollectNowService, createCollectNowAuthorizer } from '../templates/collect-now.js';
import { MysqlScheduleStore } from '../scheduler/store.js';
import { MetricScheduler } from '../scheduler/service.js';
import { JobRegistry } from '../../workflows/job-registry.js';
import { MysqlWorkflowStore, WorkerRuntime } from '../../workflows/worker-runtime.js';
import { decodeBindingPayload } from '../bindings/persistence-codec.js';
const port = Number(process.env.METRICS_TEST_MYSQL_PORT);
describe.skipIf(!port)('MAX238 applied-envelope consecutive collection', () => {
  let root: mysql.Connection, pool: Pool, owned: OwnedDatabase;
  beforeAll(async () => {
    if (!Number.isSafeInteger(port) || port === 3306) throw Error('isolated non3306 required');
    root = await mysql.createConnection({ host:'127.0.0.1', port, user:'root', password:'' });
    owned = await createOwnedDatabase(root, { nonce:generateRunNonce(), purpose:'consecutive', handleDir:join(process.cwd(), '.max238-history-handles') });
    pool = mysql.createPool({ host:'127.0.0.1', port, user:'root', password:'', database:owned.database, timezone:'Z', connectionLimit:10 });
    pool.on('connection', c => c.query("SET time_zone='+00:00'"));
    await new MigrationRunner(pool as never).run();
    vi.spyOn(dbConnection, 'getPool').mockReturnValue(pool);
    await pool.execute('UPDATE users SET session_version=1 WHERE id=1');
    await pool.execute("INSERT IGNORE INTO permissions(code,name,resource,action) VALUES('*','fixture','*','*')");
    await pool.execute("INSERT IGNORE INTO user_roles(user_id,role_id) SELECT 1,id FROM roles WHERE name='admin'");
    await pool.execute("INSERT IGNORE INTO role_permissions(role_id,permission_id) SELECT r.id,p.id FROM roles r,permissions p WHERE r.name='admin' AND p.code='*'");
    await pool.execute("INSERT INTO database_instances(id,name,environment,db_type,db_version,host,port,username,password_encrypted,status,lifecycle_state) VALUES(1,'fixture','testing','mysql','9.6','fixture.invalid',1,'fixture','','active','available')");
    await pool.execute("INSERT INTO instance_permissions(user_id,instance_id,access_level) VALUES(1,1,'admin')");
  },180000);
  afterAll(async () => { vi.restoreAllMocks(); await pool?.end(); if(owned) await owned.drop(); await root?.end(); },60000);
  it('applies, collects twice, changes cadence and preserves old history/proof; malformed applied proof is refused', async () => {
    const actor = (await actorContextService.loadActiveActor(1,1))!;
    const ref = { type:'instance' as const,id:1 };
    const registry = createConfigurationRegistry();
    const inventory = configurationInventory;
    const access = { resolve:async () => ({ resource:await inventory(ref),credential_ref:'credential:fixture',evidence:{},
      resolve:async () => ({ method:'sql',pool:{ query:async () => [[{Variable_name:'Uptime',Value:'95'},{Variable_name:'Queries',Value:'100'}],[]] } }) }) };
    const reload = (a: typeof actor) => actorContextService.revalidateActor(a);
    const reloadOn = (a: typeof actor,c: any) => actorContextService.revalidateActorOn(c,a,a.requestId,true);
    const service = new TemplateBindingService({ pool:() => pool,registry,access:access as never,inventory,reload,reloadOn,reloadOnLocked:reloadOn });
    const collect = new CollectNowService({ pool:() => pool,registry,reload,reloadOn });
    const repository = new MySqlTemplateRepository(pool as never);
    const templates = new MetricTemplateService(repository,registry);
    const t = await templates.create(actor as never,{name:'MAX238 consecutive'});
    const pkg = registry.list().map(e => e.package).find(p => p.id==='mysql-basic' && p.version==='2.0.0')!;
    const selected = await templates.selectMetric(actor as never,t.template_id,{package:{id:pkg.id,version:pkg.version,digest:pkg.digest},metric:{id:'db.uptime_seconds',semantic_version:'1.0.0'}});
    const draft = (await repository.getDraft(t.template_id))!;
    const aggregate = structuredClone(draft.aggregate); aggregate.items=[{item_id:selected.item.item_id,version:selected.item.version}];
    await repository.updateDraft(t.template_id,draft.revision,{aggregate,updated_by:1,updated_at:new Date().toISOString()});
    const published = await templates.publish(actor as never,t.template_id,{expected_draft_revision:(await repository.getDraft(t.template_id))!.revision,expected_revision:t.revision});
    const record = (await repository.getTemplate(t.template_id))!;
    await repository.updateTemplate(t.template_id,record.revision,{status:'active',updated_at:new Date().toISOString()});
    const version = (await repository.getVersion(t.template_id,published.version))!;
    const apply = async (revision:number,interval:number) => {
      const body={expected_revision:revision,template_pins:[{template_id:t.template_id,version:published.version,content_hash:version.content_hash}],overrides:{enabled:'enable',interval_ms:{mode:'set',value:interval}}};
      if (revision === 0) await service.probe(actor,ref,body);
      await service.trial(actor,ref,{...body,receipt_id:`trial-${revision}`});
      expect(await service.apply(actor,ref,{...body,receipt_id:`trial-${revision}`,caller_key:`apply-${revision}`})).toMatchObject({kind:'committed',revision:revision+1});
    };
    const jobs = new JobRegistry();
    new MetricScheduler(new MysqlScheduleStore(pool,registry,'production'),registry,access as never,Date.now,undefined,undefined,createCollectNowAuthorizer({
      loadActor:(id,v)=>actorContextService.loadActiveActor(id,v),loadActorOn:(c,id,v)=>actorContextService.loadActiveActorOn(c as never,id,v,undefined,true) })).register(jobs);
    const worker = new WorkerRuntime(new MysqlWorkflowStore(()=>pool as never),'max238-consecutive',30);
    const run = async (key:string,revision:number) => {
      await collect.collect(actor,ref,{caller_key:key,expected_revision:revision});
      let result:any;
      for(let n=0;n<30;n++) {
        await worker.runOnce((j,c)=>jobs.execute(j,c),Date.now());
        result=await collect.task(actor,ref,key);
        if(['completed','failed'].includes(result.state)) break;
        await new Promise(r=>setTimeout(r,100));
      }
      expect(result.state,JSON.stringify(result)).toBe('completed');
    };
    const rows = async (sql:string)=>(await pool.query<RowDataPacket[]>(sql))[0];
    const binding = async () => decodeBindingPayload((await rows("SELECT payload FROM metric_policy_bindings WHERE resource_key='instance:1'"))[0].payload);
    await apply(0,60000);
    expect((await service.readConfigurationAt(actor,ref,1)).state).toBe('published');
    await run('first',1);
    const first = await service.readConfigurationAt(actor,ref,1);
    expect(first).toMatchObject({state:'effective',settings:{interval_ms:60000}});
    const applied=await binding(); expect(applied.application.applied_revision).toBe(1);
    const proof=structuredClone(applied.payload.formal_commit);
    const count=(await rows('SELECT id FROM metric_observations')).length;
    await run('second',1);
    expect((await rows('SELECT id FROM metric_observations')).length).toBeGreaterThan(count);
    expect(await service.readConfigurationAt(actor,ref,1)).toEqual(first);
    expect((await binding()).payload.formal_commit).toEqual(proof);
    expect((await binding()).application.applied_revision).toBe(1);
    await apply(1,120000); await run('new-cadence',2);
    expect(await service.readConfigurationAt(actor,ref,1)).toEqual(first);
    expect(await service.readConfigurationAt(actor,ref,2)).toMatchObject({state:'effective',settings:{interval_ms:120000}});
    const malformed=structuredClone((await binding()).payload); delete malformed.formal_commit;
    expect(()=>decodeBindingPayload(malformed)).toThrow();
    expect(await service.readConfigurationAt(actor,ref,1)).toEqual(first);
  },60000);
});
