/** MAX-211 read-only real-data/component acceptance. No worker or model starts.
 * MAX211_ENV_FILE must reference the authorized environment; never copy secrets.
 * This subset harness does not replace the final full-server integration gate.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
process.chdir(fileURLToPath(new URL('../../',import.meta.url)));
const require = createRequire(resolve('apps/db-ops-api/package.json'));
assert(process.env.MAX211_ENV_FILE, 'MAX211_ENV_FILE is required');
require('dotenv').config({ path: process.env.MAX211_ENV_FILE, quiet: true });
const { chromium, expect } = createRequire(resolve('frontend/package.json'))('@playwright/test');
const { createServer } = await import('../../frontend/node_modules/vite/dist/node/index.js');
const { default: Fastify } = await import('../../apps/db-ops-api/node_modules/fastify/fastify.js');
const { dbConnection, decryptData } = await import('../../apps/db-ops-api/src/db-connection.js');
const { instanceDatabaseService: instances } = await import('../../apps/db-ops-api/src/instance-database-service.js');
const { databaseService } = await import('../../apps/db-ops-api/src/database-service.js');
const { schemaDatabaseService: schema } = await import('../../apps/db-ops-api/src/schema-database-service.js');
const { schemaService } = await import('../../apps/db-ops-api/src/schema-service.js');
const { indexDatabaseService: indexes } = await import('../../apps/db-ops-api/src/index-database-service.js');
const { metricsDatabaseService: metrics } = await import('../../apps/db-ops-api/src/metrics-database-service.js');
const { publicInstanceDto } = await import('../../apps/db-ops-api/src/security/public-dto.js');
const { actorContextService, signAccessToken } = await import('../../apps/db-ops-api/src/auth/actor-context.js');
const { createVerifyToken } = await import('../../apps/db-ops-api/src/auth-middleware.js');
const { hasInstanceAccess } = await import('../../apps/db-ops-api/src/auth/require-instance-access.js');
const { registerResourceRoutes } = await import('../../apps/db-ops-api/src/resources/resource-routes.js');
const { ResourceDiagnosticService } = await import('../../apps/db-ops-api/src/resources/resource-diagnostic-service.js');
const { resourceService } = await import('../../apps/db-ops-api/src/resources/resource-service.js');
const { observationService } = await import('../../apps/db-ops-api/src/resources/observation-service.js');
const { operationalSource } = await import('../../apps/db-ops-api/src/metrics/consumers/runtime.js');
const { alertDatabaseService } = await import('../../apps/db-ops-api/src/alert-database-service.js');
const { registerMetricConfigurationRoutes } = await import('../../apps/db-ops-api/src/metrics/config/routes.js');
const { registerMetricConsumerRoutes } = await import('../../apps/db-ops-api/src/metrics/consumers/routes.js');
const { collectionCapabilityTracker } = await import('../../apps/db-ops-api/src/collection-capabilities.js');
const targetId = Number(process.env.MAX211_INSTANCE_ID || 1);
const output = process.env.MAX211_OUTPUT_DIR || '/Users/max/Coding/40-Slide/outputs/MAX-211-20261021';
await mkdir(output, { recursive: true });
const report: any = { commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), source: 'real MySQL + persisted snapshots, current candidate services in a read-only HTTP subset harness; no worker; full server integration pending MAX-209', scenarios: [], screenshots: [], errors: [] };
report.sourceFiles={};
for(const file of ['frontend/src/app/ui/views/health-score-state.ts','frontend/src/app/ui/views/health-score-tab.ts','frontend/src/app/ui/views/instances-db.ts','frontend/src/app/ui/views/instance-detail.ts','frontend/src/app/ui/views/schema-management.ts','frontend/src/app/ui/views/index-management.ts','apps/db-ops-api/src/database-service.ts','apps/db-ops-api/src/schema-database-service.ts'])report.sourceFiles[file]=createHash('sha256').update(await readFile(file)).digest('hex');
let browser: any, vite: any, target: any;
const app = Fastify({ logger: false });
try {
  assert(await dbConnection.initialize());
  const pool = dbConnection.getPool()!;
  const [users] = await pool.query<any[]>("SELECT id,session_version FROM users WHERE username='admin' AND status='active'");
  assert.equal(users.length, 1, 'Expected authorized local admin test identity');
  const actor = await actorContextService.loadActiveActor(users[0].id, Number(users[0].session_version));
  assert(hasInstanceAccess(actor, targetId));
  const secret = process.env.JWT_SECRET_KEY!;
  const token = signAccessToken(actor, secret, '15m');
  const instance = await instances.getInstanceById(targetId); assert(instance?.db_type === 'mysql');
  // Query only the authorized managed target with its existing credential.
  target = require('mysql2/promise').createPool({host:instance.host,port:instance.port,user:instance.username,password:decryptData(instance.password_encrypted),database:instance.database_name,connectTimeout:10000});
  app.addHook('onRequest', async (request:any,reply:any) => { if(request.method!=='GET') return reply.code(405).send({error:'READ_ONLY_ACCEPTANCE'}); });
  app.addHook('preHandler', createVerifyToken(secret));
  app.addHook('preHandler', async (request: any, reply: any) => {
    if (!request.user || !hasInstanceAccess(request.user, targetId)) return reply.code(403).send({error:'TEST_RESOURCE_FORBIDDEN'});
  });
  // Limit this acceptance fixture to its authorized target and read metric
  // evidence sequentially, avoiding unrelated resources and pool fan-out.
  const diagnostic = new ResourceDiagnosticService({
    list: async () => [{resource:{type:'instance',id:targetId},label:instance.name,status:instance.status,attributes:{healthStatus:publicInstanceDto(instance).health_status}}],
    detail: async (ref:any,actor:any) => resourceService.detail(actor,ref),
    observations: async (ref:any,actor:any) => {
      if(await operationalSource(ref)!=='semantic')return [];
      const rows=[];
      for(const id of ['cpu_usage','memory_usage','disk_usage','connections','qps','tps','slow_queries'])rows.push(await observationService.latest(actor,ref,id,{validForMs:300000}));
      return rows;
    },
    relations: async (ref:any,actor:any) => resourceService.currentRelations(actor,ref),
    alerts: async (ref:any) => {const result:any=await alertDatabaseService.getAlerts({instance_id:ref.id,limit:200,strict:true});return Array.isArray(result)?result:result.items;},
  });
  await registerResourceRoutes(app, async () => {},diagnostic);
  await registerMetricConfigurationRoutes(app, async () => {});
  await registerMetricConsumerRoutes(app, async () => {});
  const base = `/api/database/instances/${targetId}`;
  app.get('/api/database/instances', async () => [publicInstanceDto(instance)]);
  app.get(base, async () => publicInstanceDto(instance));
  app.get(base+'/health-history', async () => instances.getHealthScoreHistory(targetId, 30));
  app.get(base+'/health-checks', async () => (await instances.getLatestHealthChecks(targetId)) ?? { checks: [], status:'unknown' });
  app.get(base+'/collection-capabilities', async () => collectionCapabilityTracker.getCapabilities(targetId, 'mysql'));
  app.get(base+'/capacity', async () => (databaseService as any).getMySQLCapacity({pool:target}));
  app.get(base+'/capacity/history', async () => ({history:await metrics.getCapacityHistory(targetId,168)}));
  app.get(`/api/schema/snapshots/${targetId}`, async () => schema.getSnapshotTimes(targetId));
  app.get(`/api/schema/snapshot/${targetId}`, async () => ({tables:await schema.getTableList(targetId)}));
  app.get(`/api/schema/changes/${targetId}`, async () => { const rows=await schemaService.detectChanges(targetId);return {changes:Array.isArray(rows)?rows:[]}; });
  app.get(`/api/indexes/${targetId}`, async () => indexes.getIndexesByInstance(targetId));
  app.get(`/api/indexes/${targetId}/redundancy`, async () => indexes.getRedundancyReport(targetId));
  app.get(`/api/indexes/${targetId}/unused`, async () => indexes.getUnusedIndexes(targetId));
  const api = await app.listen({host:'127.0.0.1',port:0});
  const read = async (path: string) => { const r=await fetch(api+path,{headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(15000)});assert.equal(r.status,200,path);return r.json(); };
  const capacity:any=await read(base+'/capacity'), snapshot:any=await read(`/api/schema/snapshot/${targetId}`), indexRows:any=await read(`/api/indexes/${targetId}`);
  assert(capacity.observed_at && capacity.source && capacity.scope);assert(capacity.databases.length>0 && snapshot.tables.length>0 && indexRows.length>0);
  assert(snapshot.tables.every((r:any)=>r.snapshot_time));
  report.realData={capacity:{total:capacity.total_size_gb,databases:capacity.databases,observed_at:capacity.observed_at,source:capacity.source,scope:capacity.scope},schema:{tables:snapshot.tables.length,snapshot_time:snapshot.tables[0].snapshot_time},indexes:{tables:new Set(indexRows.map((r:any)=>r.table_name)).size,indexes:new Set(indexRows.map((r:any)=>JSON.stringify([r.table_name,r.index_name]))).size,collected_at:indexRows[0].collected_at}};
  report.realHealth={instance:publicInstanceDto(instance).health_status,last_health_check_at:instance.last_health_check_at,checks:await read(base+'/health-checks'),overview:await read('/api/resources/overview')};
  vite=await createServer({configFile:false,root:resolve('frontend'),server:{host:'127.0.0.1',port:0,proxy:{'/api':api}},logLevel:'error'});await vite.listen();
  const web=`http://127.0.0.1:${vite.httpServer.address().port}`;
  browser=await chromium.launch({headless:true});
  const page=await browser.newPage();
  await page.addInitScript((token:string)=>{localStorage.setItem('token',token);localStorage.setItem('slide.control.session_token.v1',token);localStorage.setItem('permissions',JSON.stringify(['*']));},token);
  page.on('pageerror',(e:any)=>report.errors.push(e.message));
  const components:any={health:['health-score-tab','health-score-tab'],schema:['schema-management-page','schema-management'],indexes:['index-management-page','index-management'],capacity:['instance-detail-page','instance-detail'],overview:['instance-detail-page','instance-detail'],list:['instances-page','instances-db']};
  await page.route('**/max211-fixture?*', async (route:any)=>{
    const url=new URL(route.request().url()),key=url.searchParams.get('view')!,[tag,module]=components[key];
    await route.fulfill({contentType:'text/html',body:`<!doctype html><html lang="zh-CN" data-theme-mode="${url.searchParams.get('theme')}"><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>MAX-211 acceptance</title><body style="margin:0;padding:16px;background:var(--bg);color:var(--text)"><p>MAX-211 · ${key} · ${url.searchParams.get('scene')||'真实只读数据'}</p><${tag} instanceid="${targetId}"></${tag}><script type="module">import '/src/app/styles.css';import '/src/app/ui/views/${module}.ts';${key==='capacity'?`customElements.whenDefined('${tag}').then(async()=>{const e=document.querySelector('${tag}');await e.updateComplete;e._applyTab('capacity');});`:''}</script></body></html>`});
  });
  const visit=async(key:string,theme:string,width:number,scene='real')=>{
    await page.setViewportSize({width,height:1000});
    console.log('Capture',key,theme,width,scene);
    await page.goto(`${web}/max211-fixture?view=${key}&theme=${theme}&id=${targetId}&scene=${scene}`);
    const selector=key==='health'?'.score-number':key==='schema'?'stat-card':key==='indexes'?'.stats-row':key==='capacity'?'.capacity-list':key==='list'?'resource-metrics-table':'.overview-grid';
    await expect(page.locator(components[key][0]).locator(selector).first()).toBeVisible({timeout:30000});
    if(key==='schema') await expect(page.getByText('加载表结构...', {exact:true})).toHaveCount(0);
    if(key==='indexes') await expect(page.getByText('加载中...', {exact:true})).toHaveCount(0);
    const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);
    report.scenarios.push({key,theme,width,scene,overflow}); assert.equal(overflow,false,`${key} page overflow at ${width}`);
    const file=`${scene}-${key}-${theme}-${width}.png`;await page.screenshot({path:resolve(output,file),fullPage:false,animations:'disabled'});report.screenshots.push(file);
  };
  for(const key of Object.keys(components))for(const theme of ['light','dark'])for(const width of [1440,390])await visit(key,theme,width);
  // In-memory response controls only: never change platform data or timestamps.
  const now=new Date().toISOString();
  for(const scene of ['fresh','empty','old','partial','paused','error']){
    await page.route('**/api/resources/overview', (route:any)=>route.fulfill({json:{items:[{resource:{type:'instance',id:targetId},status:'healthy',quality:scene==='partial'?'partial':'good',freshness:scene==='old'?'stale':'fresh',observedAt:scene==='old'?'2020-01-01T00:00:00Z':now,gaps:[],unresolvedAlerts:0}]}}));
    await page.route(`**${base}`, (route:any)=>route.fulfill({json:{id:targetId,health_status:'healthy',health_score:100,status:'active',hasCredential:true,last_health_check_at:now}}));
    await page.route('**/health-checks', (route:any)=>route.fulfill(scene==='error'?{status:503,json:{error:'CONTROLLED_READ_FAILURE'}}:{json:{status:'healthy',created_at:now,checks:scene==='empty'?[]:[{name:'受控完整检查',status:'ok',score:100}]}}));
    await page.route(`**/api/metrics/config/resources/instance/${targetId}/status`,(route:any)=>route.fulfill({json:{effective_enabled:{enabled:scene!=='paused'}}}));
    await visit('health','light',390,`controlled-${scene}`);
    await expect(page.locator('health-score-tab .score-number')).toHaveText(scene==='fresh'?'100':'未知');
    if(scene==='fresh'){
      await page.locator('health-score-tab .time-range-btn').last().focus();
      await page.keyboard.press('Tab');
      const toggle=page.getByRole('button',{name:/最近健康检查详情/});
      await expect(toggle).toBeFocused();await page.keyboard.press('Enter');
      await expect(toggle).toHaveAttribute('aria-expanded','true');
      await expect(page.getByText('受控完整检查',{exact:true})).toBeVisible();
      report.scenarios.push({key:'health-check-details',scene:'controlled-fresh',keyboard:'Tab + Enter',passed:true});
    }
    await page.unroute('**/api/resources/overview');await page.unroute(`**${base}`);await page.unroute('**/health-checks');await page.unroute(`**/api/metrics/config/resources/instance/${targetId}/status`);
  }
  report.knownExternalErrors=report.errors.filter((message:string)=>message.includes("addColorStop") && message.includes("var(--accent)40"));
  assert.equal(report.errors.length-report.knownExternalErrors.length,0,'New browser runtime errors');
  report.limitations=['Full-server integration pending MAX-209','Historical chart rendering has the known shared CanvasGradient failure (QA-004 / MAX-212); retained as a blocker for final visual integration'];
  report.result='passed affected real-data subset and controlled health states; final integration remains incomplete';
} finally {
  await writeFile(resolve(output,'result.json'),JSON.stringify(report,null,2));
  await browser?.close();await vite?.close();await app.close();await target?.end();await dbConnection.close();
}
console.log(JSON.stringify({result:report.result,scenarios:report.scenarios.length,output}));
