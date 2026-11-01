import {assetCollectionEnabled} from '../src/metrics/config/effective-state.js';
import {baseline,portOf,near} from '../src/metrics/triggers/test-support.js';
import {resolveTriggerRules} from '../src/metrics/triggers/resolve.js';
import {compileTriggerSnapshot} from '../src/metrics/triggers/compile.js';
import {evaluateTriggerRule} from '../src/metrics/triggers/evaluate.js';
import {nextTriggerEpisode} from '../src/metrics/triggers/episode.js';
import {alertEventService} from '../src/alert-event-service.js';
/** Disposable non3306 MySQL + production Fastify routes + actual Lit browser. No worker, model or external sends. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createRequire} from 'node:module';
import mysql from 'mysql2/promise';
import Fastify from 'fastify';
import {randomBytes} from 'node:crypto';
import {dbConnection} from '../src/db-connection.js';
import {MigrationRunner} from '../src/migrations/runner.js';
import {createOwnedDatabase} from '../src/testing/owned-fixture.js';
import {actorContextService,signAccessToken} from '../src/auth/actor-context.js';
import {createVerifyToken} from '../src/auth-middleware.js';
import {MaintenanceIntervals,maintenanceAt} from '../src/maintenance-intervals.js';
import {registerMaintenanceRoutes} from '../src/maintenance-routes.js';
import {maintenanceBlocksDelivery} from '../src/maintenance-notification.js';
const nonce=randomBytes(8).toString('hex'),directory=resolve('../../outputs/max244-'+nonce);
mkdirSync(directory,{recursive:true});
const docker=(...args:string[])=>execFileSync('docker',args,{encoding:'utf8'}).trim();
const handle={nonce,pid:process.pid,cwd:process.cwd(),container:'',schema:'',port:0};
const save=()=>writeFileSync(resolve(directory,'lifecycle.json'),JSON.stringify(handle,null,2));save();
let root:mysql.Pool|undefined,owned:Awaited<ReturnType<typeof createOwnedDatabase>>|undefined,vite:any,browser:any;
const app=Fastify();let now=Date.now();let pool:mysql.Pool;let failures=0;
try{
 handle.container=docker('run','-d','--rm','--label',`slide.max244.nonce=${nonce}`,'-e','MYSQL_ALLOW_EMPTY_PASSWORD=yes','-p','127.0.0.1::3306','mysql:8.4');save();
 handle.port=Number(docker('port',handle.container,'3306/tcp').split(':').at(-1));assert(handle.port!==3306&&handle.port>0);save();
 root=mysql.createPool({host:'127.0.0.1',port:handle.port,user:'root',password:''});
 const deadline=Date.now()+45000;for(;;){try{await root.query('SELECT 1');break;}catch(e){if(Date.now()>deadline)throw e;await new Promise(r=>setTimeout(r,300));}}
 owned=await createOwnedDatabase(root as any,{nonce,purpose:'maintenance',handleDir:directory});handle.schema=owned.database;save();
 assert(await dbConnection.initialize({host:'127.0.0.1',port:handle.port,user:'root',password:'',database:owned.database}));pool=dbConnection.getPool()!;
 await new MigrationRunner(pool as any).run();
 await pool.query("INSERT INTO database_instances(id,name,host,port,username,password_encrypted) VALUES(701,'授权数据库','fixture.invalid',3307,'fixture','unused'),(702,'越权数据库','fixture.invalid',3307,'fixture','unused')");
 await pool.query("INSERT INTO users(id,username,password_hash) VALUES(701,'maintenance-user','no-login'),(702,'maintenance-other','no-login')");
 await pool.query("INSERT INTO roles(id,name) VALUES(701,'maintenance-fixture')");
 await pool.query("INSERT IGNORE INTO permissions(code,name,resource,action) VALUES('maintenance:manage','维护','maintenance','manage'),('instance:manage','管理','instance','manage')");
 await pool.query("INSERT INTO role_permissions(role_id,permission_id) SELECT 701,id FROM permissions WHERE code IN ('maintenance:manage','instance:manage')");
 await pool.query('INSERT INTO user_roles(user_id,role_id) VALUES(701,701),(702,701)');
 await pool.query("INSERT INTO instance_permissions(user_id,instance_id,access_level) VALUES(701,701,'read-write')");
 const actor=await actorContextService.loadActiveActor(701),other=await actorContextService.loadActiveActor(702);
 const secret=randomBytes(32).toString('hex'),token=signAccessToken(actor,secret),otherToken=signAccessToken(other,secret);
 const verify=createVerifyToken(secret);
 const service=new MaintenanceIntervals(()=>pool,()=>now);
 await registerMaintenanceRoutes(app,verify,service);
 const api=async(method:string,url:string,payload?:any,t=token)=>{const r=await app.inject({method:method as any,url,headers:{authorization:`Bearer ${t}`},payload});return {status:r.statusCode,body:r.json()};};
 const value={name:'维护',reason:'受控维护验收',resources:[{type:'instance',id:701}],starts_at:new Date(now+1000).toISOString(),ends_at:new Date(now+10000).toISOString(),timezone:'Asia/Shanghai'};
 const create={operation_key:'create-1',expected_revision:0,value};
 const created=await api('POST','/api/maintenance-windows',create);assert.equal(created.status,200,JSON.stringify(created));const id=created.body.window.id;
 assert.deepEqual((await api('POST','/api/maintenance-windows',create)).body,created.body);
 assert.equal((await api('GET','/api/maintenance-windows/operations/create-1')).body.status,'committed');
 assert.equal((await api('POST','/api/maintenance-windows',{...create,operation_key:'bad-zone',value:{...value,timezone:'bad'}})).status,400);
 assert.equal((await api('POST','/api/maintenance-windows',{...create,operation_key:'global',value:{...value,resources:null}})).status,403);
 assert.equal((await api('POST','/api/maintenance-windows',{...create,operation_key:'forbidden',value:{...value,resources:[{type:'instance',id:702}]}})).status,403);
 assert.deepEqual((await api('GET','/api/maintenance-windows',undefined,otherToken)).body,[]);
 const changes=await Promise.all(['a','b'].map(operation_key=>api('PUT',`/api/maintenance-windows/${id}`,{operation_key,expected_revision:1,value:{...value,name:operation_key}})));
 assert.deepEqual(changes.map(r=>r.status).sort(),[200,409]);
 const before=await maintenanceAt(pool as any,value.resources[0] as any,now);assert.equal(before.length,0);
 now+=1000;assert.equal((await maintenanceAt(pool as any,value.resources[0] as any,now)).length,1);
 now+=9000;assert.equal((await maintenanceAt(pool as any,value.resources[0] as any,now)).length,0);
 // Revocation while an HTTP mutation waits for the serialization lock.
 const c=await pool.getConnection();await c.beginTransaction();await c.query('SELECT id FROM maintenance_scope_lock WHERE id=1 FOR UPDATE');
 const waiting=api('PUT',`/api/maintenance-windows/${id}`,{operation_key:'revoked',expected_revision:2,value});
 await new Promise(r=>setTimeout(r,100));await pool.query('DELETE FROM instance_permissions WHERE user_id=701');await c.commit();c.release();assert.equal((await waiting).status,403);
 await pool.query("INSERT INTO instance_permissions(user_id,instance_id,access_level) VALUES(701,701,'read-write')");
 const cancel=await api('DELETE',`/api/maintenance-windows/${id}`,{operation_key:'cancel',expected_revision:2,cancel:true});assert.equal(cancel.status,200);
 const noop=await api('DELETE',`/api/maintenance-windows/${id}`,{operation_key:'cancel-noop',expected_revision:3,cancel:true});assert.equal(noop.body.noop,true);
 const [audit]=await pool.query<any[]>('SELECT COUNT(*) AS n FROM maintenance_interval_history');assert.equal(audit[0].n,3);
 const history=await api('GET',`/api/maintenance-windows/intervals/instance/701?from=${encodeURIComponent(new Date(now-20000).toISOString())}&to=${encodeURIComponent(new Date(now+20000).toISOString())}`);assert.equal(history.status,200);
 // Scope moves must end the old resource's historical interval, even when
 // the next revision is not visible under that resource's projection.
 await pool.query("INSERT INTO instance_permissions(user_id,instance_id,access_level) VALUES(701,702,'read-write')");
 const moveValue={...value,starts_at:new Date(now).toISOString(),ends_at:new Date(now+20000).toISOString()};
 const move=await api('POST','/api/maintenance-windows',{operation_key:'scope-create',expected_revision:0,value:moveValue});assert.equal(move.status,200);
 now+=1000;const moveAt=new Date(now).toISOString();
 assert.equal((await api('PUT',`/api/maintenance-windows/${move.body.window.id}`,{operation_key:'scope-move',expected_revision:1,value:{...moveValue,resources:[{type:'instance',id:702}]}})).status,200);
 const projected=await api('GET',`/api/maintenance-windows/intervals/instance/701?from=${encodeURIComponent(moveValue.starts_at)}&to=${encodeURIComponent(moveValue.ends_at)}`);
 assert.equal(projected.body.intervals.find((v:any)=>v.id===move.body.window.id).effective_to,moveAt);
 await pool.query('DELETE FROM instance_permissions WHERE user_id=701 AND instance_id=701');
 assert.equal((await api('GET','/api/maintenance-windows/operations/scope-move')).status,403);
 await pool.query("INSERT INTO instance_permissions(user_id,instance_id,access_level) VALUES(701,701,'read-write')");
 await pool.query('DELETE FROM instance_permissions WHERE user_id=701 AND instance_id=702');
 // Controlled scalar evaluator -> production unique event writer -> real MySQL.
 // This is event persistence acceptance, not a physical collector transport test.
 await pool.query("INSERT INTO database_instances(id,name,host,port,username,password_encrypted) VALUES(7,'event fixture','fixture.invalid',3307,'fixture','unused')");
 await pool.query("INSERT INTO instance_permissions(user_id,instance_id,access_level) VALUES(701,7,'read-write')");
 const eventValue={...value,resources:[{type:'instance',id:7}],starts_at:new Date(now).toISOString(),ends_at:new Date(now+1000).toISOString()};
 assert.equal((await api('POST','/api/maintenance-windows',{operation_key:'event-maintenance',expected_revision:0,value:eventValue})).status,200);
 assert(await assetCollectionEnabled(pool,{type:'instance',id:7}));
 const base=await baseline({triggers:[{rule_id:'alpha-threshold',scope:'item:alpha',version:1}]});
 const snapshot=compileTriggerSnapshot(await resolveTriggerRules(base.resolution,base.catalog,portOf([base.version]).port));
 const rule=snapshot.rules[0],identity={resource:snapshot.resource,rule_id:rule.rule_id,version:rule.version,body_hash:rule.body_hash,scope:rule.scope};
 let previous:any=null;
 const transition=async(value:number|null)=>{
  const at=new Date(now).toISOString();
  const sample=near(value??0,{observed_at:at});
  const evaluation=evaluateTriggerRule(snapshot,{rule_id:rule.rule_id,scope:rule.scope},{applied:{resource:{type:'instance',id:7},applied_revision:snapshot.config_revision,plan_identity:snapshot.plan_identity,application_status:'applied'},input:{now:at,last_seen_at:at,previous:previous?.state==='open'?'problem':null,samples:value===null?[]:[sample]}});
  const next=nextTriggerEpisode({identity,previous,evaluation});assert(next);
  const c=await pool.getConnection();try{await c.beginTransaction();await alertEventService.persistTemplateTransition(c,previous,next,snapshot,{sample_ids:['controlled-'+now],attempt_ids:[],unit:'1',dimensions:{},samples:value===null?[]:[{...sample,id:'controlled-'+now}]});await c.commit();}catch(e){await c.rollback();throw e;}finally{c.release();}previous=next;
 };
 await transition(95);assert.equal(previous.state,'open');
 const [opening]=await pool.query<any[]>('SELECT alert_id,event_id FROM metric_trigger_episodes');assert.equal(opening.length,1);
 assert.equal(await maintenanceBlocksDelivery(opening[0].alert_id),true);
 now+=1000;assert(await assetCollectionEnabled(pool,{type:'instance',id:7}));await transition(85);assert.equal(previous.state,'open');await transition(null);assert.equal(previous.state,'open');
 // Exiting does not rewrite the opening or enqueue a backfill.
 const [jobs]=await pool.query<any[]>("SELECT COUNT(*) AS n FROM workflow_jobs WHERE job_type='notification.deliver'");assert.equal(Number(jobs[0].n),0);
 assert.equal(await maintenanceBlocksDelivery(opening[0].alert_id),true);
 now+=1000;await transition(60);assert.equal(previous.state,'closed');await transition(60);
 const [eventCount]=await pool.query<any[]>('SELECT COUNT(*) AS n FROM metric_trigger_episodes');assert.equal(Number(eventCount[0].n),1);
 const [logCount]=await pool.query<any[]>("SELECT COUNT(*) AS n FROM alert_event_logs WHERE action='resolved'");assert.equal(Number(logCount[0].n),1);
 const [link]=await pool.query<any[]>('SELECT payload FROM maintenance_event_links WHERE alert_id=?',[opening[0].alert_id]);assert.equal((typeof link[0].payload==='string'?JSON.parse(link[0].payload):link[0].payload).state,'active');
 // Only the maintenance lookup fails: problem persistence must continue as unknown.
 await pool.query('RENAME TABLE maintenance_interval_history TO maintenance_interval_history_unavailable');
 now+=1000;await transition(95);assert.equal(previous.state,'open');
 await pool.query('RENAME TABLE maintenance_interval_history_unavailable TO maintenance_interval_history');
 const [unknownLink]=await pool.query<any[]>("SELECT payload FROM maintenance_event_links WHERE JSON_UNQUOTE(JSON_EXTRACT(payload,'$.state'))='unknown'");assert.equal(unknownLink.length,1);
 // Browser uses the exact production route registrar above.
 const address=await app.listen({host:'127.0.0.1',port:0});
 const {createServer}=await import('../../../frontend/node_modules/vite/dist/node/index.js');
 vite=await createServer({configFile:false,root:resolve('../../frontend'),server:{host:'127.0.0.1',port:0,proxy:{'/api':address}}});await vite.listen();
 const req=createRequire(resolve('../../frontend/package.json'));const {chromium}=req('@playwright/test');browser=await chromium.launch({headless:true});
 const page=await browser.newPage({viewport:{width:1440,height:900}});
 await page.addInitScript(t=>localStorage.setItem('token',t),token);
 await page.goto(`http://127.0.0.1:${vite.httpServer.address().port}/e2e/fixtures/max244-maintenance.html`);
 await page.getByRole('button',{name:'新建维护窗口'}).click();
 await page.getByLabel('名称',{exact:true}).fill('浏览器维护');await page.getByLabel('原因',{exact:true}).fill('真实 Lit Fastify MySQL');
 await page.getByLabel('资源范围',{exact:true}).selectOption({label:'授权数据库 (instance)'});
 await page.getByRole('button',{name:'检查影响'}).click();
 // Lose only the response, after the server commits. Recovery must not duplicate history.
 await page.route('**/api/maintenance-windows',async route=>{if(route.request().method()==='POST'){await route.fetch();await route.abort();}else await route.continue();});
 await page.getByRole('button',{name:'确认保存'}).click();
 await page.getByRole('button',{name:'查询操作结果'}).last().click();await page.getByRole('cell',{name:'浏览器维护',exact:false}).waitFor();
 await page.unroute('**/api/maintenance-windows');
 for(const [width,height] of [[1440,900],[1366,768],[1920,1080]]){await page.setViewportSize({width,height});await page.screenshot({path:resolve(directory,`maintenance-${width}.png`),fullPage:true});}
 await page.getByRole('row').filter({hasText:'浏览器维护'}).getByRole('button',{name:'编辑',exact:true}).click();await page.getByLabel('原因',{exact:true}).fill('已修改');await page.getByRole('button',{name:'检查影响'}).click();await page.getByRole('button',{name:'确认保存'}).click();await page.getByText('已修改',{exact:false}).first().waitFor();
 const browserRow=()=>page.getByRole('row').filter({hasText:'浏览器维护'});
 // HTTP concurrent edit while the real Lit form holds the older revision.
 await browserRow().getByRole('button',{name:'编辑',exact:true}).click();
 const list=(await api('GET','/api/maintenance-windows')).body;const win=list.find((v:any)=>v.name==='浏览器维护');
 const externalValue={name:win.name,reason:'并发更新',resources:win.resources,starts_at:win.starts_at,ends_at:win.ends_at,timezone:win.timezone};
 assert.equal((await api('PUT',`/api/maintenance-windows/${win.id}`,{operation_key:'browser-concurrent',expected_revision:win.revision,value:externalValue})).status,200);
 await page.getByLabel('原因',{exact:true}).fill('旧草稿');await page.getByRole('button',{name:'检查影响'}).click();await page.getByRole('button',{name:'确认保存'}).click();await page.getByText('保存未提交：MAINTENANCE_REVISION',{exact:false}).last().waitFor();
 await page.getByRole('button',{name:'返回',exact:true}).click();await page.getByRole('button',{name:'刷新',exact:true}).click();
 await browserRow().getByRole('button',{name:'编辑',exact:true}).click();
 await pool.query('DELETE FROM instance_permissions WHERE user_id=701 AND instance_id=701');
 await page.getByLabel('原因',{exact:true}).fill('已撤权草稿');await page.getByRole('button',{name:'检查影响'}).click();await page.getByRole('button',{name:'确认保存'}).click();await page.getByText('保存未提交：MAINTENANCE_FORBIDDEN',{exact:false}).last().waitFor();
 await pool.query("INSERT INTO instance_permissions(user_id,instance_id,access_level) VALUES(701,701,'read-write')");
 await page.getByRole('button',{name:'返回',exact:true}).click();await page.getByRole('button',{name:'刷新',exact:true}).click();
 await browserRow().getByRole('button',{name:'取消维护',exact:true}).click();await page.getByRole('button',{name:'确认取消',exact:true}).click();await browserRow().getByText('已取消',{exact:true}).waitFor();
 // Cancel a local draft without any request, then verify principal isolation on remount.
 const [beforeDraft]=await pool.query<any[]>('SELECT COUNT(*) AS n FROM maintenance_interval_history');
 await page.getByRole('button',{name:'新建维护窗口'}).click();await page.getByRole('button',{name:'返回',exact:true}).click();
 const [afterDraft]=await pool.query<any[]>('SELECT COUNT(*) AS n FROM maintenance_interval_history');assert.equal(beforeDraft[0].n,afterDraft[0].n);
 let releaseLate!:()=>void, observedLate!:()=>void;
 const late=new Promise<void>(resolve=>{releaseLate=resolve;});const observed=new Promise<void>(resolve=>{observedLate=resolve;});let held=false;
 await page.route('**/api/maintenance-windows',async route=>{if(!held&&route.request().method()==='GET'){held=true;const response=await route.fetch();observedLate();await late;await route.fulfill({response});}else await route.continue();});
 await page.getByRole('button',{name:'刷新',exact:true}).click();await observed;
 await page.evaluate(t=>{localStorage.setItem('token',t);document.querySelector('maintenance-windows')!.remove();document.body.append(document.createElement('maintenance-windows'));},otherToken);
 releaseLate();

 await page.getByText('暂无可查看的维护窗口').waitFor();assert.equal(await page.getByText('浏览器维护',{exact:true}).count(),0);
 await page.unroute('**/api/maintenance-windows');
 await page.evaluate(()=>{const claims=JSON.parse(atob(localStorage.getItem('token')!.split('.')[1]));sessionStorage.setItem(`slide.maintenance.${claims.userId}.${claims.sessionVersion}`,'{broken');document.querySelector('maintenance-windows')!.remove();document.body.append(document.createElement('maintenance-windows'));});
 await page.getByText('本地操作记录损坏，无法确认上次结果，已停止写入。请保留记录并联系管理员核对。').waitFor();assert(await page.getByRole('button',{name:'新建维护窗口'}).isDisabled());

 writeFileSync(resolve(directory,'result.json'),JSON.stringify({nonce,handle,api:'create/replay/operation/timezone/global/forbidden/concurrent/revoked/cancel/noop/history passed',events:'controlled 95 -> 85 -> unknown -> 60 unique MySQL event/maintenance link/no backfill/no duplicate recovery passed',browser:'Lit->Fastify->MySQL create/edit/cancel/no-write draft cancel/revocation/concurrent revision/lost response recovery/principal remount and 3 desktop sizes passed',boundary:'controlled service clock; no collector transport, worker, model or external delivery'},null,2));
 console.log('MAX244 evidence',directory);
}catch(e){failures++;console.error(e);}finally{
 try{await browser?.close();await vite?.close();await app.close();await dbConnection.close();if(owned)await owned.drop();await root?.end();
 if(handle.container){const label=docker('inspect','--format','{{ index .Config.Labels "slide.max244.nonce" }}',handle.container);assert.equal(label,nonce);docker('stop','--time','10',handle.container);}
 writeFileSync(resolve(directory,'cleanup.json'),JSON.stringify({nonce,verified:true}));
 }catch(e){failures++;console.error('CLEANUP_UNKNOWN; retained lifecycle handle',e);}
}
if(failures)process.exitCode=1;
