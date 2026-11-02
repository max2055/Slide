/** Owned MySQL and SNMP endpoints only. Foreground existing worker, real Lit/JWT/API/writer/history. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {networkInterfaces} from 'node:os';
import {once} from 'node:events';
import {createSocket, type Socket} from 'node:dgram';
import {randomBytes,createHash} from 'node:crypto';
import {mkdirSync,writeFileSync,readdirSync,readFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import * as snmp from 'net-snmp';
import mysql from 'mysql2/promise';
import Fastify from 'fastify';
import {createServer as createPortProbe} from 'node:net';
import {dbConnection,encryptData} from '../src/db-connection.js';
import {MigrationRunner} from '../src/migrations/runner.js';
import {createOwnedDatabase} from '../src/testing/owned-fixture.js';
import {actorContextService,signAccessToken} from '../src/auth/actor-context.js';
import {createVerifyToken} from '../src/auth-middleware.js';
import {createConfigurationRegistry} from '../src/metrics/config/registry.js';
import {createAssetCollectorAccess} from '../src/metrics/config/access.js';
import {MySqlTemplateRepository} from '../src/metrics/templates/mysql-repository.js';
import {MetricTemplateService} from '../src/metrics/templates/service.js';
import {registerTemplateAuthoringRoutes} from '../src/metrics/templates/authoring-routes.js';
import {registerMetricTemplateRoutes} from '../src/metrics/templates/routes.js';
import {registerTemplateGovernanceRoutes} from '../src/metrics/templates/governance-routes.js';
import {registerDiscoveryRoutes} from '../src/metrics/templates/discovery-routes.js';
import {registerTemplateTriggerRoutes} from '../src/metrics/triggers/routes.js';
import {registerMetricConsumerRoutes} from '../src/metrics/consumers/routes.js';
import {createMetricStudyService} from '../src/metrics/consumers/study-routes.js';
import {registerMetricPolicyRoutes} from '../src/metrics/policy/routes.js';
import {registerMetricConfigurationRoutes} from '../src/metrics/config/routes.js';
import {registerEventReadRoutes} from '../src/alert-event-access.js';
import {registerMaintenanceRoutes} from '../src/maintenance-routes.js';
import {registerResourceRoutes} from '../src/resources/resource-routes.js';
import {MysqlScheduleStore} from '../src/metrics/scheduler/store.js';
import {MetricScheduler} from '../src/metrics/scheduler/service.js';
import {MetricFormalization} from '../src/metrics/rollout/formalization.js';
import {createCollectNowAuthorizer} from '../src/metrics/templates/collect-now.js';
import {evaluateTemplateClock} from '../src/metrics/triggers/runtime.js';
import {JobRegistry} from '../src/workflows/job-registry.js';
import {MysqlWorkflowStore,WorkerRuntime} from '../src/workflows/worker-runtime.js';

const nonce=randomBytes(8).toString('hex'),directory=resolve('../../outputs/max245-discovery-'+nonce);
process.env.ENCRYPTION_KEY=randomBytes(32).toString('hex');
mkdirSync(directory,{recursive:true});
const docker=(...args:string[])=>execFileSync('docker',args,{encoding:'utf8'}).trim();
const handle={nonce,pid:process.pid,cwd:process.cwd(),container:'',port:0,schema:''};
const save=()=>writeFileSync(join(directory,'lifecycle.json'),JSON.stringify(handle,null,2));save();
const evidence:any={nonce,hardware:false,external_notifications:0,product_model_calls:0,checks:[]};
const passed=(name:string)=>{evidence.checks.push(name);console.log('PASS',name);};
let root:mysql.Pool|undefined,owned:Awaited<ReturnType<typeof createOwnedDatabase>>|undefined,vite:any,browser:any,agent:ReturnType<typeof snmp.createAgent>|undefined;
const app=Fastify();let failures=0;let pool:mysql.Pool;let now=Date.now();let packets=0;
try{
 const portProbe=createPortProbe();portProbe.listen(0,'127.0.0.1');await once(portProbe,'listening');handle.port=(portProbe.address() as {port:number}).port;await new Promise<void>(r=>portProbe.close(()=>r()));assert(handle.port!==3306);
 handle.container=docker('run','-d','--rm','--label',`slide.max245.nonce=${nonce}`,'-e','MYSQL_ALLOW_EMPTY_PASSWORD=yes','-p',`127.0.0.1:${handle.port}:3306`,'mysql:8.4');save();
 assert.equal(Number(docker('port',handle.container,'3306/tcp').split(':').at(-1)),handle.port);save();
 root=mysql.createPool({host:'127.0.0.1',port:handle.port,user:'root',password:''});
 const deadline=Date.now()+45000;for(;;){try{await root.query('SELECT 1');break;}catch(e){if(Date.now()>deadline)throw e;await new Promise(r=>setTimeout(r,300));}}
 owned=await createOwnedDatabase(root as any,{nonce,purpose:'discovery',handleDir:directory});handle.schema=owned.database;save();
 assert(await dbConnection.initialize({host:'127.0.0.1',port:handle.port,user:'root',password:'',database:owned.database}));pool=dbConnection.getPool()!;
 await new MigrationRunner(pool as any).run();
 const host=Object.values(networkInterfaces()).flat().find(n=>n?.family==='IPv4'&&!n.internal)?.address;assert(host,'owned nonloopback interface required; target policy stays unchanged');
 const probe=createSocket('udp4');probe.bind(0,host);await once(probe,'listening');const udp=probe.address().port;await new Promise<void>(r=>probe.close(()=>r()));
 const community=randomBytes(24).toString('hex');
 agent=snmp.createAgent({address:host,port:udp},()=>{packets++;});agent.getAuthorizer().addCommunity(community);
 await Promise.all(Object.values(agent.listener.sockets).map(s=>once(s as Socket,'listening')));
 const mib=agent.getMib();
 mib.registerProvider({name:'uptime',type:snmp.MibProviderType.Scalar,oid:'1.3.6.1.2.1.1.3',scalarType:snmp.ObjectType.TimeTicks,maxAccess:snmp.MaxAccess['read-only']});mib.setScalarValue('uptime',100000);
 mib.registerProvider({name:'ifNumber',type:snmp.MibProviderType.Scalar,oid:'1.3.6.1.2.1.2.1',scalarType:snmp.ObjectType.Integer,maxAccess:snmp.MaxAccess['read-only']});mib.setScalarValue('ifNumber',1);
 let changeDuringWalk=false;
 mib.registerProvider({name:'walkEnd',type:snmp.MibProviderType.Scalar,oid:'1.3.6.1.4.1.99999.1',scalarType:snmp.ObjectType.Integer,maxAccess:snmp.MaxAccess['read-only']});mib.setScalarValue('walkEnd',1);
 const columns=[['ifIndex',snmp.ObjectType.Integer],['ifDescr',snmp.ObjectType.OctetString],['ifType',snmp.ObjectType.Integer],['ifMtu',snmp.ObjectType.Integer],['ifSpeed',snmp.ObjectType.Gauge],['ifPhysAddress',snmp.ObjectType.OctetString],['ifAdminStatus',snmp.ObjectType.Integer],['ifOperStatus',snmp.ObjectType.Integer]];
 mib.registerProvider({name:'interfaces',type:snmp.MibProviderType.Table,oid:'1.3.6.1.2.1.2.2.1',tableColumns:columns.map(([name,type],i)=>({number:i+1,name,type,maxAccess:snmp.MaxAccess['read-only']})),tableIndex:[1],handler:(request:any)=>{if(changeDuringWalk){mib.setScalarValue('ifNumber',2);changeDuringWalk=false;}request.done();}});
 const xcols=[{number:1,name:'ifName',type:snmp.ObjectType.OctetString},{number:6,name:'ifHCInOctets',type:snmp.ObjectType.Counter64},{number:10,name:'ifHCOutOctets',type:snmp.ObjectType.Counter64},{number:15,name:'ifHighSpeed',type:snmp.ObjectType.Gauge},{number:19,name:'ifCounterDiscontinuityTime',type:snmp.ObjectType.TimeTicks}];
 mib.registerProvider({name:'extended',type:snmp.MibProviderType.Table,oid:'1.3.6.1.2.1.31.1.1.1',tableColumns:xcols.map(c=>({...c,maxAccess:snmp.MaxAccess['read-only']})),tableIndex:[{columnName:'ifIndex',foreign:'interfaces'}]});
 let present=false,portIndex=1;
 const setInterface=(name:string,mac:string,up=1,index=1)=>{if(present){mib.deleteTableRow('interfaces',[portIndex]);mib.deleteTableRow('extended',[portIndex]);}portIndex=index;
   mib.addTableRow('interfaces',[index,name,6,1500,1000000000,Buffer.from(mac,'hex'),1,up]);
   mib.addTableRow('extended',[index,name,Buffer.from('0000000000001000','hex'),Buffer.from('0000000000002000','hex'),1000,0]);present=true;mib.setScalarValue('ifNumber',1);};
 const disappear=()=>{if(present){mib.deleteTableRow('interfaces',[portIndex]);mib.deleteTableRow('extended',[portIndex]);present=false;mib.setScalarValue('ifNumber',0);}};
 setInterface('port-before','020000000001');
 await pool.query("INSERT INTO network_devices(id,name,host,snmp_port,vendor,collection_enabled) VALUES(701,'发现受控交换机',?,?, 'huawei',1),(702,'隔离资源',?,?, 'huawei',1)",[host,udp,host,udp===65535?udp-1:udp+1]);
 await pool.query("INSERT INTO network_device_credentials(device_id,protocol,username,community_encrypted) VALUES(701,'snmpv2c','',?),(702,'snmpv2c','',?)",[encryptData(community),encryptData(community)]);
 await pool.query("INSERT INTO users(id,username,password_hash) VALUES(701,'discovery-author','no-login'),(702,'discovery-reader','no-login')");
 await pool.query("INSERT INTO roles(id,name) VALUES(701,'discovery-author'),(702,'discovery-reader')");
 await pool.query("INSERT IGNORE INTO permissions(code,name,resource,action) VALUES('metric:manage','指标管理','metric','manage'),('metric:view','指标查看','metric','view'),('network_devices:manage','设备管理','network_devices','manage'),('network_devices:view','设备查看','network_devices','view'),('alert:view','告警查看','alert','view')");
 await pool.query("INSERT INTO role_permissions(role_id,permission_id) SELECT 701,id FROM permissions WHERE code IN ('metric:manage','metric:view','network_devices:manage','network_devices:view','alert:view')");
 await pool.query("INSERT INTO role_permissions(role_id,permission_id) SELECT 702,id FROM permissions WHERE code IN ('metric:view')");
 await pool.query('INSERT INTO user_roles(user_id,role_id) VALUES(701,701),(702,702)');
 const actor=await actorContextService.loadActiveActor(701),reader=await actorContextService.loadActiveActor(702);
 const secret=randomBytes(32).toString('hex'),token=signAccessToken(actor,secret),readerToken=signAccessToken(reader,secret),verify=createVerifyToken(secret);
 await registerTemplateAuthoringRoutes(app,verify);await registerMetricTemplateRoutes(app,verify);await registerTemplateGovernanceRoutes(app,verify);
 const studyRegistry=process.env.MAX245_HISTORY_STUDY==='1'?(await import('./max245-history-study.js')).historyFixtureRegistry().registry:undefined;
 await registerDiscoveryRoutes(app,verify);await registerTemplateTriggerRoutes(app,verify);await registerMetricConsumerRoutes(app,verify,undefined,createMetricStudyService(studyRegistry));
 await registerMetricPolicyRoutes(app,verify);await registerMetricConfigurationRoutes(app,verify);await registerEventReadRoutes(app,verify);
 await registerMaintenanceRoutes(app,verify);
 await registerResourceRoutes(app,verify);
 let refreshCalls=0;
 app.post('/api/auth/refresh',async(request,reply)=>{try{
   const rotated=await actorContextService.rotateRefreshToken((request.body as {refreshToken:string}).refreshToken,String(request.id));refreshCalls++;
   return{token:signAccessToken(rotated.actor,secret,3600+refreshCalls),refreshToken:rotated.refreshToken};
 }catch{return reply.code(401).send({error:'INVALID_REFRESH'});}});
 const initialRefresh=await actorContextService.issueRefreshToken(actor);
 const request=async(method:string,url:string,payload?:unknown,t=token)=>{const r=await app.inject({method:method as any,url,headers:{authorization:`Bearer ${t}`},payload});return{status:r.statusCode,body:r.json()};};
 const api=async(method:string,url:string,payload?:unknown)=>{const r=await request(method,url,payload);assert.equal(r.status,200,JSON.stringify({url,...r}));return r.body;};
 const registry=createConfigurationRegistry(),repository=new MySqlTemplateRepository(pool),templates=new MetricTemplateService(repository,registry);
 const template=await templates.create(actor,{name:'MAX245 真实接口发现'}),id=template.template_id;
 const pkg=registry.list().map(r=>r.package).find(p=>p.id==='snmp-standard')!;
 const selected=await templates.selectMetric(actor,id,{package:{id:pkg.id,version:pkg.version,digest:pkg.digest},metric:{id:'network.interface.oper_up',semantic_version:'1.0.0'}});
 const draft=(await repository.getDraft(id))!;draft.aggregate.items=[{item_id:selected.item.item_id,version:1}];
 await templates.updateDraft(actor,id,{expected_draft_revision:draft.revision,aggregate:draft.aggregate});
 const initial=await templates.publish(actor,id,{expected_revision:0,expected_draft_revision:1});
 const trigger=await api('POST',`/api/metrics/templates/${id}/triggers`,{expected_version:initial.version,expected_content_hash:initial.content_hash,item_id:selected.item.item_id,
   parameters:{schema:{},defaults:{}},problem:{node:'compare',select:{aggregation:'last'},operator:'=',threshold:{kind:'constant',value:0}},
   recovery:{node:'compare',select:{aggregation:'last'},operator:'=',threshold:{kind:'constant',value:1}},quality:{accepted_quality:['good'],min_coverage:1,allow_estimated:false},clock:{stale_after_ms:1000,nodata:{enabled:true,after_ms:300000}}});
 passed('real immutable template and restricted trigger publication');
 const address=await app.listen({host:'127.0.0.1',port:0});
 const {createServer}=await import('../../../frontend/node_modules/vite/dist/node/index.js');
 vite=await createServer({configFile:false,root:resolve('../../frontend'),server:{host:'127.0.0.1',port:0,proxy:{'/api':address}}});await vite.listen();
 const require=createRequire(resolve('../../frontend/package.json'));const {chromium,expect}=require('@playwright/test');browser=await chromium.launch({headless:true});
 const page=await browser.newPage({viewport:{width:1440,height:900}});const errors:string[]=[];page.on('pageerror',(e:any)=>errors.push(e.message));
 await page.addInitScript((token:string)=>localStorage.setItem('token',token),token);
 await page.goto(`http://127.0.0.1:${vite.httpServer.address().port}/e2e/fixtures/max245-integrated.html`);
 await expect(page.locator('metric-settings template-library')).toHaveCount(1);
 await expect(page.locator('metric-settings template-governance')).toHaveCount(1);
 const compatibility=page.locator('details.package-compatibility');
 await expect(compatibility.locator('template-library,template-governance')).toHaveCount(0);
 await expect(page.getByRole('heading',{name:'原生监控模板',exact:true})).toBeVisible();
 for(const [width,height]of [[1440,900],[1366,768],[1920,1080]]){
   await page.setViewportSize({width,height});
   await page.getByRole('button',{name:'刷新模板库',exact:true}).focus();
   await expect(page.getByRole('button',{name:'刷新模板库',exact:true})).toBeFocused();
   await page.keyboard.press('Tab');
   await expect(page.getByRole('button',{name:'查看与编辑',exact:true})).toBeFocused();
   await compatibility.locator(':scope > summary').focus();await page.keyboard.press('Enter');
   await expect(page.getByRole('region',{name:'采集模板目录',exact:true})).toBeVisible();
   await page.screenshot({path:join(directory,`integrated-template-entry-${width}.png`),fullPage:true});
   await compatibility.locator(':scope > summary').focus();await page.keyboard.press('Enter');
   assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 }
 const governance=page.locator('template-governance');
 await expect(governance.getByRole('heading',{name:'模板继承与灰度治理',exact:true})).toBeVisible();
 await expect(governance.getByRole('button',{name:'刷新治理',exact:true})).toBeEnabled();
 await governance.getByRole('combobox',{name:'治理模板',exact:true}).selectOption(id);
 await governance.getByRole('button',{name:'读取模板',exact:true}).click();
 await expect(governance.getByRole('heading').filter({hasText:'MAX245 真实接口发现 · 草稿'})).toBeVisible();
 await expect(governance.getByRole('alert')).toHaveCount(0);
 passed('R6 one real settings template library and governance outside compatibility; three desktops and keyboard');
 await page.getByRole('button',{name:'查看与编辑',exact:true}).click();
 await page.getByRole('combobox',{name:'发现监控项原型',exact:true}).selectOption(selected.item.item_id);
 await page.getByRole('spinbutton',{name:'失联后禁用秒数'}).fill('1');await page.getByRole('spinbutton',{name:'失联后退役秒数'}).fill('3');
 await page.getByRole('button',{name:'添加发现规则到草稿',exact:true}).click();await page.getByRole('button',{name:'保存草稿',exact:true}).click();
 await expect(page.getByRole('status').filter({hasText:'草稿已保存'})).toBeVisible();await page.getByRole('button',{name:'发布不可变版本',exact:true}).click();
 await expect(page.getByRole('status').filter({hasText:'已发布不可变版本'})).toBeVisible();
 const editor=await api('GET',`/api/metrics/templates/${id}/editor`);const version=editor.current;assert.equal(version.aggregate.discovery_rules.length,1);assert(version.version>trigger.version);
 await page.getByRole('combobox',{name:'发现授权资源',exact:true}).selectOption('network_device:701');
 await page.route('**/discovery-preview',async(route:any)=>{await new Promise(r=>setTimeout(r,300));await route.continue();});
 await page.getByRole('button',{name:'只读枚举预览',exact:true}).click();
 await expect(page.getByRole('status').filter({hasText:'正在核对权限与读取发现结果'})).toBeVisible();
 await expect(page.getByText('只读枚举完成；此结果不代表正式生效',{exact:true})).toBeVisible();await page.unroute('**/discovery-preview');
 await expect(page.getByText('尚无正式发现实例；预览不会冒充实际生效。',{exact:true})).toBeVisible();
 mib.setScalarValue('ifNumber',7);await page.getByRole('button',{name:'重新发起只读枚举',exact:true}).click();
 await expect(page.getByText('枚举结果未知；不自动重放',{exact:true})).toBeVisible();await page.screenshot({path:join(directory,'enumeration-budget-unknown.png'),fullPage:true});
 const unknownPackets=packets;await page.getByRole('button',{name:'只读枚举预览',exact:true}).click();await expect(page.getByText('枚举结果未知；不自动重放',{exact:true})).toBeVisible();assert.equal(packets,unknownPackets);
 mib.setScalarValue('ifNumber',1);await page.getByRole('button',{name:'重新发起只读枚举',exact:true}).click();
 await expect(page.getByText('只读枚举完成；此结果不代表正式生效',{exact:true})).toBeVisible();
 passed('real loading empty-state budget-error UI and explicit retry; unknown same-key never rereads target');
 await expect(page.getByText('port-before',{exact:true})).toBeVisible();passed('Lit draft rule save immutable publish authorized resource and real UDP enumeration');
 const previewBody={version:version.version,resource:{type:'network_device',id:701},operation_key:'preview-repeat'};
 await api('POST',`/api/metrics/templates/${id}/discovery-preview`,previewBody);const beforeRepeat=packets;
 await api('POST',`/api/metrics/templates/${id}/discovery-preview`,previewBody);assert.equal(packets,beforeRepeat);
 assert.equal((await request('POST',`/api/metrics/templates/${id}/discovery-preview`,{...previewBody,resource:{type:'network_device',id:702}},readerToken)).status,403);
 assert.equal((await request('GET','/api/metrics/discovery/network_device/701',undefined,readerToken)).status,403);
 assert.equal((await request('POST',`/api/metrics/templates/${id}/discovery-preview`,{...previewBody,sql:'SELECT 1'})).status,400);
 passed('preview idempotency no duplicate packets; resource isolation; arbitrary SQL refused');
 const base='/api/metrics/template-bindings/network_device/701';
 await page.getByRole('checkbox',{name:'选择模板 MAX245 真实接口发现',exact:true}).check();
 await page.getByRole('switch',{name:'启用此对象采集',exact:true}).check();
 await page.getByRole('button',{name:'检查配置',exact:true}).click();
 await expect(page.getByRole('button',{name:'试采',exact:true})).toBeEnabled();
 await page.getByRole('button',{name:'试采',exact:true}).click();
 await expect(page.getByText('试采通过',{exact:true})).toBeVisible();
 await page.getByRole('button',{name:'首次绑定并启用',exact:true}).click();
 await expect(page.getByRole('button',{name:'立即采集',exact:true})).toBeEnabled();
 passed('Lit native resource configuration probe trial and first binding application through real JWT routes');
 const jobs=new JobRegistry();new MetricScheduler(new MysqlScheduleStore(pool,registry,'production'),registry,createAssetCollectorAccess(true),Date.now,
   undefined,new MetricFormalization(pool,registry),createCollectNowAuthorizer({loadActor:(id,v)=>actorContextService.loadActiveActor(id,v),loadActorOn:(c,id,v)=>actorContextService.loadActiveActorOn(c as never,id,v,undefined,true)})).register(jobs);
 const worker=new WorkerRuntime(new MysqlWorkflowStore(()=>pool as never),`max245-${nonce}`,30);
 const collect=async(step:string,fromBrowser=false,expected='completed')=>{now=Date.now();mib.setScalarValue('uptime',100000+Math.floor((now-evidence.started)/10));
   let key='discovery-'+step;if(fromBrowser){const response=page.waitForResponse((r:any)=>r.url().endsWith(base+'/collect')&&r.request().method()==='POST');await page.getByRole('button',{name:'立即采集',exact:true}).click();key=(await (await response).json()).caller_key;}else await api('POST',base+'/collect',{caller_key:key,expected_revision:1});
   for(let n=0;n<30;n++){await worker.runOnce((j,c)=>jobs.execute(j,c),Date.now());const task=await api('GET',base+'/collect/'+key);
     if(['completed','failed','unknown'].includes(task.state)){assert.equal(task.state,expected,JSON.stringify(task));(evidence.tasks??=[]).push({step,task,packets,state:await api('GET','/api/metrics/discovery/network_device/701')});return task;}await new Promise(r=>setTimeout(r,100));}throw Error('collect deadline');};
 evidence.started=Date.now();evidence.first_task=await collect('first',true);
 let states=await api('GET','/api/metrics/discovery/network_device/701');evidence.first_state=states;const [debugBinding]=await pool.query<any[]>('SELECT payload FROM metric_policy_bindings WHERE resource_key=?',['network_device:701']);evidence.first_binding=debugBinding[0]?.payload;assert.equal(states.rows[0].state.members.length,1);const originalId=states.rows[0].state.members[0].id;
 await collect('repeat');states=await api('GET','/api/metrics/discovery/network_device/701');assert.equal(states.rows[0].state.members.length,1);
 setInterface('port-renamed','020000000001',2);await collect('renamed');states=await api('GET','/api/metrics/discovery/network_device/701');
 assert.equal(states.rows[0].state.members[0].id,originalId);assert.equal(states.rows[0].state.members[0].name,'port-renamed');
 const [episodes]=await pool.query<any[]>('SELECT event_id,payload FROM metric_trigger_episodes');assert.equal(episodes.length,1);assert.equal((typeof episodes[0].payload==='string'?JSON.parse(episodes[0].payload):episodes[0].payload).state,'open');
 const eventId=episodes[0].event_id;await api('GET',`/api/metrics/template-events/${eventId}`);
 passed('existing formal writer generates item and trigger instances; duplicate enumeration and rename preserve identity; unique event opens');
 // Chief R1/R2: real protocol failures reach the existing formal writer, never a pure reconcile shortcut.
 const unchanged=async(step:string)=>{const before=await api('GET','/api/metrics/discovery/network_device/701');
   const task=await collect(step,false,'failed');assert.equal(task.samples.length,0);assert(task.attempts.some((a:any)=>a.status==='failed'||a.status==='partial'));
   const after=await api('GET','/api/metrics/discovery/network_device/701');assert.deepEqual(after,before);
   const [events]=await pool.query<any[]>('SELECT event_id FROM metric_trigger_episodes');assert.equal(events.length,1);assert.equal(events[0].event_id,eventId);};
 disappear();mib.setScalarValue('ifNumber',1);await unchanged('incomplete-empty');
 await new Promise(r=>setTimeout(r,3100));await unchanged('incomplete-empty-after-retirement-deadline');
 setInterface('port-renamed','020000000001',2);mib.setScalarValue('ifNumber',2);await unchanged('incomplete-short');
 mib.setScalarValue('ifNumber',1);changeDuringWalk=true;await unchanged('count-changed-during-walk');
 mib.setScalarValue('ifNumber',1);
 mib.addTableRow('interfaces',[3,'shared-mac-sibling',6,1500,1000000000,Buffer.from('020000000001','hex'),1,2]);
 mib.addTableRow('extended',[3,'shared-mac-sibling',Buffer.from('0000000000001000','hex'),Buffer.from('0000000000002000','hex'),1000,0]);
 mib.setScalarValue('ifNumber',2);await unchanged('ambiguous-sibling-joined');
 mib.deleteTableRow('interfaces',[3]);mib.deleteTableRow('extended',[3]);mib.setScalarValue('ifNumber',1);
 await collect('sibling-left');states=await api('GET','/api/metrics/discovery/network_device/701');assert.equal(states.rows[0].state.members.length,1);assert.equal(states.rows[0].state.members[0].id,originalId);
 // A fresh collector (preview) and a reboot keep the deterministic singleton identity.
 const restarted=await api('POST',`/api/metrics/templates/${id}/discovery-preview`,{...previewBody,operation_key:'restart-identity'});
 assert.equal(restarted.rules[0].members[0].dimensions.interface_epoch,states.rows[0].state.members[0].dimensions.interface_epoch);
 const uptimeBefore=mib.getScalarValue('uptime');mib.setScalarValue('uptime',10);
 const rebooted=await api('POST',`/api/metrics/templates/${id}/discovery-preview`,{...previewBody,operation_key:'reboot-identity'});
 assert.equal(rebooted.rules[0].members[0].identity,restarted.rules[0].members[0].identity);mib.setScalarValue('uptime',uptimeBefore);
 passed('Chief R1/R2: incomplete empty/short/changing count and shared-MAC ambiguity preserve writer state, items and sole event beyond retirement deadline; sibling loss/restart/reboot preserve identity');
 setInterface('port-moved-index','020000000001',2,2);await collect('dimension-change');states=await api('GET','/api/metrics/discovery/network_device/701');assert.equal(states.rows[0].state.members[0].id,originalId);assert.equal(states.rows[0].state.members[0].dimension_history.length,2);const [dimensionEvents]=await pool.query<any[]>('SELECT event_id FROM metric_trigger_episodes');assert.equal(dimensionEvents.length,1);passed('real protocol dimension change retains instance identity and single existing event; dimensional history remains separate');
 disappear();await collect('missing');states=await api('GET','/api/metrics/discovery/network_device/701');assert.equal(states.rows[0].state.members[0].state,'waiting');
 await evaluateTemplateClock(pool,Date.now()+1100);assert.equal((await api('GET',`/api/metrics/template-events/${eventId}`)).episode.state,'open');
 setInterface('port-reappeared','020000000001',2);await collect('reappeared');states=await api('GET','/api/metrics/discovery/network_device/701');assert.equal(states.rows[0].state.members[0].id,originalId);assert.equal(states.rows[0].state.members[0].state,'active');
 setInterface('replacement','020000000002',2);await collect('reuse');states=await api('GET','/api/metrics/discovery/network_device/701');assert.equal(states.rows[0].state.members.length,2);
 assert.equal(states.rows[0].state.members.find((m:any)=>m.id===originalId).state,'waiting');
 await new Promise(r=>setTimeout(r,1100));await collect('disabled');states=await api('GET','/api/metrics/discovery/network_device/701');assert.equal(states.rows[0].state.members.find((m:any)=>m.id===originalId).state,'disabled');
 await new Promise(r=>setTimeout(r,2100));await collect('retired');states=await api('GET','/api/metrics/discovery/network_device/701');assert.equal(states.rows[0].state.members.find((m:any)=>m.id===originalId).state,'retired');
 passed('successful empty enumeration waiting; reappearance preserves identity; ifIndex reuse new instance; elapsed wait disables then retires without recovery');
 const row=states.rows[0],replacement=row.state.members.find((m:any)=>m.id!==originalId);
 const stop={expected_revision:row.revision,template_id:id,rule_id:row.rule_id,instance_id:replacement.id,action:'disabled'};
 const lock=await pool.getConnection();await lock.beginTransaction();await lock.query('SELECT payload FROM metric_policy_bindings WHERE resource_key=? FOR UPDATE',['network_device:701']);
 const waiting=request('POST','/api/metrics/discovery/network_device/701/stop',stop);
 await new Promise(r=>setTimeout(r,100));await pool.query("DELETE rp FROM role_permissions rp JOIN permissions p ON p.id=rp.permission_id WHERE rp.role_id=701 AND p.code='metric:manage'");
 await lock.commit();lock.release();assert.equal((await waiting).status,403);
 await pool.query("INSERT INTO role_permissions(role_id,permission_id) SELECT 701,id FROM permissions WHERE code='metric:manage'");
 await api('POST','/api/metrics/discovery/network_device/701/stop',stop);await api('POST','/api/metrics/discovery/network_device/701/stop',stop);
 setInterface('replacement','020000000002',1);const stopped=await collect('stopped');assert.equal(stopped.samples.length,0);
 assert.equal((await api('GET',`/api/metrics/template-events/${eventId}`)).episode.state,'open');
 const [count]=await pool.query<any[]>("SELECT COUNT(*) n FROM metric_observations WHERE JSON_UNQUOTE(JSON_EXTRACT(payload, '$.resource_id'))=?",['701']);assert(count[0].n>0);
 const history=await api('POST','/api/metrics/query',{resource:{type:'network_device',id:701},from:new Date(evidence.started-60000).toISOString(),to:new Date().toISOString(),view:'all',history:true});
 assert(history.metrics.some((m:any)=>m.series.some((s:any)=>s.buckets.some((b:any)=>b.sources.length))));evidence.history=history;passed('lock-wait revocation rollback; idempotent disable; stopped sampling has no false recovery; authorized historical observations retained');
 // Joint MAX240/main + MAX245: retirement must keep real formal pages readable,
 // and an already issued cursor must not bypass live authorization on the next read.
 const historicalMetric=history.metrics.find((m:any)=>m.series.some((s:any)=>s.buckets.some((b:any)=>b.sources.length)));
 const historicalSeries=historicalMetric.series.find((s:any)=>s.buckets.some((b:any)=>b.sources.length));
 const pageQuery={resource:{type:'network_device',id:701},metric:{id:historicalMetric.definition.id,semantic_version:historicalMetric.definition.semantic_version},
   dimensions:historicalSeries.dimensions,from:history.window.from,to:history.window.to,limit:1};
 const firstPage=await api('POST','/api/metrics/observations',pageQuery);assert(firstPage.has_more);assert.equal(firstPage.observations.length,1);
 const secondPage=await api('POST','/api/metrics/observations',{...pageQuery,cursor:firstPage.next_cursor});
 assert.equal(secondPage.total,firstPage.total);assert.notEqual(secondPage.observations[0].id,firstPage.observations[0].id);
 assert.equal((await request('POST','/api/metrics/observations',{...pageQuery,resource:{type:'network_device',id:702},cursor:firstPage.next_cursor})).status,400);
 await pool.query("DELETE rp FROM role_permissions rp JOIN permissions p ON p.id=rp.permission_id WHERE rp.role_id=701 AND p.code='network_devices:view'");
 try{assert.equal((await request('POST','/api/metrics/observations',{...pageQuery,cursor:firstPage.next_cursor})).status,403);}
 finally{await pool.query("INSERT INTO role_permissions(role_id,permission_id) SELECT 701,id FROM permissions WHERE code='network_devices:view'");}
 assert.equal((await api('POST','/api/metrics/observations',{...pageQuery,cursor:firstPage.next_cursor})).observations[0].id,secondPage.observations[0].id);
 evidence.retired_history_pages={total:firstPage.total,first:firstPage.observations[0].id,second:secondPage.observations[0].id,revoked:403,foreign_cursor:400};
 passed('joint main history and discovery retirement: real formal keyset pages, resource-bound cursor, live JWT permission revocation and restored exact page');
 // R3 uses a deliberate cross-resource ID/revision collision fixture, real JWT reads and stop writes.
 states=await api('GET','/api/metrics/discovery/network_device/701');
 const collision=structuredClone(states.rows[0].state);collision.members=[{...collision.members[0],name:'B-collision-row',state:'active',manual:false}];
 await pool.execute('INSERT INTO metric_discovery_states(resource_key,template_id,rule_id,revision,payload) VALUES(?,?,?,?,?)',
   ['network_device:702',id,states.rows[0].rule_id,states.rows[0].revision,JSON.stringify(collision)]);
 const resourceSelect=page.getByRole('combobox',{name:'发现授权资源',exact:true});
 const uiRows=page.locator('template-discovery app-data-table').filter({hasText:'保留历史操作'});
 await resourceSelect.selectOption('network_device:702');await expect(uiRows).toContainText('B-collision-row');
 const heldRead=async(status:number,action:()=>Promise<void>)=>{
   let release!:()=>void,arrived!:()=>void,finished!:()=>void;
   const gate=new Promise<void>(r=>release=r),seen=new Promise<void>(r=>arrived=r),done=new Promise<void>(r=>finished=r);
   const handler=async(route:any)=>{const response=await route.fetch();arrived();await gate;try{if(status===200)await route.fulfill({response});else await route.fulfill({status,contentType:'application/json',body:JSON.stringify({error:'STALE_TEST_RESPONSE'})});}catch{/* selector cancellation already discarded this response */}finally{finished();}};
   await page.route('**/api/metrics/discovery/network_device/701',handler);
   await resourceSelect.selectOption('network_device:701');await seen;await action();release();await done;
   await page.unroute('**/api/metrics/discovery/network_device/701',handler);
 };
 for(const status of [200,401,403]){
   await heldRead(status,async()=>{await resourceSelect.selectOption('network_device:702');await expect(uiRows).toContainText('B-collision-row');});
   await expect(uiRows).toContainText('B-collision-row');assert.equal(await page.evaluate(()=>Boolean(localStorage.getItem('token'))),true);
 }
 await heldRead(200,async()=>{await resourceSelect.selectOption('');});await expect(uiRows).toHaveCount(0);
 await resourceSelect.selectOption('network_device:702');await expect(uiRows).toContainText('B-collision-row');
 // R3 supplemental: actual authFetch + real refresh rotation in owned MySQL.
 await page.evaluate(async(value:string)=>{const {apiClient}=await import('/src/api/index.ts');apiClient.setRefreshToken(value);},initialRefresh);
 const expired=signAccessToken(actor,secret,-1);
 const resetB=async()=>{await pool.execute('UPDATE metric_discovery_states SET revision=revision+1,payload=? WHERE resource_key=?',[JSON.stringify(collision),'network_device:702']);
   await resourceSelect.selectOption('network_device:702');await page.getByRole('button',{name:'刷新生命周期',exact:true}).click();await expect(uiRows.getByRole('button',{name:'禁用',exact:true})).toBeEnabled();};
 for(const rotation of ['own','parallel'])for(const action of ['read','preview','stop']){
   await resetB();if(action==='preview'){await resourceSelect.selectOption('network_device:701');await expect(uiRows).toContainText('已退役');}
   const target=action==='preview'?`**/api/metrics/templates/${id}/discovery-preview`:action==='stop'?'**/api/metrics/discovery/network_device/702/stop':'**/api/metrics/discovery/network_device/702';
   let calls=0,release!:()=>void,arrived!:()=>void,finished!:()=>void;
   const gate=new Promise<void>(r=>release=r),seen=new Promise<void>(r=>arrived=r),done=new Promise<void>(r=>finished=r);
   const handler=async(route:any)=>{calls++;
     if(rotation==='own'){if(calls===1)await route.continue({headers:{...route.request().headers(),authorization:`Bearer ${expired}`}});else await route.continue();return;}
     const response=await route.fetch();arrived();await gate;await route.fulfill({response});finished();};
   await page.route(target,handler);const before=refreshCalls;
   const startToken=await page.evaluate(()=>localStorage.getItem('token'));
   const button=action==='read'?page.getByRole('button',{name:'刷新生命周期',exact:true}):action==='preview'?page.getByRole('button',{name:'只读枚举预览',exact:true}):uiRows.getByRole('button',{name:'禁用',exact:true});
   await button.click();
   if(rotation==='parallel'){
     await seen;
     const refreshTarget='**/api/metrics/template-governance/resources';let first=true;
     const trigger=async(route:any)=>{if(first){first=false;await route.continue({headers:{...route.request().headers(),authorization:`Bearer ${expired}`}});}else await route.continue();};
     await page.route(refreshTarget,trigger);
     await page.evaluate(async()=>{const {metricRequest}=await import('/src/app/ui/components/metric-api.ts');await metricRequest('template-governance/resources');});
     await page.unroute(refreshTarget,trigger);release();await done;
   }
   await expect(page.getByRole('status').filter({hasText:'正在核对权限与读取发现结果'})).toHaveCount(0);
   if(action==='preview')await expect(page.getByText('只读枚举完成；此结果不代表正式生效',{exact:true})).toBeVisible();
   else if(action==='stop')await expect(uiRows).toContainText('已禁用');else await expect(uiRows).toContainText('B-collision-row');
   assert.equal(refreshCalls,before+1);assert.equal(calls,rotation==='own'?2:1);
   assert(await page.evaluate((old:string)=>localStorage.getItem('token')!==old,startToken));
   (evidence.auth_refresh??=[]).push({rotation,action,refresh_calls:refreshCalls-before,target_requests:calls,busy:false,token_rotated:true});
   await page.unroute(target,handler);
 }
 await resetB();
 let unknownStops=0;
 const loseReceipt=async(route:any)=>{unknownStops++;const response=await route.fetch();assert.equal(response.status(),200);await route.abort('failed');};
 await page.route('**/api/metrics/discovery/network_device/702/stop',loseReceipt);
 await uiRows.getByRole('button',{name:'禁用',exact:true}).click();
 await expect(page.locator('template-discovery').getByRole('alert')).toBeVisible();
 await expect(page.getByRole('status').filter({hasText:'正在核对权限与读取发现结果'})).toHaveCount(0);
 await expect(uiRows.getByRole('button',{name:'禁用',exact:true})).toBeDisabled();
 assert.equal(unknownStops,1);assert.equal((await api('GET','/api/metrics/discovery/network_device/702')).rows[0].state.members[0].state,'disabled');
 await page.unroute('**/api/metrics/discovery/network_device/702/stop',loseReceipt);
 await page.getByRole('button',{name:'刷新生命周期',exact:true}).click();await expect(uiRows).toContainText('已禁用');assert.equal(unknownStops,1);
 evidence.unknown_stop={committed:true,requests:unknownStops,automatic_retry:false,read_back:'disabled'};
 await resetB();
 await page.screenshot({path:join(directory,'transparent-refresh-completed.png'),fullPage:true});
 passed('R3 supplemental: real refresh-token transaction and JWT retry; own/parallel refresh completes Lit read, preview and stop without lost receipt or permanent loading');
 let releaseStop!:()=>void,stopArrived!:()=>void,stopDone!:()=>void;const stopGate=new Promise<void>(r=>releaseStop=r),stopSeen=new Promise<void>(r=>stopArrived=r),stopFinished=new Promise<void>(r=>stopDone=r);
 await page.route('**/api/metrics/discovery/network_device/702/stop',async(route:any)=>{const response=await route.fetch();assert.equal(response.status(),200);stopArrived();await stopGate;try{await route.fulfill({response});}catch{}finally{stopDone();}});
 await uiRows.getByRole('button',{name:'禁用',exact:true}).click();await stopSeen;
 await resourceSelect.selectOption('network_device:701');await expect(uiRows).toContainText('已退役');releaseStop();await stopFinished;
 await expect(uiRows).not.toContainText('B-collision-row');
 const bStopped=await api('GET','/api/metrics/discovery/network_device/702');assert.equal(bStopped.rows[0].state.members[0].state,'disabled');
 assert.deepEqual(await api('GET','/api/metrics/discovery/network_device/701'),states);
 await page.screenshot({path:join(directory,'resource-race-isolation.png'),fullPage:true});
 passed('Chief R3: real Lit A/B reverse responses and stale 401/403, cleared selection, pending stop switched to A; only displayed B mutation reaches B; JWT session and A state retained');
 await page.getByRole('button',{name:'刷新生命周期',exact:true}).click();await expect(page.getByText('已退役',{exact:true})).toBeVisible();
 for(const [width,height]of [[1440,900],[1366,768],[1920,1080]]){await page.setViewportSize({width,height});await page.getByText('已退役',{exact:true}).scrollIntoViewIfNeeded();await page.screenshot({path:join(directory,`discovery-${width}.png`),fullPage:true});
   assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));}
 await page.getByRole('button',{name:'刷新生命周期',exact:true}).focus();await page.keyboard.press('Tab');evidence.focus=await page.evaluate(()=>{let e:any=document.activeElement;while(e?.shadowRoot?.activeElement)e=e.shadowRoot.activeElement;return{tag:e?.tagName,name:e?.getAttribute('aria-label')||e?.textContent?.trim()?.slice(0,80)};});assert(['BUTTON','SELECT','INPUT','A'].includes(evidence.focus.tag));assert(evidence.focus.name);
 assert.deepEqual(errors,[]);passed('three desktop sizes visible lifecycle and keyboard focus; no page errors');
 if(process.env.MAX245_HISTORY_STUDY==='1'){
   const {verifyHistoryStudy}=await import('./max245-history-study.js');
   await verifyHistoryStudy({pool,page,api,request,directory,passed,evidence,expect,readerToken,restartDatabase:async()=>{assert.equal(docker('inspect','--format','{{index .Config.Labels \"slide.max245.nonce\"}}',handle.container),nonce);docker('restart',handle.container);const until=Date.now()+45000;for(;;){try{await pool.query('SELECT 1');break;}catch(e){if(Date.now()>until)throw e;await new Promise(r=>setTimeout(r,300));}}}});assert.deepEqual(errors,[]);
 }
 if(process.env.MAX245_DYNAMIC_DISCOVERY==='1'){await(await import('./max245-dynamic-discovery.js')).runDynamicDiscovery({pool,root,port:handle.port,host,page,api,request,worker,jobs,directory,nonce,passed,evidence,expect,readerToken});assert.deepEqual(errors,[]);}
 evidence.packets=packets;evidence.states=states;evidence.source=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
 const [audit]=await pool.query<any[]>('SELECT COUNT(*) n FROM metric_discovery_audit');evidence.audit_count=audit[0].n;
}catch(error){failures++;console.error(error);evidence.error=String(error);}
finally{
 try{await browser?.close();await vite?.close();await app.close();if(agent)await new Promise<void>(r=>agent!.close(()=>r()));await dbConnection.close();if(owned)await owned.drop();await root?.end();
   if(handle.container){assert.equal(docker('inspect','--format','{{ index .Config.Labels "slide.max245.nonce" }}',handle.container),nonce);docker('stop','--time','10',handle.container);}evidence.cleanup=true;
 }catch(error){failures++;evidence.cleanup=String(error);console.error('CLEANUP_UNKNOWN',error);}
 writeFileSync(join(directory,'evidence.json'),JSON.stringify(evidence,null,2));
 writeFileSync(join(directory,'hashes.json'),JSON.stringify(Object.fromEntries(readdirSync(directory).filter(n=>n!=='hashes.json').map(n=>[n,createHash('sha256').update(readFileSync(join(directory,n))).digest('hex')])),null,2));
 console.log('EVIDENCE',directory);
}
if(failures)process.exitCode=1;
