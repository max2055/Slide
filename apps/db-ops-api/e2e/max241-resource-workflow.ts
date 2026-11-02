import {registerEventReadRoutes} from '../src/alert-event-access.js';
import {AuditLogManager, DatabaseAuditLogStore} from '../src/audit/audit-log.js';
/** Actual Lit + production Fastify registrars/JWT + owned non3306 MySQL. No worker, model or target operations. */
import assert from 'node:assert/strict';
import {randomBytes,createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdirSync,writeFileSync,readdirSync,readFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createRequire} from 'node:module';
import Fastify from 'fastify';
import mysql from 'mysql2/promise';
import {dbConnection} from '../src/db-connection.js';
import {MigrationRunner} from '../src/migrations/runner.js';
import {createOwnedDatabase} from '../src/testing/owned-fixture.js';
import {actorContextService,signAccessToken} from '../src/auth/actor-context.js';
import {createVerifyToken} from '../src/auth-middleware.js';
import {registerInstanceListRoutes} from '../src/instance-list-routes.js';
import {registerResourceIdentityRoutes} from '../src/resources/resource-identity-routes.js';
import {registerResourceRoutes} from '../src/resources/resource-routes.js';
import {registerNetworkDeviceRoutes} from '../src/network-devices/network-device-routes.js';
import {registerMetricConfigurationRoutes} from '../src/metrics/config/routes.js';
import {registerMetricPolicyRoutes} from '../src/metrics/policy/routes.js';
import {registerMetricTemplateRoutes} from '../src/metrics/templates/routes.js';
import {registerMetricConsumerRoutes} from '../src/metrics/consumers/routes.js';
import {registerResourceTriggerRead} from '../src/metrics/triggers/resource-detail-routes.js';
import {registerTemplateTriggerRoutes} from '../src/metrics/triggers/routes.js';
import {registerInvestigationEntryRoutes} from '../src/investigations/entry-routes.js';
import {InvestigationSessionBridge} from '../src/investigations/session-bridge.js';
import {registerSystemAuditRoutes} from '../src/audit/system-audit-routes.js';
import {registerMaintenanceRoutes} from '../src/maintenance-routes.js';
import {identify,sample} from '../src/contracts/metrics/fixtures.js';
import {RolloutControl} from '../src/metrics/rollout/control.js';
import {seriesHash} from '../src/metrics/storage.js';
const nonce=randomBytes(8).toString('hex'),directory=resolve('../../docs/slide/development/MAX-241/production/e2e-'+nonce);
mkdirSync(directory,{recursive:true});
const docker=(...args:string[])=>execFileSync('docker',args,{encoding:'utf8'}).trim();
const handle={nonce,pid:process.pid,cwd:process.cwd(),container:'',schema:'',port:0,source:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim()};
const save=()=>writeFileSync(join(directory,'lifecycle.json'),JSON.stringify(handle,null,2));save();
let root:mysql.Pool|undefined,owned:Awaited<ReturnType<typeof createOwnedDatabase>>|undefined,vite:any,browser:any;
const app=Fastify();const checks:string[]=[];const passed=(s:string)=>{checks.push(s);console.log('PASS '+s);};let failure='';
try{
 handle.container=docker('run','-d','--rm','--label',`slide.max241.nonce=${nonce}`,'-e','MYSQL_ALLOW_EMPTY_PASSWORD=yes','-p','127.0.0.1::3306','mysql:8.4');save();
 handle.port=Number(docker('port',handle.container,'3306/tcp').split(':').at(-1));assert(handle.port>0&&handle.port!==3306);save();
 root=mysql.createPool({host:'127.0.0.1',port:handle.port,user:'root',password:''});
 const deadline=Date.now()+45000;for(;;){try{await root.query('SELECT 1');break;}catch(e){if(Date.now()>deadline)throw e;await new Promise(r=>setTimeout(r,300));}}
 owned=await createOwnedDatabase(root as any,{nonce,purpose:'details',handleDir:directory});handle.schema=owned.database;save();
 assert(await dbConnection.initialize({host:'127.0.0.1',port:handle.port,user:'root',password:'',database:owned.database}));const pool=dbConnection.getPool()!;
 await new MigrationRunner(pool as any).run();
 await pool.query("INSERT INTO users(id,username,password_hash) VALUES(741,'resource-reader','no-login'),(742,'resource-denied','no-login')");
 await pool.query("INSERT INTO roles(id,name) VALUES(741,'resource-reader')");
 const permissions=['instance:view','servers:view','network_devices:view','metric:view','alert:view','audit:view','chat:view'];
 for(const code of permissions){await pool.execute('INSERT IGNORE INTO permissions(code,name,resource,action) VALUES(?,?,?,?)',[code,code,...code.split(':')]);}
 await pool.query(`INSERT INTO role_permissions(role_id,permission_id) SELECT 741,id FROM permissions WHERE code IN (${permissions.map(()=>'?').join(',')})`,permissions);
 await pool.query('INSERT INTO user_roles(user_id,role_id) VALUES(741,741)');
 const longName='MAX241长名称完整资源身份与窗口返回验证-'.repeat(4);
 for(let id=1;id<=25;id++){
  await pool.execute("INSERT INTO database_instances(id,name,host,port,username,password_encrypted,db_type,db_version,status) VALUES(?,?,?,?,?,?,?,?,?)",[id,id===25?longName:'数据库-'+id,'db-'+id+'.fixture.invalid',3306,'reader','unused','mysql','8.4.0','inactive']);
  await pool.execute("INSERT INTO instance_permissions(user_id,instance_id,access_level) VALUES(741,?,'read-only')",[id]);
  await pool.execute("INSERT INTO servers(id,host,label,os_type,credential_type,credential_encrypted,status) VALUES(?,?,?,'linux','password','unused','offline')",[id,'host-'+id+'.fixture.invalid',id===25?longName:'服务器-'+id]);
  await pool.execute("INSERT INTO network_devices(id,name,label,host,model,os_version) VALUES(?,?,?,?,?,?)",[id,'network-'+id,id===25?longName:'网络-'+id,'192.0.2.'+id,'CE6800','V200R019']);
 }
 const control=new RolloutControl(pool as any);
 for(const type of ['instance','server','network_device']){
  const raw=sample(type==='instance'?'db.uptime_seconds':type==='server'?'host.filesystem.used_bytes':'network.interface.oper_up');
  const at=new Date(Date.now()-120000).toISOString();
  const o=identify({...raw,resource_id:'25',resource_type:type as any,observed_at:at,collected_at:at,stored_at:at});
  await control.initialize(o,{source:'semantic',read:'semantic',package:{id:o.versions.package_id,version:o.versions.package_version,digest:'sha256:'+ 'a'.repeat(64)},revision:1});
  await control.applied(o,{source:'semantic',generation:1,revision:1});
  await pool.execute('INSERT INTO metric_observations(id,series_hash,stage,observed_at,stored_at,valid_value,payload,payload_hash,evidence_expires_at) VALUES(?,?,?,?,?,?,?, ?,NULL)',[o.id,seriesHash(o),o.stage,new Date(at),new Date(at),1,JSON.stringify(o),'fixture']);
  await pool.execute('INSERT INTO metric_publications(observation_id,series_hash,generation,observed_at) VALUES(?,?,1,?)',[o.id,seriesHash(o),new Date(at)]);
 }
 const secret=randomBytes(32).toString('hex'),actor=await actorContextService.loadActiveActor(741),token=signAccessToken(actor,secret),denyToken=signAccessToken(await actorContextService.loadActiveActor(742),secret),verify=createVerifyToken(secret);
 let auditFinished!:()=>void;const activationAuditFinished=new Promise<void>(resolve=>auditFinished=resolve);
 await registerSystemAuditRoutes(app,verify,new AuditLogManager(new DatabaseAuditLogStore(pool)));
 app.addHook('onResponse',async(req)=>{if(req.url.includes('/activate'))auditFinished();});
 await registerEventReadRoutes(app,verify);
 await registerInstanceListRoutes(app,verify);await registerResourceIdentityRoutes(app,verify);await registerResourceRoutes(app,verify);await registerNetworkDeviceRoutes(app,verify);
 await registerMetricConfigurationRoutes(app,verify);await registerMetricPolicyRoutes(app,verify);await registerMetricTemplateRoutes(app,verify);await registerMetricConsumerRoutes(app,verify);
 await registerResourceTriggerRead(app,verify);await registerTemplateTriggerRoutes(app,verify);await registerMaintenanceRoutes(app,verify);
 const bridge=new InvestigationSessionBridge(()=>pool);
 await registerInvestigationEntryRoutes(app,verify,bridge);
 // Read adapter to the real authorized store; no model/admission/worker is installed.
 app.get('/api/investigations',{preHandler:[verify]},async(req:any)=>{const match=/^(instance|server|network_device):([1-9]\d*)$/.exec(String(req.query.resource));if(!match)throw Error('INVALID_RESOURCE');const result=await bridge.storeFor(req.user).list({kind:'user',id:req.user.userId},{resource:{type:match[1] as any,id:Number(match[2])},limit:5,offset:0});return {items:result.items};});
 const api=async(path:string,auth=token,method='GET',body?:any)=>{const r=await app.inject({method:method as any,url:path,headers:{authorization:`Bearer ${auth}`},payload:body});return {status:r.statusCode,body:r.json()};};
 for(const path of ['/api/database/instances/25','/api/servers/25','/api/network-devices/25','/api/metrics/template-bindings/instance/25/effective-triggers'])assert.equal((await api(path,denyToken)).status,403,path);
 for(const path of ['/api/database/instances/25','/api/servers/25','/api/network-devices/25'])assert.equal((await api(path)).status,200,path);
  const eventWindow={from:new Date(Date.now()-60000).toISOString(),to:new Date().toISOString()};
 for(const type of ['instance','server','network_device']){
   const column={instance:'instance_id',server:'server_id',network_device:'network_device_id'}[type]!;
   for(const id of [24,25])await pool.execute(`INSERT INTO alert_events(event_id,title,severity,target_type,${column},created_at) VALUES(?,?,'warning',?,?,?)`,[nonce+'-'+type+'-'+id,'既有事件-'+type+'-'+id,type,id,new Date(Date.now()-30000)]);
   const scope=new URLSearchParams({resource:type+':25',...eventWindow});const list=await api('/api/alerts/events?'+scope);assert.equal(list.status,200);assert.equal(list.body.total,1);assert.equal(list.body.items[0][column],25);assert.equal((await api('/api/alerts/events?'+scope,denyToken)).status,403);
 }
 assert.equal((await api('/api/alerts/events?resource=server:25&from=invalid&to=invalid')).status,400);passed('all three existing event types scoped by exact resource and window over real MySQL');
 const refusedActivation=await api('/api/metrics/config/resources/server/25/activate',token,'POST',{});assert(refusedActivation.status>=400);
 await activationAuditFinished;
 const nestedAudit=(await pool.query<any[]>("SELECT COUNT(*) n FROM audit_log_entries WHERE resource_type='server' AND resource_id='25' AND action LIKE '%activate%'"))[0][0];assert.equal(Number(nestedAudit.n),1,JSON.stringify({status:refusedActivation.status,body:refusedActivation.body,auditMetadata:(await pool.query('SELECT resource_type,resource_id,action FROM audit_log_entries LIMIT 5'))[0]}));
 const audit=new AuditLogManager(new DatabaseAuditLogStore(pool));
 await audit.logSystemOperation({userId:'741',username:'resource-reader',method:'PUT',route:'/api/servers/:id',statusCode:200,resourceType:'server',resourceId:'25'});
 await audit.logSystemOperation({userId:'741',username:'resource-reader',method:'PUT',route:'/api/servers/:id',statusCode:200,resourceType:'server',resourceId:'24'});
 const auditWindow=new URLSearchParams({resource:'server:25',startTime:new Date(Date.now()-60000).toISOString(),endTime:new Date(Date.now()+1000).toISOString()});
 const auditResult=await api('/api/audit/logs?'+auditWindow);assert.equal(auditResult.status,200);assert(auditResult.body.total>=2);assert(auditResult.body.items.every((row:any)=>row.resourceId==='25'));assert.equal(auditResult.body.items[0].resourceId,'25');
 assert.equal((await api('/api/audit/logs?'+auditWindow,denyToken)).status,403);
 passed('persisted MySQL audit is limited to exact resource and time window; denied role gets403');
 passed('three production identity reads and real JWT 403 over owned MySQL');
 await app.listen({host:'127.0.0.1',port:0});const address=app.server.address() as {port:number};
 const {createServer}=await import('../../../frontend/node_modules/vite/dist/node/index.js');
 const fixture='/e2e/fixtures/max241-resource-workflow.html';
 vite=await createServer({configFile:false,root:resolve('../../frontend'),plugins:[{name:'acceptance-document',configureServer(server:any){server.middlewares.use((req:any,_res:any,next:any)=>{if(/^\/(instance-detail|server-detail|network-device-detail|investigations|events|audit-center|instances-db|servers|network-devices)(\?|$)/.test(req.url)||/^\/(\?|$)/.test(req.url))req.url=fixture+(req.url.includes('?')?'?'+req.url.split('?')[1]:'');next();});}}],server:{host:'127.0.0.1',port:0,proxy:{'/api':`http://127.0.0.1:${address.port}`}}});await vite.listen();
 const require=createRequire(import.meta.url),{chromium,expect}=require('../../../frontend/node_modules/@playwright/test');browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1440,height:900}});
 await page.addInitScript(({token,permissions}:any)=>{localStorage.setItem('token',token);localStorage.setItem('permissions',JSON.stringify(permissions));localStorage.setItem('user',JSON.stringify({id:741}));},{token,permissions});
 const origin=`http://127.0.0.1:${vite.httpServer.address().port}`;
 const errors:string[]=[];page.on('pageerror',(e:any)=>errors.push(e.message));
 const route=async(tab:string)=>{await page.goto(`${origin}${fixture}?tab=${tab}`);};
 await route('instances-db');await page.setViewportSize({width:900,height:900});
 await page.getByRole('button',{name:'下一页',exact:true}).click();await expect(page.locator('resource-metrics-table')).toContainText('第 2 页');
 await page.locator('resource-metrics-table').evaluate((el:any)=>{el.shadowRoot.querySelector('.scroll').scrollLeft=120;});
 const sourceButton=page.locator('resource-metrics-table [data-resource-detail-id]').first();const sourceId=await sourceButton.getAttribute('data-resource-detail-id');await sourceButton.click();await expect(page.locator('instance-detail-page')).toContainText('数据库-');const savedLeft=await page.evaluate(()=>JSON.parse(sessionStorage.getItem('resource-return:'+new URLSearchParams(location.search).get('listReturn'))!).position.left);assert(savedLeft>0);
 await page.getByRole('tab',{name:'概览',exact:true}).focus();await page.keyboard.press('ArrowRight');await expect(page.getByRole('tab',{name:'监控配置',exact:true})).toHaveAttribute('aria-selected','true');
 await page.getByRole('button',{name:'返回列表',exact:true}).click();await expect(page.locator('resource-metrics-table')).toContainText('第 2 页');
 await expect.poll(()=>page.locator('resource-metrics-table').evaluate((el:any)=>el.shadowRoot.querySelector('.scroll').scrollLeft)).toBe(savedLeft);
 await expect(page.locator(`resource-metrics-table [data-resource-detail-id="${sourceId}"]`)).toBeFocused();
 await page.setViewportSize({width:1440,height:900});passed('real pagination, local horizontal scroll, source-row focus and keyboard tab navigation restore');
 for(const [type,list,detail,tag,expectedTabs] of [['instance','instances-db','instance-detail','instance-detail-page',13],['server','servers','server-detail','server-detail',10],['network_device','network-devices','network-device-detail','network-device-detail',6]] as const){
  await route(list);const search=page.locator('input[type="search"], input.resource-search-input, input.search-input').first();await search.fill('MAX241长名称');
  const row=page.locator('resource-metrics-table').getByRole('button',{name:'详情',exact:true});await expect(row).toHaveCount(1);await row.click();
  await expect(page.locator(tag)).toContainText(longName);await expect(page.locator(tag).getByRole('tab')).toHaveCount(expectedTabs);
  await page.getByRole('button',{name:'监控配置',exact:true}).click();await page.getByRole('button',{name:'修改模板与参数',exact:true}).click();
  await expect(page.locator('metric-configuration')).toBeVisible();await expect(page.locator('native-template-configuration')).toBeVisible();
  await expect(page.locator(tag).getByRole('tab',{name:'监控配置',exact:true})).toHaveAttribute('aria-selected','true');
  await page.getByRole('tab',{name:'指标与趋势',exact:true}).click();await expect(page.locator('semantic-metrics')).toBeVisible();
  await expect(page.locator('semantic-metrics')).not.toContainText('查询暂时失败');
  const scope=await page.evaluate(()=>Object.fromEntries(new URLSearchParams(location.search)));assert.equal(scope.metricResource,`${type}:25`);assert(scope.metricFrom&&scope.metricTo);
  const eventHref=await page.getByRole('link',{name:'窗口内事件',exact:true}).getAttribute('href');assert.equal(new URL(eventHref,origin).searchParams.get('from'),scope.metricFrom);
  await page.getByRole('link',{name:'窗口内事件',exact:true}).click();await expect(page.locator('resource-event-context')).toContainText(`${type}:25`);await expect(page.locator('resource-event-context')).toContainText('既有事件-'+type+'-25');await expect(page.locator('resource-event-context')).not.toContainText('既有事件-'+type+'-24');
  await page.getByRole('link',{name:'返回资源详情',exact:true}).click();await expect(page.locator(tag)).toContainText(longName);
  await page.getByRole('link',{name:'AI 事实调查（未调用模型）',exact:true}).click();await expect(page.locator('investigation-entry')).toContainText('尚未进行模型分析');await expect(page.locator('investigation-entry [role="alert"]')).toHaveCount(0);
  await page.getByRole('link',{name:'返回来源',exact:true}).click();await expect(page.locator(tag)).toContainText(longName);
  await page.getByRole('link',{name:'操作审计',exact:true}).click();await expect(page.locator('system-audit-page')).toContainText(`${type}:25`);await page.getByRole('link',{name:'返回资源详情',exact:true}).click();
  await expect.poll(()=>page.locator('semantic-metrics').evaluate((e:any)=>e.busy)).toBe(false);
  await page.evaluate(async()=>{await Promise.all(document.getAnimations().map(a=>a.finished.catch(()=>{})));});
  for(const viewport of [{width:1440,height:900},{width:1366,height:768},{width:1920,height:1080}]){await page.setViewportSize(viewport);await expect(page.getByRole('button',{name:'监控配置',exact:true})).toBeInViewport();assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.evaluate(async()=>{await Promise.all(document.getAnimations().map(a=>a.finished.catch(()=>{})));});await page.screenshot({path:join(directory,`${type}-${viewport.width}x${viewport.height}.png`),fullPage:false});}
  await page.setViewportSize({width:1440,height:900});
  const back=type==='network_device'?page.locator(tag).getByRole('button',{name:'网络设备',exact:true}):page.getByRole('button',{name:'返回列表',exact:true});await back.click();await expect(search).toHaveValue('MAX241长名称');
  passed(`${type}: list/full professional tabs/configuration/history/same-window events/AI/audit/return + desktop sizes`);
 }
 // Actual DB revocation, same JWT, then UI erasure on identity refresh.
 await route('servers');await page.getByRole('button',{name:'详情',exact:true}).first().click();await expect(page.locator('server-detail')).toContainText('服务器-1');
 await pool.query("DELETE rp FROM role_permissions rp JOIN permissions p ON p.id=rp.permission_id WHERE rp.role_id=741 AND p.code='servers:view'");
 assert.equal((await api('/api/servers/1')).status,403);await page.getByRole('button',{name:'刷新',exact:true}).click();await expect(page.locator('server-detail')).toContainText('无权读取服务器详情');await expect(page.locator('server-detail resource-investigation-links')).toHaveCount(0);passed('real DB revocation with same JWT clears page identity and protected links');
 assert.deepEqual(errors,[]);passed('no browser runtime exception; product model/worker/target actions not invoked');
}catch(e){try{await browser?.contexts()[0]?.pages()[0]?.screenshot({path:join(directory,'failure.png'),fullPage:false});}catch{}failure=String(e instanceof Error?e.stack:e);console.error(failure);process.exitCode=1;}
finally{
 let cleanup='';try{await browser?.close();await vite?.close();await app.close();await dbConnection.close();if(owned)await owned.drop();await root?.end();if(handle.container){assert.equal(docker('inspect','-f','{{index .Config.Labels "slide.max241.nonce"}}',handle.container),nonce);docker('stop','-t','5',handle.container);}cleanup='verified owned schema dropped and labelled container stopped; browser/Vite/Fastify closed';}catch(e){cleanup=String(e);process.exitCode=1;}
 const hashes=Object.fromEntries(readdirSync(directory).filter(f=>f.endsWith('.png')).map(f=>[f,createHash('sha256').update(readFileSync(join(directory,f))).digest('hex')]));
 writeFileSync(join(directory,'result.json'),JSON.stringify({source:handle.source,checks,failure,cleanup,hashes,scope:'real production registrars/JWT/MySQL; seeded observations, no collectors/model/worker/notification/deploy; existing collection evidence reused'},null,2));console.log('Evidence '+directory+' '+cleanup);
}
