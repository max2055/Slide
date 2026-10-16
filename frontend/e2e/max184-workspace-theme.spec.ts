import { test, expect, type Page } from '@playwright/test';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { createServer as createNetServer } from 'node:net';
import { createRequire } from 'node:module';
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { mkdir, writeFile, open } from 'node:fs/promises';
import { createServer, type ViteDevServer } from 'vite';

// Full production API, SQL, JWT, WS and app shell. Only business rows/special
// failures are controlled; no provider, SSH/SNMP or shared deployment is used.
test.describe.configure({ mode:'serial' });
const require = createRequire(resolve('../apps/db-ops-api/package.json'));
const mysql = require('mysql2/promise'), bcrypt = require('bcrypt');
const output = process.env.MAX184_OUTPUT_DIR ?? '/Users/max/Coding/40-Slide/outputs/MAX-184';
const base = 'http://127.0.0.1:5184', api = 'http://127.0.0.1:3184';
const schema = `db_ops_ai_qualification_max184_${process.pid}`;
let container = '', pool: any, token = '', permissions: string[] = [], ownerId = 0, instanceId = 0;
let prototype: ViteDevServer, prototypeUrl = '';
const password = randomBytes(24).toString('hex');
const processes: ChildProcess[] = [], evidence: any[] = [];
const ids: string[] = [];
const prefsKey = 'slide.control.settings.v1:default';
test.skip(process.env.MAX184_ISOLATED !== '1', 'Explicit opt-in: owns ephemeral MySQL and ports 3184/5184/29884');
async function ready(url: string, child: ChildProcess) {
  await expect.poll(async () => { if (child.exitCode !== null) throw Error('Task service exited; inspect task logs');
    try { return (await fetch(url)).ok; } catch { return false; }
  }, { timeout: 90_000 }).toBe(true);
}
async function launch(args: string[], cwd: string, env: NodeJS.ProcessEnv, log: string) {
  const file = await open(`${output}/${log}`, 'w');
  const child = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', file.fd, file.fd] });
  processes.push(child); await file.close(); return child;
}
async function request(path: string, data?: unknown, method = data === undefined ? 'GET' : 'PUT') {
  const r = await fetch(api + path, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  expect(r.ok, `${method} ${path}: ${r.status}`).toBe(true); return r.json();
}
async function prefs(data: Record<string, unknown>) { await request('/api/user/preferences', { preferences: data }); }
async function login(page: Page, settings: Record<string, unknown> = {}) {
  await page.addInitScript(({ token, permissions, ownerId, settings, prefsKey }) => {
    if (!localStorage.getItem('token')) {
      localStorage.setItem('token', token); localStorage.setItem('user', JSON.stringify({ id:ownerId, username:'admin' }));
      localStorage.setItem('permissions', JSON.stringify(permissions));
      if (Object.keys(settings).length) localStorage.setItem(prefsKey, JSON.stringify(settings));
    }
  }, { token, permissions, ownerId, settings, prefsKey });
}
async function loaded(page: Page) {
  await expect(page.locator('.workspace-list-count')).toContainText(/项可访问调查|项匹配调查/);
}
async function shot(page: Page, name: string) {
  const m = await page.evaluate(() => {
    const root = getComputedStyle(document.documentElement), page = document.querySelector('investigations-page');
    const style = (e: Element | null) => e ? { fontSize:getComputedStyle(e).fontSize,fontWeight:getComputedStyle(e).fontWeight } : null;
    return { width:innerWidth,height:innerHeight,theme:document.documentElement.dataset.themeMode,density:document.documentElement.dataset.density,
      accent:root.getPropertyValue('--accent').trim(),overflow:document.documentElement.scrollWidth > innerWidth,
      toolbarHeight:page?.querySelector('.workspace-filter-common')?.getBoundingClientRect().height,
      title:style(page?.querySelector('h1') ?? null),hero:style(page?.querySelector('h2') ?? null),
      inputBackground:page?.querySelector('input') ? getComputedStyle(page.querySelector('input')!).backgroundColor : null,
      breadcrumb:document.querySelector('.dashboard-header__breadcrumb-current')?.textContent?.trim() };
  });
  evidence.push({ name,...m }); expect(m.overflow, name).toBe(false);
  await page.screenshot({ path:`${output}/${name}.png`,fullPage:true,animations:'disabled' });
}
test.beforeAll(async () => {
  test.setTimeout(180_000); await mkdir(output,{recursive:true});
  for (const port of [3184,5184,29884]) await new Promise<void>((done,reject)=> {
    const server=createNetServer();server.once('error',reject);server.listen(port,'127.0.0.1',()=>server.close(()=>done()));
  });
  container = execFileSync('docker',['run','-d','--name',`slide-max184-${process.pid}`,'--label','slide.task=MAX-184','-e','MYSQL_ALLOW_EMPTY_PASSWORD=yes','-p','127.0.0.1::3306','mysql:8.4'],{encoding:'utf8'}).trim();
  const info=JSON.parse(execFileSync('docker',['inspect',container],{encoding:'utf8'}))[0];
  const mysqlPort = Number(info.NetworkSettings.Ports['3306/tcp'][0].HostPort);
  await expect.poll(async () => { try {const c=await mysql.createConnection({host:'127.0.0.1',port:mysqlPort,user:'root',connectTimeout:500});await c.end();return true;}catch{return false;} },{timeout:120_000}).toBe(true);
  const env={...process.env,DB_HOST:'127.0.0.1',DB_PORT:String(mysqlPort),DB_USER:'root',DB_PASSWORD:'',DB_NAME:schema,
    JWT_SECRET_KEY:randomBytes(32).toString('hex'),ENCRYPTION_KEY:randomBytes(32).toString('hex'),PORT:'3184',AGENT_WS_PORT:'29884',
    SLIDE_MEMORY_PIPELINE_ENABLED:'false',METRICS_V2_COLLECTION_ENABLED:'false'};
  await writeFile(`${output}/migration.log`,execFileSync(process.execPath,['--import','tsx','init-db.ts'],{cwd:resolve('../apps/db-ops-api'),env,encoding:'utf8',timeout:90_000}));
  pool=mysql.createPool({host:'127.0.0.1',port:mysqlPort,user:'root',database:schema,timezone:'Z'});
  await pool.query('UPDATE llm_providers SET enabled=0');
  await pool.query("UPDATE users SET password_hash=?,status='active' WHERE username='admin'",[await bcrypt.hash(password,10)]);
  await pool.query("INSERT IGNORE INTO user_roles(user_id,role_id) SELECT u.id,r.id FROM users u JOIN roles r ON r.name='admin' WHERE u.username='admin'");
  ownerId=(await pool.query("SELECT id FROM users WHERE username='admin'"))[0][0].id;
  const a=await launch(['--import','tsx','server.ts'],resolve('../apps/db-ops-api'),env,'api.log');await ready(`${api}/api/health/ready`,a);
  const v=await launch([resolve('node_modules/vite/bin/vite.js'),'--host','127.0.0.1','--port','5184','--strictPort'],resolve('.'),{...env,VITE_API_PROXY_TARGET:api,VITE_AGENT_WS_PROXY_TARGET:'http://127.0.0.1:29884'},'vite.log');await ready(base,v);
  const response=await fetch(`${api}/api/auth/login`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'admin',password})});expect(response.ok).toBe(true);token=(await response.json()).token;
  permissions=await request('/api/auth/permissions');
  const prototypeRoot=process.env.MAX184_PROTOTYPE_ROOT;
  if (!prototypeRoot) throw Error('MAX184_PROTOTYPE_ROOT must point to verified R1.1 site');
  prototype=await createServer({root:prototypeRoot,configFile:false,server:{host:'127.0.0.1',port:0}});await prototype.listen();prototypeUrl=prototype.resolvedUrls!.local[0];
});
test.afterAll(async () => {
  const agentRunCount=pool ? Number((await pool.query('SELECT COUNT(*) AS n FROM agent_runs'))[0][0].n) : null;
  await prototype?.close();
  for (const child of [...processes].reverse()) if(child.exitCode===null) {
    child.kill('SIGTERM');await new Promise<void>(done=>{child.once('exit',()=>done());setTimeout(()=>{if(child.exitCode===null)child.kill('SIGKILL');done();},5000).unref();});
  }
  await pool?.end();
  if(container) { const info=JSON.parse(execFileSync('docker',['inspect',container],{encoding:'utf8'}))[0];expect(info.Config.Labels['slide.task']).toBe('MAX-184');execFileSync('docker',['rm','-f',container]); }
  if (agentRunCount !== null) expect(agentRunCount).toBe(0);
  await writeFile(`${output}/measurements.json`,JSON.stringify(evidence,null,2));
  await writeFile(`${output}/cleanup.json`,JSON.stringify({containerRemoved:!!container,processes:processes.map(c=>({pid:c.pid,exit:c.exitCode,signal:c.signalCode})),agentRunCount,productModelCalls:0},null,2));
});

test('representative: real-service first use and R1.1 same viewport/theme comparison',async({page,browser})=>{
  expect((await request('/api/user/preferences')).preferences).toBeNull();
  await login(page,{locale:'zh-CN',themeMode:'light'});await page.goto(`${base}/investigations`);await loaded(page);
  await expect(page.getByRole('heading',{name:'让资源证据，汇成可追溯的调查。'})).toBeVisible();
  await expect(page.getByLabel('Profile 筛选',{exact:true})).toBeHidden();
  const proto=await browser.newPage();await proto.goto(`${prototypeUrl}#workspace`);
  for (const width of [1280,1440,768,390]) {
    await page.setViewportSize({width,height:900});await proto.setViewportSize({width,height:900});
    await shot(page,`start-light-${width}`);await proto.screenshot({path:`${output}/prototype-start-light-${width}.png`,fullPage:true,animations:'disabled'});
  }
  await proto.close();
});

test('persisted lists: common/advanced filters, collapse, reset, URL, resource names and keyboard',async({page})=>{
  const [result]=await pool.query("INSERT INTO database_instances(name,db_type,host,port,username,password_encrypted,status) VALUES (?,'mysql','max184.invalid',3306,'unused','unused','inactive')",['隔离订单库 · '+ '长资源名称'.repeat(14)]);instanceId=result.insertId;
  for(const [title,profile,state] of [['订单接口延迟上升 · 持久化测试记录','ops','open'],['平台调查 · 长标题'.repeat(10),'system','waiting']] as const) {
    const id=randomUUID(),session=randomUUID();ids.push(id);
    await pool.query('INSERT INTO chat_sessions(session_id,user_id,title) VALUES (?,?,?)',[session,ownerId,title]);
    await pool.query('INSERT INTO investigations(id,title,goal,profile_id,profile_version,session_id,owner_kind,owner_id,scope_version,lifecycle) VALUES (?,?,?,?,1,?,\'user\',?,?,?)',[id,title,'隔离持久化记录；未运行模型，业务问题待核对。',profile,session,ownerId,'a'.repeat(64),state]);
    if(profile==='ops')await pool.query("INSERT INTO investigation_resources(investigation_id,resource_type,resource_id,role) VALUES (?,'instance',?,'primary')",[id,instanceId]);
  }
  await login(page);await page.goto(`${base}/investigations`);await loaded(page);
  await expect(page.locator('.investigation-list button')).toHaveCount(2);
  const search=page.getByRole('textbox',{name:'搜索调查',exact:true});await search.fill('订单');await search.press('Enter');
  await expect(page.locator('.investigation-list button')).toHaveCount(1);expect(new URL(page.url()).searchParams.get('query')).toBe('订单');
  await page.getByRole('button',{name:'清除筛选'}).click();await page.getByLabel('调查状态',{exact:true}).selectOption('waiting');await expect(page.locator('.investigation-list button')).toHaveCount(1);
  await page.getByRole('button',{name:'清除筛选'}).click();
  const advanced=page.getByRole('button',{name:'高级筛选',exact:true});await advanced.focus();await page.keyboard.press('Enter');
  await expect(advanced).toHaveAttribute('aria-expanded','true');
  await page.getByLabel('Profile 筛选',{exact:true}).selectOption('ops');await expect(page.locator('.investigation-list button')).toHaveCount(1);
  await page.getByRole('button',{name:/高级筛选 · 1/}).click();await expect(page.getByLabel('Profile 筛选',{exact:true})).toBeHidden();
  await page.reload();await expect(page.getByLabel('Profile 筛选',{exact:true})).toBeVisible();await loaded(page);
  await page.getByRole('button',{name:'清除筛选'}).click();await expect(page.getByLabel('Profile 筛选',{exact:true})).toHaveValue('');
  await expect(page.locator('investigation-resource-picker')).toContainText('隔离订单库');
  await page.getByLabel('搜索资源',{exact:true}).fill('隔离订单库');
  await page.getByLabel('筛选资源类型',{exact:true}).selectOption('instance');
  await page.getByRole('checkbox',{name:/隔离订单库/}).check();await loaded(page);
  await expect(page.locator('.investigation-list button')).toHaveCount(1);
  expect(new URL(page.url()).searchParams.getAll('resource')).toEqual([`instance:${instanceId}`]);
  await page.setViewportSize({width:390,height:900});await shot(page,'advanced-long-resource-390');
  await page.setViewportSize({width:1280,height:900});await page.getByRole('button',{name:'清除筛选'}).click();await loaded(page);
  await page.getByLabel('资源筛选',{exact:true}).fill(`instance:${instanceId}`);await page.getByRole('button',{name:'筛选',exact:true}).click();await expect(page.locator('.investigation-list button')).toHaveCount(1);
  await page.getByRole('button',{name:/高级筛选/}).click();await shot(page,'list-filtered-light-1280');
  await page.getByRole('button',{name:'清除筛选'}).click();await loaded(page);await search.fill('MAX184没有这项调查');await search.press('Enter');await expect(page.getByText('暂无匹配调查',{exact:true})).toBeVisible();await shot(page,'no-results-light');
  await page.getByRole('button',{name:'清除筛选'}).click();await page.locator('.investigation-list button').filter({hasText:'订单接口'}).click();await expect(page.locator('.workspace-main')).toContainText('尚未执行');
  await expect(page.locator('.workspace-main')).toContainText('未确认');
  for (const width of [1280,1440,768,390]) {await page.setViewportSize({width,height:900});await shot(page,`detail-light-${width}`);}
  for (const state of ['partial','unknown']) {
    // Explicit presentation-only injection; no execution or health fact is fabricated.
    await page.evaluate(state=>{const p=document.querySelector('investigations-page') as any;p.controller.detail.derivedRunState=state;p.requestUpdate();},state);
    await expect(page.locator('.investigation-states')).toContainText(state==='partial'?'部分完成':'结果未知');await shot(page,`controlled-detail-${state}`);
  }
  await page.getByRole('button',{name:'创建手动调查'}).click();await expect(page.getByRole('dialog',{name:'创建手动调查'})).toBeVisible();await page.keyboard.press('Escape');await expect(page.getByRole('button',{name:'创建手动调查'})).toBeFocused();
});

test('server/local defaults, custom colors, multi-tab propagation, refresh and login',async({page,context,browser})=>{
  await prefs({accentColor:'#6366f1',themeMode:'light',fontDensity:'standard'});
  await login(page,{accentColor:'#409eff',locale:'zh-CN'});await page.goto(`${base}/investigations`);await loaded(page);
  await expect.poll(()=>page.evaluate(()=>getComputedStyle(document.documentElement).getPropertyValue('--accent').trim())).toBe('#6366f1');
  // User changes the existing appearance UI; other tabs must update without refresh.
  const other=await context.newPage();
  const bootstrapped=other.waitForResponse(r=>r.url().endsWith('/api/user/preferences') && r.request().method()==='PUT');
  await other.goto(`${base}/investigations`);await loaded(other);await bootstrapped;
  let otherPreferenceWrites=0;other.on('request',r=>{if(r.url().endsWith('/api/user/preferences')&&r.method()==='PUT')otherPreferenceWrites++;});
  await page.goto(`${base}/settings/platform/appearance`);
  const blue=page.getByRole('button',{name:/默认蓝|Default blue/i});await expect(blue).toBeVisible();await blue.click();
  await expect.poll(()=>other.evaluate(()=>getComputedStyle(document.documentElement).getPropertyValue('--accent').trim())).toBe('#409eff');
  expect(otherPreferenceWrites).toBe(0);
  await expect.poll(async()=>(await request('/api/user/preferences')).preferences.accentColor).toBe('#409eff');
  await other.reload();await loaded(other);expect(await other.evaluate(()=>getComputedStyle(document.documentElement).getPropertyValue('--accent').trim())).toBe('#409eff');
  // Fresh browser session authenticates through the production login endpoint.
  const response=await fetch(`${api}/api/auth/login`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'admin',password})});expect(response.ok).toBe(true);
  const fresh=await browser.newPage();await login(fresh);await fresh.goto(`${base}/investigations`);await loaded(fresh);
  await expect.poll(()=>fresh.evaluate(()=>getComputedStyle(document.documentElement).getPropertyValue('--accent').trim())).toBe('#409eff');await fresh.close();
  const custom='#14b8a6';await prefs({accentColor:custom});await other.reload();await loaded(other);
  await expect.poll(()=>other.evaluate(()=>getComputedStyle(document.documentElement).getPropertyValue('--accent').trim())).toBe(custom);
  await shot(other,'custom-theme');await other.close();await prefs({accentColor:'#409eff'});
});

test('theme/density compatibility and controlled loading/failure/denied states',async({page,browser})=>{
  await prefs({accentColor:'#409eff',themeMode:'light',fontDensity:'standard'});await login(page);
  for(const themeMode of ['light','dark'])for(const fontDensity of ['compact','standard','comfortable']) {
    await prefs({themeMode,fontDensity});await page.goto(`${base}/investigations`);await loaded(page);
    await expect.poll(()=>page.evaluate(()=>document.documentElement.dataset.themeMode)).toBe(themeMode);
    await expect.poll(()=>page.evaluate(()=>document.documentElement.dataset.density)).toBe(fontDensity);
    for(const width of [1280,1440,768,390]) {await page.setViewportSize({width,height:900});await shot(page,`list-${themeMode}-${fontDensity}-${width}`);}
  }
  await prefs({themeMode:'light',fontDensity:'standard'});
  let release!:()=>void;const hold=new Promise<void>(r=>release=r);
  await page.route('**/api/investigations?*',async route=>{await hold;await route.continue();});
  await page.goto(`${base}/investigations`);await expect(page.locator('.workspace-list-count')).toContainText('正在加载');await shot(page,'controlled-loading');release();await loaded(page);await page.unroute('**/api/investigations?*');
  await page.route('**/api/investigations?*',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'CONTROLLED_STORAGE_UNAVAILABLE'})}));
  await page.reload();await expect(page.locator('.workspace-error')).toBeVisible();await shot(page,'controlled-failure');await page.unroute('**/api/investigations?*');
  await page.getByRole('button',{name:'重试读取'}).click();await loaded(page);
  const denied=await browser.newPage();await login(denied);await denied.goto(`${base}/investigations`);await loaded(denied);
  await denied.evaluate(()=>window.dispatchEvent(new CustomEvent('slide-permissions-loaded',{detail:{permissions:[]}})));
  await expect(denied.locator('investigations-page')).toContainText('无访问权限');await expect(denied.getByRole('button',{name:'创建手动调查'})).toHaveCount(0);await shot(denied,'controlled-permission-withdrawal');await denied.close();
  await pool.query("INSERT INTO users(username,password_hash,status) VALUES ('max184-denied',?,'active')",[await bcrypt.hash(password,10)]);
  const deniedLogin=await fetch(`${api}/api/auth/login`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'max184-denied',password})});
  expect(deniedLogin.ok).toBe(true);const deniedToken=(await deniedLogin.json()).token;
  const deniedRead=await fetch(`${api}/api/investigations`,{headers:{authorization:`Bearer ${deniedToken}`}});
  expect(deniedRead.status).toBe(200);expect((await deniedRead.json()).items).toEqual([]);
  const deniedDetail=await fetch(`${api}/api/investigations/${ids[0]}`,{headers:{authorization:`Bearer ${deniedToken}`}});
  expect(deniedDetail.status).toBe(404);evidence.push({name:'formal-no-role-permission',source:'real login, JWT and live SQL authority',listItems:0,maskedDetailStatus:deniedDetail.status});
  for (const themeMode of ['light','dark']) {
    // Apply a user setting through the existing app path and await persistence;
    // do not race an external preference PUT with this page's pending saves.
    const saved=page.waitForResponse(r=>r.url().endsWith('/api/user/preferences')&&r.request().method()==='PUT');
    await page.evaluate(themeMode=>{const app=document.querySelector('slide-app') as any;app.applySettings({...app.settings,themeMode});},themeMode);
    await saved;expect((await request('/api/user/preferences')).preferences.themeMode).toBe(themeMode);
    await page.emulateMedia({colorScheme:themeMode==='light'?'dark':'light'});
    await expect.poll(()=>page.evaluate(()=>document.documentElement.dataset.themeMode)).toBe(themeMode);
    for(const path of ['/instances-db','/settings/platform/appearance','/settings/ai/models']) {
      await page.goto(base+path);
      await expect.poll(()=>page.evaluate(()=>document.documentElement.dataset.themeMode)).toBe(themeMode);
      for(const width of [1280,390]) {
        await page.setViewportSize({width,height:900});
        await shot(page,`${path.includes('appearance')?'appearance':path.includes('models')?'models':'resources'}-regression-${themeMode}-${width}`);
      }
    }
  }
});

test('breadcrumb: delayed Chinese load, same-route switches, appearance UI and refresh',async({page})=>{
  await prefs({locale:'zh-CN',accentColor:'#409eff',themeMode:'light',fontDensity:'standard'});
  await login(page,{locale:'zh-CN'});
  let release!:()=>void, delayedLoads=0;
  const hold=new Promise<void>(resolve=>release=resolve);
  await page.route('**/src/app/i18n/locales/zh-CN.ts*',async route=>{delayedLoads++;await hold;await route.continue();});
  try {
    await page.goto(`${base}/investigations`,{waitUntil:'domcontentloaded'});
    const breadcrumb=page.locator('.dashboard-header__breadcrumb-current');
    await expect(breadcrumb).toHaveText('AI Workspace');
    await expect.poll(()=>delayedLoads).toBeGreaterThan(0);
    await page.evaluate(()=>{(window as any).__max184Header=document.querySelector('dashboard-header');});
    release();
    await expect(breadcrumb).toHaveText('AI 工作空间');await loaded(page);
    await expect(page.locator('investigations-page h1')).toHaveText('AI 工作空间');
    for(const width of [1280,390]) {await page.setViewportSize({width,height:900});await shot(page,`breadcrumb-async-zh-${width}`);}
    await page.setViewportSize({width:1280,height:900});
    // The existing settings event path changes language without replacing the
    // route or header. No DOM text or component property is patched by the test.
    for(const [locale,label] of [['en','AI Workspace'],['zh-CN','AI 工作空间']] as const) {
      const saved=page.waitForResponse(r=>r.url().endsWith('/api/user/preferences')&&r.request().method()==='PUT');
      await page.evaluate(locale=>window.dispatchEvent(new CustomEvent('slide-settings-change',{detail:{locale}})),locale);
      await saved;await expect(breadcrumb).toHaveText(label);
      await expect(page.locator('investigations-page h1')).toHaveText('AI 工作空间');
      expect(new URL(page.url()).pathname).toBe('/investigations');
      expect(await page.evaluate(()=>(window as any).__max184Header===document.querySelector('dashboard-header'))).toBe(true);
      await shot(page,`breadcrumb-same-route-${locale}`);
    }
    await page.unroute('**/src/app/i18n/locales/zh-CN.ts*');
    await page.reload();await loaded(page);await expect(breadcrumb).toHaveText('AI 工作空间');
    await shot(page,'breadcrumb-refresh-zh-1280');
    await page.goto(`${base}/settings/platform/appearance`);
    const language=page.locator('appearance-settings app-select-field').first().locator('select');
    const saved=page.waitForResponse(r=>r.url().endsWith('/api/user/preferences')&&r.request().method()==='PUT');
    await language.selectOption('en');await saved;
    await expect(breadcrumb).toHaveText('Settings');
    expect((await request('/api/user/preferences')).preferences.locale).toBe('en');
    await page.goto(`${base}/investigations`);await loaded(page);await expect(breadcrumb).toHaveText('AI Workspace');
    await page.reload();await loaded(page);await expect(breadcrumb).toHaveText('AI Workspace');
    await expect(page.locator('investigations-page h1')).toHaveText('AI 工作空间');
    await shot(page,'breadcrumb-refresh-en-1280');
  } finally {release();}
});
