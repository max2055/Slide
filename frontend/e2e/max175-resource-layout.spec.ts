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
const base = `http://127.0.0.1:${frontendPort}`;
test.skip(process.env.MAX175_ISOLATED_MYSQL !== '1', 'Requires MAX-175 task-owned MySQL and exclusive task ports');
const processes: ChildProcess[] = [];
let pool: any, token: string, permissions: string[], password = randomBytes(24).toString('hex');
let instanceId: number;
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
  const env = { ...process.env, DB_HOST:'127.0.0.1', DB_PORT:'33175', DB_USER:'root', DB_PASSWORD:'', DB_NAME:`db_ops_ai_qualification_max175_${process.pid}`,
    JWT_SECRET_KEY:randomBytes(32).toString('hex'), ENCRYPTION_KEY:randomBytes(32).toString('hex'),
    PORT:String(apiPort), AGENT_WS_PORT:'29775', SLIDE_MEMORY_PIPELINE_ENABLED:'false' };
  const migration = execFileSync(process.execPath, ['--import','tsx','init-db.ts'], { cwd:resolve('../apps/db-ops-api'), env, encoding:'utf8' });
  await writeFile(`${output}/migration.log`, migration);
  pool = mysql.createPool({ host:env.DB_HOST, port:Number(env.DB_PORT), user:env.DB_USER, password:env.DB_PASSWORD, database:env.DB_NAME, timezone:'Z' });
  await pool.query('UPDATE llm_providers SET enabled=0');
  await pool.query("UPDATE users SET password_hash=?,status='active' WHERE username='admin'", [await bcrypt.hash(password, 10)]);
  await pool.query("INSERT IGNORE INTO user_roles(user_id,role_id) SELECT u.id,r.id FROM users u JOIN roles r ON r.name='admin' WHERE u.username='admin'");
  const [insert] = await pool.query("INSERT INTO database_instances(name,db_type,host,port,username,password_encrypted,environment,status,health_status) VALUES ('MAX-175 订单数据库 · 隔离服务测试资源','mysql','127.0.0.1',33175,'root',?,'testing','inactive','unknown')", [encryptData('unused-isolated-target',env.ENCRYPTION_KEY)]);
  instanceId = insert.insertId;
  for (let i=0;i<55;i++) await pool.query("INSERT INTO database_logs(instance_id,log_level,source,message,raw_content,collected_at) VALUES (?,?,'mysql_error',?,?,DATE_SUB(NOW(),INTERVAL ? SECOND))", [instanceId,i%3?'info':'warning',`事件 ${i+1} · 持久化日志测试记录`,`完整事件 ${i+1}\n${'Long_SQL_context_'.repeat(24)}\nEND-OF-LOG-${i+1}`,i]);
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
});

test('database representative: real routes, reading times, metrics and log browsing', async ({ page }) => {
  test.setTimeout(100_000);
  const reads: {path:string;status:number}[] = [], writes: string[] = [], errors: string[] = [];
  page.on('response', response => { if(new URL(response.url()).pathname.startsWith('/api/')) reads.push({path:new URL(response.url()).pathname,status:response.status()}); });
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.method()==='POST' && !request.url().includes('/metrics-v2/query') && !request.url().includes('/auth/')) writes.push(new URL(request.url()).pathname); });
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
        await logs.getByRole('button',{name:'下一页',exact:true}).click();
        await expect(logs.locator('.message-cell')).toHaveCount(5);
        const secondBatch=await logs.locator('.message-cell').allTextContents();
        expect(secondBatch.every(message=>!firstBatch.includes(message))).toBe(true);
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
  expect(writes.filter(path => !['/api/platform/frontend-events','/api/device/register','/api/device/challenge'].includes(path))).toEqual([]); expect(errors).toEqual([]);
  await writeFile(`${output}/database-real-service.json`,JSON.stringify({baseCommit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),widths:[1440,768,390],themes:['light','dark'],database:'task-owned MySQL 8.4, migration ledger, formal full Fastify server',data:'Persisted fixture inventory and 55 logs; real unconfigured semantic metrics. No live target collection; no product model calls.',reads,writes,errors},null,2));
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
  await page.evaluate(()=>window.dispatchEvent(new CustomEvent('slide-permissions-loaded')));
  await expect(page.locator('instance-detail-page')).toContainText('权限或登录状态已变更');
  await expect(page.locator('instance-detail-page .overview-grid')).toHaveCount(0);
  await page.screenshot({path:`${output}/controlled-permission-invalidation.png`,fullPage:true});
});
