import { expect, test } from '@playwright/test';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { encryptData } from '../../apps/db-ops-api/src/db-connection.js';
import { mkdir, writeFile, open } from 'node:fs/promises';

// Real, isolated MySQL + complete formal Fastify server. Persisted business rows are
// deliberate fixtures; this does not establish live target collection or shared deployment.
const require = createRequire(resolve('../apps/db-ops-api/package.json'));
const mysql = require('mysql2/promise');
const bcrypt = require('bcrypt');
const output = process.env.MAX175_OUTPUT_DIR ?? '/Users/max/Coding/40-Slide/outputs/MAX-175-R2';
const apiPort = 3175, frontendPort = 5195;
const taskSchema = `db_ops_ai_qualification_max175_${process.pid}`;
const base = `http://127.0.0.1:${frontendPort}`;
test.skip(process.env.MAX175_ISOLATED_MYSQL !== '1', 'Requires MAX-175 task-owned MySQL and exclusive task ports');
const processes: ChildProcess[] = [];
let pool: any, token: string, permissions: string[], password = randomBytes(24).toString('hex');
let instanceId: number, serverId: number, serverSwitchId: number, networkId: number;
async function ready(url: string, child: ChildProcess) {
  const until = Date.now() + 60_000;
  while (Date.now() < until) {
    if (child.exitCode !== null) throw new Error(`Task service exited (${child.exitCode}); inspect task logs`);
    try { if ((await fetch(url)).ok) return; } catch { /* startup */ }
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  throw new Error(`Task service readiness timeout: ${url}`);
}
async function launch(args: string[], cwd: string, env: NodeJS.ProcessEnv, log: string) {
  const file = await open(`${output}/${log}`, 'w');
  const child = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', file.fd, file.fd] });
  processes.push(child); await file.close(); return child;
}
test.beforeAll(async () => {
  test.setTimeout(120_000);
  if (process.env.MAX175_ISOLATED_MYSQL !== '1') throw new Error('Requires task-owned MySQL at 127.0.0.1:33175; never point at shared DB');
  await mkdir(output, { recursive: true });
  const env = { ...process.env, DB_HOST:'127.0.0.1', DB_PORT:'33175', DB_USER:'root', DB_PASSWORD:'', DB_NAME:taskSchema,
    JWT_SECRET_KEY:randomBytes(32).toString('hex'), ENCRYPTION_KEY:randomBytes(32).toString('hex'),
    PORT:String(apiPort), AGENT_WS_PORT:'29775', SLIDE_MEMORY_PIPELINE_ENABLED:'false', METRICS_COLLECTION_ENABLED:'false' };
  const migration = execFileSync(process.execPath, ['--import','tsx','init-db.ts'], { cwd:resolve('../apps/db-ops-api'), env, encoding:'utf8', timeout:90_000 });
  await writeFile(`${output}/migration.log`, migration);
  pool = mysql.createPool({ host:env.DB_HOST, port:Number(env.DB_PORT), user:env.DB_USER, password:env.DB_PASSWORD, database:env.DB_NAME, timezone:'Z' });
  await pool.query('UPDATE llm_providers SET enabled=0');
  await pool.query("UPDATE users SET password_hash=?,status='active' WHERE username='admin'", [await bcrypt.hash(password, 10)]);
  await pool.query("INSERT IGNORE INTO user_roles(user_id,role_id) SELECT u.id,r.id FROM users u JOIN roles r ON r.name='admin' WHERE u.username='admin'");
  const [insert] = await pool.query("INSERT INTO database_instances(name,db_type,host,port,username,password_encrypted,environment,status,health_status) VALUES ('MAX-175 订单数据库 · 隔离服务测试资源','mysql','127.0.0.1',33175,'root',?,'testing','inactive','unknown')", [encryptData('unused-isolated-target',env.ENCRYPTION_KEY)]);
  instanceId = insert.insertId;
  for (let i=0;i<55;i++) await pool.query("INSERT INTO database_logs(instance_id,log_level,source,message,raw_content,collected_at) VALUES (?,?,'mysql_error',?,?,DATE_SUB(NOW(),INTERVAL ? SECOND))", [instanceId,i%3?'info':'warning',`事件 ${i+1} · 持久化日志测试记录`,`完整事件 ${i+1}\n${'Long_SQL_context_'.repeat(24)}\nEND-OF-LOG-${i+1}`,i]);
  const [server] = await pool.query("INSERT INTO servers(host,port,label,os_type,credential_type,credential_encrypted,status,collection_enabled) VALUES ('max175-no-target.invalid',22,'MAX-175 隔离服务器','rhel','password',?,'offline',0)",[encryptData(JSON.stringify({username:'unused',password:'unused'}),env.ENCRYPTION_KEY)]);
  serverId = server.insertId;
  const [serverSwitch] = await pool.query("INSERT INTO servers(host,port,label,os_type,credential_type,credential_encrypted,status,collection_enabled) VALUES ('max175-second-no-target.invalid',22,'MAX-175 切换服务器','rhel','password',?,'offline',0)",[encryptData(JSON.stringify({username:'unused',password:'unused'}),env.ENCRYPTION_KEY)]);
  serverSwitchId = serverSwitch.insertId;
  const [network] = await pool.query("INSERT INTO network_devices(name,label,host,vendor,collection_enabled,status) VALUES ('max175-network','MAX-175 隔离网络设备','max175-network.invalid','huawei',0,'unknown')");
  networkId = network.insertId;
  for(const [index,status] of [[1,'up'],[2,'down']] as const) await pool.query("INSERT INTO network_device_interfaces(device_id,if_index,if_name,if_alias,speed_bps,admin_status,oper_status,last_seen_at) VALUES (?,?,?,?,1000000000,'up',?,DATE_SUB(NOW(),INTERVAL 1 HOUR))",[networkId,index,`GigabitEthernet0/0/${index}`,'MAX-175 持久化接口记录 · '+ '长别名'.repeat(12),status]);
  const api = await launch(['--import','tsx','server.ts'], resolve('../apps/db-ops-api'), env, 'api.log');
  await ready(`http://127.0.0.1:${apiPort}/api/health/ready`, api);
  const vite = await launch([resolve('node_modules/vite/bin/vite.js'),'--host','127.0.0.1','--port',String(frontendPort),'--strictPort'], resolve('.'), { ...env,VITE_API_PROXY_TARGET:`http://127.0.0.1:${apiPort}`,VITE_AGENT_WS_PROXY_TARGET:'http://127.0.0.1:29775' }, 'vite.log');
  await ready(base, vite);
  const login = await fetch(`http://127.0.0.1:${apiPort}/api/auth/login`, { method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'admin',password}) });
  if (!login.ok) throw new Error(`Isolated login failed: ${login.status}`);
  token = (await login.json()).token;
  const result = await fetch(`http://127.0.0.1:${apiPort}/api/auth/permissions`, { headers:{Authorization:`Bearer ${token}`} });
  permissions = await result.json();
});
test.afterAll(async () => {
  for (const child of [...processes].reverse()) {
    if (child.exitCode === null) { child.kill('SIGTERM'); await new Promise<void>(resolve => { child.once('exit', () => resolve()); setTimeout(() => { if(child.exitCode===null) child.kill('SIGKILL'); resolve(); },5000).unref(); }); }
  }
  await pool?.end();
  if (process.env.MAX175_ISOLATED_MYSQL === '1') {
    const cleanup = await mysql.createConnection({host:'127.0.0.1',port:33175,user:'root',connectTimeout:5000});
    try {
      await cleanup.query(`DROP DATABASE IF EXISTS \`${taskSchema}\``);
      const [remaining] = await cleanup.query('SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=?',[taskSchema]);
      expect(remaining).toHaveLength(0);
      await writeFile(`${output}/cleanup-fixture.json`,JSON.stringify({schema:taskSchema,remaining,processes:processes.map(child=>({pid:child.pid,exitCode:child.exitCode,signal:child.signalCode}))},null,2));
    }
    finally { await cleanup.end(); }
  }
});

test('database representative: real routes, reading times, metrics and log browsing', async ({ page }) => {
  test.setTimeout(100_000);
  const reads: {path:string;status:number}[] = [], writes: string[] = [], errors: string[] = [], batches: unknown[] = [];
  page.on('response', response => { if(new URL(response.url()).pathname.startsWith('/api/')) reads.push({path:new URL(response.url()).pathname,status:response.status()}); });
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.method()==='POST' && !request.url().includes('/metrics/query') && !request.url().includes('/auth/')) writes.push(new URL(request.url()).pathname); });
  await page.addInitScript(({token,permissions}) => {
    localStorage.setItem('token',token); localStorage.setItem('slide.control.session_token.v1',token);
    localStorage.setItem('permissions',JSON.stringify(permissions)); localStorage.setItem('slide.i18n.locale','zh-CN');
  }, {token,permissions});
  for (const width of [1440,768,390]) for (const theme of ['light','dark']) {
    await page.setViewportSize({width,height:1000});
    await page.goto(`${base}/instance-detail?id=${instanceId}`);
    await page.evaluate(theme => document.documentElement.dataset.themeMode=theme,theme);
    const view=page.locator('instance-detail-page');
    await expect(view.getByRole('heading',{name:'当前需要关注',exact:true})).toBeVisible();
    await expect(view.locator('semantic-metrics')).toHaveCount(0);
    await expect(view.getByText('当前证据不足以判断运行状态',{exact:true})).toBeVisible();
    await expect(view.locator('resource-investigation-links app-card')).toHaveCount(0);
    await expect(view.locator('.last-updated')).toContainText('非资源观测');
    const observed=await view.locator('.resource-meta').textContent();
    await view.getByRole('button',{name:'刷新',exact:true}).click();
    await expect(view.locator('.resource-meta')).toHaveText(observed!);
    for (const tab of ['概览','指标与趋势','日志']) {
      await view.getByRole('tab',{name:tab,exact:true}).click();
      if(tab==='指标与趋势') {
        await expect(view.locator('semantic-metrics').getByLabel('时间范围',{exact:true})).toBeVisible();
        await expect(view.locator('semantic-metrics')).toContainText('标准指标与能力');
        await expect(view.locator('semantic-metrics .window')).toBeVisible();
        for (const control of [view.locator('semantic-metrics').getByLabel('时间范围',{exact:true}), view.locator('semantic-metrics').getByLabel('指标',{exact:true}), view.locator('semantic-metrics').getByRole('button',{name:'刷新标准指标'})]) {
          const box=await control.boundingBox(); expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.x+box!.width).toBeLessThanOrEqual(width);
        }
        await view.locator('semantic-metrics').getByLabel('时间范围',{exact:true}).selectOption('6');
        await expect(view.locator('semantic-metrics .window')).toBeVisible();
      }
      if(tab==='日志') {
        await expect(view.locator('database-log-tab .message-cell').first()).toBeVisible();
        const logs=view.locator('database-log-tab');
        const firstBatch=await logs.locator('.message-cell').allTextContents();
        expect(firstBatch).toHaveLength(50);
        const firstIds=await logs.evaluate((el:any)=>el.logs.map((row:any)=>row.id));
        await logs.getByRole('button',{name:'下一页',exact:true}).click();
        await expect(logs.locator('.message-cell')).toHaveCount(5);
        const secondBatch=await logs.locator('.message-cell').allTextContents();
        expect(secondBatch.every(message=>!firstBatch.includes(message))).toBe(true);
        const secondIds=await logs.evaluate((el:any)=>el.logs.map((row:any)=>row.id));
        expect(secondIds.every((id:number)=>!firstIds.includes(id))).toBe(true);
        batches.push({width,theme,firstIds,secondIds,source:'real GET /api/logs offset 0 -> 50; persisted MySQL rows'});
        await page.screenshot({path:`${output}/database-logs-second-batch-${width}-${theme}.png`,fullPage:true});
        await expect(logs.locator('.pagination-info')).toHaveText('51 - 55 / 55');
        await logs.getByLabel('日志级别',{exact:true}).selectOption('warning');
        await expect(logs.locator('.message-cell')).toHaveCount(19);
        await expect(logs.getByRole('button',{name:'上一页',exact:true})).toHaveCount(0);
        await logs.getByLabel('日志级别',{exact:true}).selectOption('all');
        await expect(logs.locator('.message-cell')).toHaveCount(50);
        await logs.getByRole('button',{name:'下一页',exact:true}).click();
        await expect(logs.locator('.message-cell')).toHaveCount(5);
        await logs.getByLabel('日志时间范围',{exact:true}).selectOption('6h');
        await expect(logs.locator('.message-cell')).toHaveCount(50);
        await expect(logs.locator('.pagination-info')).toHaveText('1 - 50 / 55');
        await logs.getByLabel('本批日志关键字').fill('no-match');
        await expect(logs.getByRole('button',{name:'下一页',exact:true})).toBeVisible();
        await logs.getByLabel('本批日志关键字').fill('');
        await view.locator('database-log-tab .message-cell').first().focus();
        await page.keyboard.press('Enter');
        await expect(view.locator('database-log-tab .raw-content')).toContainText('END-OF-LOG');
      }
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
      await page.screenshot({path:`${output}/database-${tab}-${width}-${theme}-real-service.png`,fullPage:true,animations:'disabled'});
    }
  }
  expect(writes.filter(path => !['/api/platform/frontend-events','/api/device/register','/api/device/challenge','/api/user/preferences'].includes(path))).toEqual([]); expect(errors).toEqual([]);
  await writeFile(`${output}/database-real-service.json`,JSON.stringify({baseCommit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),widths:[1440,768,390],themes:['light','dark'],database:'task-owned MySQL 8.4, migration ledger, formal full Fastify server',data:'Persisted fixture inventory and 55 logs; real unconfigured semantic metrics. No live target collection; no product model calls.',reads,writes,errors,batches},null,2));
});

test('controlled overview states supplement real service and preserve investigation access',async({page})=>{
  test.setTimeout(100_000);
  await page.addInitScript(({token,permissions})=>{
    localStorage.setItem('token',token);localStorage.setItem('slide.control.session_token.v1',token);localStorage.setItem('permissions',JSON.stringify(permissions));
  },{token,permissions});
  let scenario='normal', release:(()=>void)|undefined;
  const item=()=>({resource:{type:'instance',id:instanceId},label:'受控状态',status:'healthy',quality:scenario==='partial'?'partial':'good',freshness:scenario==='stale'?'stale':scenario==='empty'?'missing':'fresh',observedAt:scenario==='empty'?null:new Date(Date.now()-(scenario==='stale'?600000:0)).toISOString(),unresolvedAlerts:scenario==='conflict'?2:0,relationCount:0,impactScope:[],gaps:scenario==='empty'?['OBSERVATIONS_EMPTY']:scenario==='stale'?['OBSERVATIONS_STALE']:[]});
  await page.route('**/api/resources/overview',async route=>{
    if(scenario==='loading') await new Promise<void>(resolve=>release=resolve);
    return route.fulfill(scenario==='failed'?{status:503,json:{error:'controlled'}}:scenario==='forbidden'?{status:403,json:{error:'controlled'}}:{json:{items:[item()],collectedAt:new Date().toISOString(),dataQuality:'complete'}});
  });
  await page.route('**/api/investigations?resource=instance:*',route=>route.fulfill({json:{items:[{id:'controlled-only',title:'订单延迟调查 · 长标题用于键盘与省略显示校验'}]}}));
  for(const width of [1440,768,390]) for(const theme of ['light','dark']) for(scenario of ['normal','empty','loading','failed','forbidden','partial','stale','conflict']) {
    await page.setViewportSize({width,height:1000});await page.goto(`${base}/instance-detail?id=${instanceId}`);
    await page.evaluate(theme=>document.documentElement.dataset.themeMode=theme,theme);
    const view=page.locator('instance-detail-page');
    if(scenario==='loading') await expect(view.getByText('正在读取资源状态与证据…',{exact:true})).toBeVisible();
    else if(['failed','forbidden'].includes(scenario)) await expect(view.locator('.overview-grid [role=alert]')).toContainText(scenario==='failed'?'失败':'无权');
    else await expect(view.getByRole('heading',{name:scenario==='normal'?'当前观测未提示运行异常':scenario==='conflict'?'存在需要核对的异常':'当前证据不足以判断运行状态',exact:true})).toBeVisible();
    const link=view.locator('resource-investigation-links').getByRole('link',{name:'订单延迟调查 · 长标题用于键盘与省略显示校验',exact:true});
    await expect(link).toBeVisible();await link.focus();await expect(link).toBeFocused();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await page.screenshot({path:`${output}/controlled-overview-${scenario}-${width}-${theme}.png`,fullPage:true,animations:'disabled'});
    if(scenario==='loading') { release?.(); release=undefined; }
  }
  await page.evaluate(()=>window.dispatchEvent(new CustomEvent('slide-permissions-loaded',{detail:{permissions:[]}})));
  await expect(page.locator('instance-detail-page')).toContainText('权限或登录状态已变更');
  await expect(page.locator('instance-detail-page .overview-grid')).toHaveCount(0);
  await page.screenshot({path:`${output}/controlled-permission-invalidation.png`,fullPage:true});
});

test('controlled metrics interactions and log context isolation',async({page})=>{
  test.setTimeout(100_000);
  await page.addInitScript(({token,permissions})=>{
    localStorage.setItem('token',token);localStorage.setItem('slide.control.session_token.v1',token);localStorage.setItem('permissions',JSON.stringify(permissions));
  },{token,permissions});
  const data={profile:{columns:[]},window:{from:'2026-10-15T00:00:00Z',to:'2026-10-15T01:00:00Z'},metrics:[
    {definition:{id:'db.uptime_seconds',category:'canonical',unit:'s',meaning:'受控交互证据，不代表目标采集'},state:'available',series:[{dimensions:{node:'controlled'},buckets:[1,2,3,2,4].map((value,index)=>({value:{encoding:'float64',value},unit:'s',coverage:1,quality:{status:'good',reason:'controlled'},freshness:index===2?'stale':'fresh',accuracy:'exact',observed_at:'2026-10-15T00:30:00Z',sources:[{id:'controlled-fixture'}],window:{from:`2026-10-15T00:0${index}:00Z`,to:`2026-10-15T00:0${index+1}:00Z`}}))}]},
    {definition:{id:'db.connections.active',category:'extension',unit:'count',meaning:'受控扩展'},state:'temporary_failure',series:[]}
  ]};
  let metricStatus=200;
  await page.route('**/api/metrics/query',route=>route.fulfill({status:metricStatus,json:metricStatus===200?data:{error:'controlled'}}));
  for(const width of [1440,768,390]) for(const theme of ['light','dark']) {
    await page.setViewportSize({width,height:1000});await page.goto(`${base}/instance-detail?id=${instanceId}`);
    await page.evaluate(theme=>document.documentElement.dataset.themeMode=theme,theme);
    await page.locator('instance-detail-page').getByRole('tab',{name:'指标与趋势',exact:true}).click();
    const metrics=page.locator('semantic-metrics');
    await expect(metrics.locator('.current')).toHaveCount(2);
    await expect(metrics.locator('.trend-grid metric-chart')).toHaveCount(1);
    expect(await metrics.locator('.trend-grid metric-chart').evaluate((el:any)=>el.series[0].data)).toEqual([1,2,null,2,4]);
    await page.screenshot({path:`${output}/controlled-metrics-summary-${width}-${theme}.png`,fullPage:true});
    await metrics.getByLabel('指标',{exact:true}).selectOption('db.uptime_seconds');await expect(metrics.locator('.current')).toHaveCount(1);
    const raw=metrics.locator('summary').filter({hasText:'查看原始时间桶'}).first();await raw.focus();await page.keyboard.press('Enter');
    await expect(metrics.locator('app-data-table').first()).toBeVisible();
    await metrics.getByText('指标定义',{exact:true}).first().focus();await page.keyboard.press('Enter');
    await expect(metrics.getByText('受控交互证据，不代表目标采集',{exact:true})).toBeVisible();
    for(const control of [metrics.getByLabel('时间范围',{exact:true}),metrics.getByLabel('指标',{exact:true}),metrics.getByRole('button',{name:'刷新标准指标'})]) {
      const box=await control.boundingBox();expect(box!.x).toBeGreaterThanOrEqual(0);expect(box!.x+box!.width).toBeLessThanOrEqual(width);
    }
    await page.screenshot({path:`${output}/controlled-metrics-${width}-${theme}.png`,fullPage:true});
  }
  const metrics=page.locator('semantic-metrics');metricStatus=503;await metrics.getByRole('button',{name:'刷新标准指标'}).click();await expect(metrics.getByRole('alert')).toContainText('不能据此判断健康');
  metricStatus=403;await metrics.getByRole('button',{name:'刷新标准指标'}).click();await expect(metrics.locator('.current')).toHaveCount(0);
  await expect(metrics.getByRole('alert')).toContainText('权限');
  await page.locator('instance-detail-page').getByRole('tab',{name:'日志',exact:true}).click();
  const logs=page.locator('database-log-tab');await expect(logs.locator('.message-cell')).toHaveCount(50);
  let release!:()=>void;
  await page.route('**/api/logs?**',async route=>{
    await new Promise<void>(resolve=>release=resolve);
    await route.fulfill({json:{logs:[{id:99999,message:'LATE-OLD-RESOURCE',collected_at:new Date().toISOString(),log_level:'info',source:'other'}],total:1}});
  });
  await logs.getByRole('button',{name:'下一页',exact:true}).click();
  await expect(logs.getByRole('status')).toContainText('加载');
  await logs.evaluate((el:any)=>el.instanceId=999999);await expect(logs.locator('.message-cell')).toHaveCount(0);
  await page.evaluate(()=>window.dispatchEvent(new CustomEvent('slide-session-expired')));release?.();
  await expect(page.locator('body')).not.toContainText('LATE-OLD-RESOURCE');
  await writeFile(`${output}/controlled-interactions.json`,JSON.stringify({source:'Explicit route interception, separate from normal-service evidence',coverage:['metrics filter/keyboard/details/chart gap','metrics failure/403','log pending + object change + session invalidation'],head:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim()},null,2));
});


test('server and network real service inventory, semantic tabs, interfaces and permission clearing',async({page})=>{
  test.setTimeout(100_000);
  await page.addInitScript(({token,permissions})=>{
    localStorage.setItem('token',token);localStorage.setItem('slide.control.session_token.v1',token);localStorage.setItem('permissions',JSON.stringify(permissions));
  },{token,permissions});
  const reads:{path:string;status:number}[]=[], writes:string[]=[], errors:string[]=[];
  const diagnosticRequests: string[] = [];
  // A fresh API process has no diagnostic cache. Block any regression before SSH,
  // and fail on the request itself; no unsupported-OS response is used as proof.
  await page.route('**/api/servers/*/diagnostics**', route => {
    diagnosticRequests.push(route.request().url()); return route.abort();
  });
  await page.route('**/api/servers/*/collect-diagnostics', route => {
    diagnosticRequests.push(route.request().url()); return route.abort();
  });
  page.on('response',r=>{const path=new URL(r.url()).pathname;if(path.startsWith('/api/')) reads.push({path,status:r.status()});});
  page.on('request',r=>{if(['POST','PUT','DELETE'].includes(r.method())&&!r.url().includes('/metrics/query')) writes.push(new URL(r.url()).pathname);});
  page.on('pageerror',e=>errors.push(e.message));
  for(const width of [1440,768,390]) for(const theme of ['light','dark']) {
    await page.setViewportSize({width,height:1000});
    await page.goto(`${base}/server-detail?id=${serverId}`);await page.evaluate(theme=>document.documentElement.dataset.themeMode=theme,theme);
    const server=page.locator('server-detail');await expect(server.getByText('当前需要关注',{exact:true})).toBeVisible();await expect(server.locator('semantic-metrics')).toHaveCount(0);
    await expect(server.locator('.resource-meta')).toContainText('观测于');
    for(const tab of ['概览','指标与趋势','日志']) {
      await server.getByRole('tab',{name:tab,exact:true}).click();
      if(tab==='指标与趋势') await expect(server.locator('semantic-metrics .window')).toBeVisible();
      if(tab==='日志') {
        await expect(server).toContainText('当前页面尚未取得诊断证据');
        await server.getByRole('button',{name:'刷新',exact:true}).click();
        await expect(server.getByRole('button',{name:'刷新',exact:true})).toBeEnabled();
        await expect(server).toContainText('当前页面尚未取得诊断证据');
        expect(diagnosticRequests).toEqual([]);
      }
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
      await page.screenshot({path:`${output}/server-${tab}-${width}-${theme}-real-service.png`,fullPage:true});
    }
    for (const tab of ['诊断','网络','进程','服务','日志']) {
      await server.getByRole('tab',{name:tab,exact:true}).click();
      await expect(server).toContainText('当前页面尚未取得诊断证据');
    }
    await server.evaluate((el:any,id)=>el.serverId=id,serverSwitchId);
    await expect(server.locator('.server-title')).toContainText('MAX-175 切换服务器');
    await expect(server).toContainText('当前页面尚未取得诊断证据');
    expect(diagnosticRequests).toEqual([]);
    await page.goto(`${base}/network-device-detail?networkDeviceId=${networkId}`);await page.evaluate(theme=>document.documentElement.dataset.themeMode=theme,theme);
    const network=page.locator('network-device-detail');await expect(network.getByText('当前需要关注',{exact:true})).toBeVisible();await expect(network.locator('semantic-metrics')).toHaveCount(0);
    for(const tab of ['概览','指标与趋势','接口','配置备份']) {
      await network.getByRole('tab',{name:tab,exact:true}).click();
      if(tab==='指标与趋势') await expect(network.locator('semantic-metrics .window')).toBeVisible();
      if(tab==='接口') {
        await expect(network.getByText('GigabitEthernet0/0/1',{exact:true})).toBeVisible();await expect(network.locator('semantic-metrics')).toHaveCount(0);
        await network.getByLabel('接口运行状态',{exact:true}).selectOption('down');await expect(network.getByText('GigabitEthernet0/0/1',{exact:true})).toHaveCount(0);await expect(network.getByText('GigabitEthernet0/0/2',{exact:true})).toBeVisible();
        await network.getByLabel('接口运行状态',{exact:true}).selectOption('');await network.getByLabel('接口名称或别名',{exact:true}).fill('0/0/1');await expect(network.getByText('GigabitEthernet0/0/2',{exact:true})).toHaveCount(0);
        await network.getByLabel('接口名称或别名',{exact:true}).fill('');
        if(width===390) {
          const region=network.getByRole('region',{name:'接口列表，可横向滚动'});await region.focus();await page.keyboard.press('ArrowRight');await expect.poll(()=>region.evaluate(el=>el.scrollLeft)).toBeGreaterThan(0);
          await region.evaluate(el=>el.scrollLeft=0);
        }
      }
      if(tab==='配置备份') await expect(network.getByText('尚未配置 SSH 凭据',{exact:false})).toBeVisible();
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
      for(const control of [network.getByRole('button',{name:'立即备份',exact:true}),network.getByRole('button',{name:'刷新',exact:true}),network.locator('.page > app-card').first()].filter(Boolean)) {
        if(await control.count()) {const box=await control.boundingBox();expect(box!.x).toBeGreaterThanOrEqual(0);expect(box!.x+box!.width).toBeLessThanOrEqual(width);}
      }
      await page.screenshot({path:`${output}/network-${tab}-${width}-${theme}-real-service.png`,fullPage:true});
    }
  }
  await page.evaluate(()=>window.dispatchEvent(new CustomEvent('slide-permissions-loaded',{detail:{permissions:[]}})));await expect(page.locator('network-device-detail')).toContainText('权限或登录状态已变更');await expect(page.locator('network-device-detail .overview-grid')).toHaveCount(0);
  expect(writes.filter(path=>!['/api/platform/frontend-events','/api/device/register','/api/device/challenge','/api/user/preferences'].includes(path))).toEqual([]);expect(errors).toEqual([]);
  expect(reads.filter(row=>row.path.startsWith(`/api/network-devices/${networkId}/interfaces`)).every(row=>row.status===200)).toBe(true);
  await writeFile(`${output}/infrastructure-real-service.json`,JSON.stringify({head:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),data:'Formal full API + isolated MySQL persisted inventory and interfaces. Scheduled collection disabled, no live SSH/SNMP target; supported rhel OS, fresh API process with no diagnostics cache, zero diagnostic GET or collection POST across entry/tabs/refresh/object switch; request trap blocks a regression before SSH. Semantic metrics unconfigured. Not live target acceptance.',reads,writes,errors,diagnosticRequests},null,2));
});

test('controlled log and interface exceptional states remain explicit',async({page})=>{
  test.setTimeout(120_000);
  await page.addInitScript(({token,permissions})=>{
    localStorage.setItem('token',token);localStorage.setItem('slide.control.session_token.v1',token);localStorage.setItem('permissions',JSON.stringify(permissions));
  },{token,permissions});
  let state='empty', release:(()=>void)|undefined;
  await page.route('**/api/logs?**',async route=>{
    if(state==='loading') await new Promise<void>(resolve=>release=resolve);
    await route.fulfill({status:state==='failed'?503:state==='forbidden'?403:200,json:{logs:[],total:0}});
  });
  await page.route('**/api/network-devices/*/interfaces',async route=>{
    if(state==='loading') await new Promise<void>(resolve=>release=resolve);
    await route.fulfill({status:state==='failed'?503:state==='forbidden'?403:200,json:{interfaces:[]}});
  });
  for(const width of [1440,768,390]) for(const theme of ['light','dark']) for(state of ['empty','loading','failed','forbidden']) {
    for(const kind of ['logs','interfaces']) {
      await page.setViewportSize({width,height:1000});
      await page.goto(kind==='logs'?`${base}/instance-detail?id=${instanceId}`:`${base}/network-device-detail?networkDeviceId=${networkId}`);
      await page.evaluate(theme=>document.documentElement.dataset.themeMode=theme,theme);
      const view=page.locator(kind==='logs'?'instance-detail-page':'network-device-detail');
      await view.getByRole('tab',{name:kind==='logs'?'日志':'接口',exact:true}).click();
      const section=kind==='logs'?view.locator('database-log-tab'):view;
      await expect(section).toContainText(state==='loading'?(kind==='logs'?'加载日志':'读取接口'):state==='empty'?(kind==='logs'?'当前范围没有日志':'尚未取得接口记录'):state==='forbidden'?(kind==='logs'?'权限或登录状态':'没有访问此资源的权限'):(kind==='logs'?'日志读取失败':'接口读取失败'));
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
      await page.screenshot({path:`${output}/controlled-${kind}-${state}-${width}-${theme}.png`,fullPage:true});
      if(state==='loading') {release?.();release=undefined;}
    }
  }
});

// Optional measurement run, using the same isolated formal API fixture above.
// No HTTP interception, live-target collection, model calls or shared environment.
test('MAX-175 performance: cold and warm authenticated resource journeys', async ({ browser }) => {
  test.skip(process.env.MAX175_PERFORMANCE !== '1', 'Explicit performance run only');
  test.setTimeout(240_000);
  const { cpus, totalmem, platform, release, arch } = await import('node:os');
  const samples: Array<{ mode: string; kind: string; iteration: number; operation: string; ms: number }> = [];
  const responses: Array<{ path: string; status: number }> = [], errors: string[] = [];
  const dimensions: Record<string, unknown> = {};
  const sourceHead = execFileSync('git', ['rev-parse', 'HEAD'], {encoding:'utf8'}).trim();
  const journeys = [
    {kind:'database',path:`/instance-detail?id=${instanceId}`,tag:'instance-detail-page'},
    {kind:'server',path:`/server-detail?id=${serverId}`,tag:'server-detail'},
    {kind:'network',path:`/network-device-detail?networkDeviceId=${networkId}`,tag:'network-device-detail'},
  ];
  for (const mode of ['cold-browser', 'warm-browser']) for (const journey of journeys) {
    let context: Awaited<ReturnType<typeof browser.newContext>> | undefined;
    try {
      for (let iteration=0; iteration<(mode==='cold-browser'?5:10); iteration++) {
        if (!context || mode==='cold-browser') {
          await context?.close();
          context = await browser.newContext({viewport:{width:1440,height:1000},locale:'zh-CN',colorScheme:'light'});
          await context.addInitScript(({token,permissions})=>{
            localStorage.setItem('token',token);localStorage.setItem('slide.control.session_token.v1',token);
            localStorage.setItem('permissions',JSON.stringify(permissions));localStorage.setItem('slide.i18n.locale','zh-CN');
          },{token,permissions});
        }
        const page = await context.newPage();
        page.on('pageerror',error=>errors.push(error.message));
        page.on('response',response=>{
          const path=new URL(response.url()).pathname;
          if (path.startsWith('/api/')) responses.push({path,status:response.status()});
        });
        const cdp=await context.newCDPSession(page);
        await cdp.send('Network.enable');
        await cdp.send('Network.setCacheDisabled',{cacheDisabled:mode==='cold-browser'});
        const view=page.locator(journey.tag);
        const painted=()=>page.evaluate(()=>new Promise<void>(done=>requestAnimationFrame(()=>requestAnimationFrame(()=>done()))));
        const measure=async(operation:string,action:()=>Promise<unknown>)=>{
          const start=performance.now(); await action(); await painted();
          samples.push({mode,kind:journey.kind,iteration,operation,ms:performance.now()-start});
        };
        await measure('page-load',async()=>{
          await page.goto(`${base}${journey.path}`,{waitUntil:'domcontentloaded'});
          await view.getByText('当前需要关注',{exact:true}).waitFor();
        });
        await measure('tab-to-metrics',async()=>{
          await view.getByRole('tab',{name:'指标与趋势',exact:true}).click();
          await view.locator('semantic-metrics .window').waitFor();
        });
        const metrics=view.locator('semantic-metrics');
        dimensions[journey.kind]=await metrics.evaluate((el:any)=>({metrics:el.result.metrics.length,series:el.result.metrics.reduce((n:number,m:any)=>n+m.series.length,0),states:[...new Set(el.result.metrics.map((m:any)=>m.state))]}));
        for (const hours of ['6','1']) await measure('metric-range-filter',async()=>{
          const response=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/metrics/query' && r.request().method()==='POST');
          await metrics.getByLabel('时间范围',{exact:true}).selectOption(hours);
          expect((await response).status()).toBe(200);
          await page.waitForFunction(()=>{
            const el:any=document.querySelector('app-root')?.shadowRoot?.querySelector('semantic-metrics');
            // Lit views and app shell use varying light/shadow boundaries. Search below instead.
            const find=(root:Document|ShadowRoot|Element):any=>{
              for(const node of root.querySelectorAll('*')) {
                if(node.localName==='semantic-metrics') return node;
                if(node.shadowRoot) {const found=find(node.shadowRoot);if(found) return found;}
              }
            };
            const target=el??find(document);return target?.result && !target.busy;
          },{},{polling:'raf'});
        });
        const raw=metrics.locator('summary').filter({hasText:'查看原始时间桶'}).first();
        await measure('metric-details',async()=>{await raw.click();await metrics.locator('app-data-table').first().waitFor();});
        if (iteration===0 && mode==='warm-browser') await writeFile(`${output}/ax-${journey.kind}-metrics.yml`,await view.ariaSnapshot());
        if(journey.kind==='database') {
          const logs=view.locator('database-log-tab');
          await measure('tab-to-logs',async()=>{await view.getByRole('tab',{name:'日志',exact:true}).click();await logs.locator('.message-cell').first().waitFor();});
          await expect(logs.locator('.message-cell')).toHaveCount(50);
          const ids=await logs.evaluate((el:any)=>el.logs.map((row:any)=>row.id));
          await measure('logs-next-page',async()=>{await logs.getByRole('button',{name:'下一页',exact:true}).click();await page.waitForFunction(()=>{
            const find=(root:Document|ShadowRoot|Element):any=>{for(const node of root.querySelectorAll('*')) {if(node.localName==='database-log-tab')return node;if(node.shadowRoot){const found=find(node.shadowRoot);if(found)return found;}}};
            return find(document)?.logs.length===5;
          },{},{polling:'raf'});});
          const nextIds=await logs.evaluate((el:any)=>el.logs.map((row:any)=>row.id));
          expect(nextIds.every((id:number)=>!ids.includes(id))).toBe(true);
          await measure('logs-level-filter',async()=>{await logs.getByLabel('日志级别',{exact:true}).selectOption('warning');await expect(logs.locator('.message-cell')).toHaveCount(19);});
          await measure('logs-text-filter',async()=>{await logs.getByLabel('本批日志关键字').fill('事件 1 ·');await expect(logs.locator('.message-cell')).toHaveCount(1);});
          await measure('logs-fulltext',async()=>{await logs.locator('.message-cell').first().press('Enter');await logs.locator('.raw-content').waitFor();});
          await expect(logs.locator('.message-cell').first()).toBeFocused();
          if(iteration===0 && mode==='warm-browser') await writeFile(`${output}/ax-database-logs.yml`,await view.ariaSnapshot());
        } else if(journey.kind==='network') {
          await measure('tab-to-interfaces',async()=>{await view.getByRole('tab',{name:'接口',exact:true}).click();await view.getByText('GigabitEthernet0/0/1',{exact:true}).waitFor();});
          await measure('interface-status-filter',async()=>{await view.getByLabel('接口运行状态',{exact:true}).selectOption('down');await expect(view.getByText('GigabitEthernet0/0/1',{exact:true})).toHaveCount(0);});
          await view.getByLabel('接口运行状态',{exact:true}).selectOption('');
          await measure('interface-name-filter',async()=>{await view.getByLabel('接口名称或别名',{exact:true}).fill('0/0/1');await expect(view.getByText('GigabitEthernet0/0/2',{exact:true})).toHaveCount(0);});
          if(iteration===0 && mode==='warm-browser') await writeFile(`${output}/ax-network-interfaces.yml`,await view.ariaSnapshot());
        } else {
          await measure('tab-to-server-logs',async()=>{await view.getByRole('tab',{name:'日志',exact:true}).click();await view.getByText('当前页面尚未取得诊断证据',{exact:false}).waitFor();});
        }
        await measure('tab-to-overview',async()=>{await view.getByRole('tab',{name:'概览',exact:true}).click();await view.getByText('当前需要关注',{exact:true}).waitFor();});
        await page.close();
      }
    } finally { await context?.close(); }
  }
  const groups=[...new Set(samples.map(s=>`${s.mode}/${s.kind}/${s.operation}`))].map(key=>{
    const values=samples.filter(s=>`${s.mode}/${s.kind}/${s.operation}`===key).map(s=>s.ms).sort((a,b)=>a-b);
    const percentile=(p:number)=>values[Math.max(0,Math.ceil(values.length*p)-1)];
    return {key,n:values.length,min:values[0],p50:percentile(.5),p95:percentile(.95),max:values.at(-1)};
  });
  await writeFile(`${output}/performance.json`,JSON.stringify({sourceHead,browser:browser.version(),environment:{platform:platform(),release:release(),arch:arch(),cpu:cpus()[0]?.model,cpuCount:cpus().length,memoryBytes:totalmem(),viewport:'1440x1000',server:'Vite development + complete formal Fastify/JWT/MySQL 8.4, loopback, no CPU/network throttling'},method:'Sequential single-user browser journeys. Cold = new context + browser HTTP cache disabled; backend/DB/OS remain warm. Warm = reused context per resource, first iteration retained. Times include Playwright actionability/polling and two requestAnimationFrame callbacks; not INP, Web Vitals, load capacity or production SLA. No before/after baseline or acceptance threshold.',data:{logs:55,logBatchSize:50,warningLogs:19,interfaces:2,dimensions,source:'Task-owned persisted inventory/log fixtures via real APIs; metrics unconfigured; server diagnostics absent. No live collection, response interception or product model.'},samples,groups,responses,errors},null,2));
  expect(errors).toEqual([]);
  expect(responses.filter(r=>/\/diagnostics|\/collect-diagnostics/.test(r.path))).toEqual([]);
  expect(responses.filter(r=>r.path==='/api/metrics/query' || r.path==='/api/logs' || r.path.endsWith('/interfaces')).every(r=>r.status===200)).toBe(true);
});
