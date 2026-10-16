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
const output = process.env.MAX186_OUTPUT_DIR ?? 'test-results/max186-service';
const apiPort = 3186, frontendPort = 5188;
const taskSchema = `db_ops_ai_qualification_max186_${process.pid}`;
const base = `http://127.0.0.1:${frontendPort}`;
test.skip(process.env.MAX186_ISOLATED_MYSQL !== '1', 'Requires task-owned isolated MySQL on 33186');
const processes: ChildProcess[] = [];
let pool: any, token: string, permissions: string[], password = randomBytes(24).toString('hex');
let serverId: number;
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
  if (process.env.MAX186_ISOLATED_MYSQL !== '1') throw new Error('Requires task-owned MySQL at 127.0.0.1:33186; never point at shared DB');
  await mkdir(output, { recursive: true });
  const env = { ...process.env, DB_HOST:'127.0.0.1', DB_PORT:'33186', DB_USER:'root', DB_PASSWORD:'', DB_NAME:taskSchema,
    JWT_SECRET_KEY:randomBytes(32).toString('hex'), ENCRYPTION_KEY:randomBytes(32).toString('hex'),
    PORT:String(apiPort), AGENT_WS_PORT:'29886', SLIDE_MEMORY_PIPELINE_ENABLED:'false', METRICS_V2_COLLECTION_ENABLED:'false' };
  const migration = execFileSync(process.execPath, ['--import','tsx','init-db.ts'], { cwd:resolve('../apps/db-ops-api'), env, encoding:'utf8', timeout:90_000 });
  await writeFile(`${output}/migration.log`, migration);
  pool = mysql.createPool({ host:env.DB_HOST, port:Number(env.DB_PORT), user:env.DB_USER, password:env.DB_PASSWORD, database:env.DB_NAME, timezone:'Z' });
  await pool.query('UPDATE llm_providers SET enabled=0');
  await pool.query("UPDATE users SET password_hash=?,status='active' WHERE username='admin'", [await bcrypt.hash(password, 10)]);
  await pool.query("INSERT IGNORE INTO user_roles(user_id,role_id) SELECT u.id,r.id FROM users u JOIN roles r ON r.name='admin' WHERE u.username='admin'");
  await pool.query("INSERT INTO database_instances(name,db_type,host,port,username,password_encrypted,environment,status,health_status) VALUES ('MAX-186 订单数据库 · 隔离服务测试资源','mysql','127.0.0.1',33186,'root',?,'testing','inactive','unknown')", [encryptData('unused-isolated-target',env.ENCRYPTION_KEY)]);

  const [server] = await pool.query("INSERT INTO servers(host,port,label,os_type,credential_type,credential_encrypted,status,collection_enabled) VALUES ('max186-no-target.invalid',22,'MAX-186 隔离服务器 · 长名称与未知状态验收','rhel','password',?,'offline',0)",[encryptData(JSON.stringify({username:'unused',password:'unused'}),env.ENCRYPTION_KEY)]);
  serverId = server.insertId;
  await pool.query("INSERT INTO servers(host,port,label,os_type,credential_type,credential_encrypted,status,collection_enabled) VALUES ('max186-second-no-target.invalid',22,'MAX-186 切换服务器','rhel','password',?,'offline',0)",[encryptData(JSON.stringify({username:'unused',password:'unused'}),env.ENCRYPTION_KEY)]);
  await pool.query("INSERT INTO network_devices(name,label,host,vendor,collection_enabled,status) VALUES ('max186-network','MAX-186 隔离网络设备','max186-network.invalid','huawei',0,'unknown')");
  const api = await launch(['--import','tsx','server.ts'], resolve('../apps/db-ops-api'), env, 'api.log');
  await ready(`http://127.0.0.1:${apiPort}/api/health/ready`, api);
  const vite = await launch([resolve('node_modules/vite/bin/vite.js'),'--host','127.0.0.1','--port',String(frontendPort),'--strictPort'], resolve('.'), { ...env,VITE_API_PROXY_TARGET:`http://127.0.0.1:${apiPort}`,VITE_AGENT_WS_PROXY_TARGET:'http://127.0.0.1:29886' }, 'vite.log');
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
  if (process.env.MAX186_ISOLATED_MYSQL === '1') {
    const cleanup = await mysql.createConnection({host:'127.0.0.1',port:33186,user:'root',connectTimeout:5000});
    try {
      await cleanup.query(`DROP DATABASE IF EXISTS \`${taskSchema}\``);
      const [remaining] = await cleanup.query('SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=?',[taskSchema]);
      expect(remaining).toHaveLength(0);
      await writeFile(`${output}/cleanup-fixture.json`,JSON.stringify({schema:taskSchema,remaining,processes:processes.map(child=>({pid:child.pid,exitCode:child.exitCode,signal:child.signalCode}))},null,2));
    }
    finally { await cleanup.end(); }
  }
});


test('persisted inventory → overview → evidence → return, real HTTP/JWT/SQL without model calls', async ({ page }) => {
  const reads: {path:string;status:number}[] = [], writes: string[] = [];
  page.on('response', response => { const path = new URL(response.url()).pathname; if(path.startsWith('/api/')) reads.push({path,status:response.status()}); });
  page.on('request', request => { if (request.method() === 'POST') writes.push(new URL(request.url()).pathname); });
  await page.addInitScript(({ token, permissions }) => {
    localStorage.setItem('token',token); localStorage.setItem('slide.control.session_token.v1',token);
    localStorage.setItem('permissions',JSON.stringify(permissions)); localStorage.setItem('slide.i18n.locale','zh-CN');
    localStorage.setItem('slide.control.settings.v1:default',JSON.stringify({locale:'zh-CN',theme:'claw',themeMode:'light',fontDensity:'standard'}));
  }, {token,permissions});
  const responsePromise = page.waitForResponse(r=>new URL(r.url()).pathname==='/api/resources/overview');
  await page.goto(base+'/dashboard'); const response=await responsePromise; expect(response.ok()).toBe(true);
  const snapshot=await response.json(); expect(snapshot.items.length).toBeGreaterThanOrEqual(4);
  const view=page.locator('dashboard-page'); await expect(view.locator('stat-card')).toHaveCount(4);
  for (const width of [1280,1440,768,390]) for (const mode of ['light','dark']) {
    await page.setViewportSize({width,height:width===1280?720:900});
    await page.evaluate(mode=>document.documentElement.dataset.themeMode=mode,mode);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await page.screenshot({path:`${output}/overview-${width}-${mode}.png`,animations:'disabled'});
  }
  await page.setViewportSize({width:1440,height:900});
  await view.getByRole('searchbox').fill('长名称'); await expect(view.locator('app-data-table tbody tr')).toHaveCount(1);
  await page.reload(); await expect(view.getByRole('searchbox')).toHaveValue('长名称');
  const notes=view.locator('.risk-row summary').first(); await notes.focus(); await page.keyboard.press('Enter');
  await expect(view.locator('.risk-row time').first()).toBeVisible();
  await view.locator('.risk-row .risk-next').first().click();
  await expect(page).toHaveURL(new RegExp(`resourceType=server&resourceId=${serverId}`));
  const diagnosis=page.locator('resource-diagnosis-page'); await expect(diagnosis.getByRole('combobox',{name:'资源',exact:true})).toHaveValue(`server:${serverId}`);
  await expect(diagnosis.locator('[data-kind="facts"]')).toBeVisible();
  await diagnosis.getByRole('link',{name:'返回原运维总览'}).click();
  await expect(view.getByRole('searchbox')).toHaveValue('长名称');
  expect(writes.filter(path=>path.includes('diagnos'))).toEqual([]);
  await writeFile(`${output}/service-evidence.json`,JSON.stringify({commit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),source:'task-owned isolated MySQL + complete formal Fastify routes + real password login/JWT; persisted synthetic inventory, no target collection or provider calls',snapshot:{collectedAt:snapshot.collectedAt,items:snapshot.items.map((i:any)=>({resource:i.resource,status:i.status,freshness:i.freshness,gaps:i.gaps}))},reads,writes},null,2));
});
