import { test, expect, type Page } from '@playwright/test';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { createServer as createNetServer } from 'node:net';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { mkdir, writeFile, open } from 'node:fs/promises';

// Full production API, SQL, JWT, WS and app shell. Only business rows/special
// failures are controlled; no provider, SSH/SNMP or shared deployment is used.
test.describe.configure({ mode:'serial' });
const require = createRequire(resolve('../apps/db-ops-api/package.json'));
const mysql = require('mysql2/promise'), bcrypt = require('bcrypt');
const output = process.env.MAX187_OUTPUT_DIR ?? '/Users/max/Coding/40-Slide/outputs/MAX-187';
const base = 'http://127.0.0.1:5187', api = 'http://127.0.0.1:3187';
const schema = `db_ops_ai_qualification_max187_${process.pid}`;
let container = '', pool: any, token = '', permissions: string[] = [], ownerId = 0, instanceId = 0;
const password = randomBytes(24).toString('hex');
const processes: ChildProcess[] = [], evidence: any[] = [];
const prefsKey = 'slide.control.settings.v1:default';
test.skip(process.env.MAX187_ISOLATED !== '1', 'Explicit opt-in: owns ephemeral MySQL and ports 3187/5187/29887');
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
  await expect(page.locator('dashboard-page [role="tab"][aria-selected="true"]')).toBeVisible();
  await expect(page.locator('dashboard-page .inventory-empty')).toBeVisible();
}
async function accent(page: Page) {
  return page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim());
}
async function change(page: Page, detail: Record<string, unknown>) {
  const saved = page.waitForResponse(r => r.url().endsWith('/api/user/preferences') && r.request().method() === 'PUT');
  await page.evaluate(detail => window.dispatchEvent(new CustomEvent('slide-settings-change', { detail })), detail);
  expect((await saved).ok()).toBe(true);
}
async function shot(page: Page, name: string) {
  evidence.push({ name, commit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),
    ...await page.evaluate(() => ({ width:innerWidth,height:innerHeight,theme:document.documentElement.dataset.themeMode,
      accent:getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
      overflow:document.documentElement.scrollWidth > innerWidth })) });
  await page.screenshot({ path:`${output}/${name}.png`,fullPage:true,animations:'disabled' });
}
test.beforeAll(async () => {
  test.setTimeout(180_000); await mkdir(output,{recursive:true});
  for (const port of [3187,5187,29887]) await new Promise<void>((done,reject)=> {
    const server=createNetServer();server.once('error',reject);server.listen(port,'127.0.0.1',()=>server.close(()=>done()));
  });
  container = execFileSync('docker',['run','-d','--name',`slide-max187-${process.pid}`,'--label','slide.task=MAX-187','-e','MYSQL_ALLOW_EMPTY_PASSWORD=yes','-p','127.0.0.1::3306','mysql:8.4'],{encoding:'utf8'}).trim();
  const info=JSON.parse(execFileSync('docker',['inspect',container],{encoding:'utf8'}))[0];
  const mysqlPort = Number(info.NetworkSettings.Ports['3306/tcp'][0].HostPort);
  await expect.poll(async () => { try {const c=await mysql.createConnection({host:'127.0.0.1',port:mysqlPort,user:'root',connectTimeout:500});await c.end();return true;}catch{return false;} },{timeout:120_000}).toBe(true);
  const env={...process.env,DB_HOST:'127.0.0.1',DB_PORT:String(mysqlPort),DB_USER:'root',DB_PASSWORD:'',DB_NAME:schema,
    JWT_SECRET_KEY:randomBytes(32).toString('hex'),ENCRYPTION_KEY:randomBytes(32).toString('hex'),PORT:'3187',AGENT_WS_PORT:'29887',
    SLIDE_MEMORY_PIPELINE_ENABLED:'false',METRICS_V2_COLLECTION_ENABLED:'false'};
  await writeFile(`${output}/migration.log`,execFileSync(process.execPath,['--import','tsx','init-db.ts'],{cwd:resolve('../apps/db-ops-api'),env,encoding:'utf8',timeout:90_000}));
  pool=mysql.createPool({host:'127.0.0.1',port:mysqlPort,user:'root',database:schema,timezone:'Z'});
  await pool.query('UPDATE llm_providers SET enabled=0');
  await pool.query("UPDATE users SET password_hash=?,status='active' WHERE username='admin'",[await bcrypt.hash(password,10)]);
  await pool.query("INSERT IGNORE INTO user_roles(user_id,role_id) SELECT u.id,r.id FROM users u JOIN roles r ON r.name='admin' WHERE u.username='admin'");
  ownerId=(await pool.query("SELECT id FROM users WHERE username='admin'"))[0][0].id;
  const a=await launch(['--import','tsx','server.ts'],resolve('../apps/db-ops-api'),env,'api.log');await ready(`${api}/api/health/ready`,a);
  const v=await launch([resolve('node_modules/vite/bin/vite.js'),'--host','127.0.0.1','--port','5187','--strictPort'],resolve('.'),{...env,VITE_API_PROXY_TARGET:api,VITE_AGENT_WS_PROXY_TARGET:'http://127.0.0.1:29887'},'vite.log');await ready(base,v);
  const response=await fetch(`${api}/api/auth/login`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'admin',password})});expect(response.ok).toBe(true);token=(await response.json()).token;
  permissions=await request('/api/auth/permissions');

});
test.afterAll(async () => {
  const agentRunCount=pool ? Number((await pool.query('SELECT COUNT(*) AS n FROM agent_runs'))[0][0].n) : null;
  for (const child of [...processes].reverse()) if(child.exitCode===null) {
    child.kill('SIGTERM');await new Promise<void>(done=>{child.once('exit',()=>done());setTimeout(()=>{if(child.exitCode===null)child.kill('SIGKILL');done();},5000).unref();});
  }
  await pool?.end();
  if(container) { const info=JSON.parse(execFileSync('docker',['inspect',container],{encoding:'utf8'}))[0];expect(info.Config.Labels['slide.task']).toBe('MAX-187');execFileSync('docker',['rm','-f',container]); }
  if (agentRunCount !== null) expect(agentRunCount).toBe(0);
  await writeFile(`${output}/measurements.json`,JSON.stringify(evidence,null,2));
  await writeFile(`${output}/cleanup.json`,JSON.stringify({containerRemoved:!!container,processes:processes.map(c=>({pid:c.pid,exit:c.exitCode,signal:c.signalCode})),agentRunCount,productModelCalls:0},null,2));
});

async function colors(page: Page, selector: string) {
  return page.locator(selector).first().evaluate(element => {
    const style=getComputedStyle(element);
    const rgb=(value: string) => {
      const canvas=document.createElement('canvas');canvas.width=canvas.height=1;
      const context=canvas.getContext('2d')!;context.fillStyle=value;context.fillRect(0,0,1,1);
      return [...context.getImageData(0,0,1,1).data].slice(0,3);
    };
    const luminance=(color: number[]) => color.map(value=>{value/=255;return value<=0.04045?value/12.92:((value+0.055)/1.055)**2.4;})
      .reduce((sum,value,index)=>sum+value*[0.2126,0.7152,0.0722][index],0);
    // Composite translucent surfaces through shadow hosts onto their real ancestors.
    const canvas=document.createElement('canvas');canvas.width=canvas.height=1;
    const context=canvas.getContext('2d')!;context.fillStyle='#fff';context.fillRect(0,0,1,1);
    const ancestors: Element[]=[];
    for(let node: Element|null=element;node;node=node.parentElement ?? (node.getRootNode() as ShadowRoot).host ?? null) ancestors.unshift(node);
    for(const node of ancestors) {context.fillStyle=getComputedStyle(node).backgroundColor;context.fillRect(0,0,1,1);}
    const color=rgb(style.color),background=[...context.getImageData(0,0,1,1).data].slice(0,3);
    return {text:element.textContent?.trim(),color,background,fontWeight:style.fontWeight,
      contrast:(Math.max(luminance(color),luminance(background))+0.05)/(Math.min(luminance(color),luminance(background))+0.05),
      outline:style.outlineStyle,boxShadow:style.boxShadow};
  });
}

test('no saved preferences: actual defaults, navigation, active tabs, primary contrast and themes',async({page})=>{
  expect((await request('/api/user/preferences')).preferences).toBeNull();
  await login(page,{themeMode:'light',locale:'zh-CN'});
  const snapshot=page.waitForResponse(r=>r.url().endsWith('/api/resources/overview'));
  await page.goto(`${base}/dashboard?scope=instance`);expect((await snapshot).ok()).toBe(true);await loaded(page);
  await expect.poll(()=>accent(page)).toBe('#265f99');
  expect((await colors(page,'.nav-item--active .nav-item__text')).color).toEqual([38,95,153]);
  expect((await colors(page,'dashboard-page [aria-selected="true"]')).color).toEqual([38,95,153]);
  for(const themeMode of ['light','dark']) {
    await change(page,{themeMode});
    await expect.poll(()=>page.evaluate(()=>document.documentElement.dataset.themeMode)).toBe(themeMode);
    const primary=await colors(page,'dashboard-page .btn-primary');
    expect(primary.background).toEqual([38,95,153]);expect(primary.color).toEqual([255,255,255]);expect(primary.contrast).toBeGreaterThan(4.5);
    if(themeMode==='dark') await expect.poll(async()=>(await colors(page,'dashboard-page [aria-selected="true"]')).color).toEqual([125,159,194]);
    const active=await colors(page,'dashboard-page [aria-selected="true"]');
    expect(active.contrast).toBeGreaterThan(4.5);
    await page.locator('dashboard-page [aria-selected="true"]').focus();
    expect((await colors(page,'dashboard-page [aria-selected="true"]')).outline).toBe('solid');
    await page.locator('dashboard-page .btn-primary').hover();
    evidence.push({name:`${themeMode}-controls`,primary,active,hover:await colors(page,'dashboard-page .btn-primary')});
    for(const width of [1440,390]) {await page.setViewportSize({width,height:900});await shot(page,`empty-${themeMode}-${width}`);}
    await page.setViewportSize({width:1440,height:900});
  }
  await change(page,{themeMode:'light'});await page.reload();await loaded(page);expect(await accent(page)).toBe('#265f99');
});

test('real overview rows: 600-weight active navigation and 400-weight ordinary evidence link share the same blue',async({page})=>{
  const [result]=await pool.query("INSERT INTO database_instances(name,db_type,host,port,username,password_encrypted,status) VALUES (?,'mysql','max187.invalid',3306,'unused','unused','inactive')",['MAX-187 隔离颜色验收库']);
  instanceId=result.insertId;
  await prefs({accentColor:'#265f99',themeMode:'light'});await login(page);await page.goto(`${base}/dashboard`);
  await expect(page.locator('dashboard-page .risk-row')).toHaveCount(1);
  // MAX-186 keeps observation/relations behind an explicit disclosure.
  await page.locator('dashboard-page .risk-observation summary').click();
  await page.locator('dashboard-page .relation-select').click();
  const selector='dashboard-page #risk-relations a';await expect(page.locator(selector)).toBeVisible();
  const active=await colors(page,'.nav-item--active .nav-item__text'),ordinary=await colors(page,selector);
  expect(active.fontWeight).toBe('600');expect(ordinary.fontWeight).toBe('400');
  expect(active.color).toEqual([38,95,153]);expect(ordinary.color).toEqual(active.color);
  await page.locator(selector).hover();expect((await colors(page,selector)).color).toEqual(active.color);
  evidence.push({name:'real-overview-text',source:'isolated MySQL row → real overview API → rendered UI',active,ordinary});
  const evidenceAction=await colors(page,'dashboard-page .risk-next');
  expect(evidenceAction.color).toEqual(active.color);
  const refresh=page.locator('dashboard-page .btn-refresh');
  await page.mouse.move(0,0);
  await expect(refresh).toHaveCSS('background-color','rgba(0, 0, 0, 0)');
  await expect(refresh).toHaveCSS('border-color','rgba(0, 0, 0, 0)');
  await page.keyboard.press('Tab');await refresh.focus();
  await expect(refresh).toBeFocused();expect((await colors(page,'dashboard-page .btn-refresh')).outline).toBe('solid');
  const reread=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/resources/overview');
  await refresh.press('Enter');expect((await reread).ok()).toBe(true);await expect(refresh).toBeEnabled();
  evidence.push({name:'integrated-overview-actions',evidenceAction,refresh:await colors(page,'dashboard-page .btn-refresh')});
  await page.mouse.move(0,0);await shot(page,'real-overview-light-1440');
  for(const width of [1440,390]) for(const themeMode of ['light','dark']) {
    await change(page,{themeMode});await page.setViewportSize({width,height:900});
    await page.goto(`${base}/investigations`);
    const create=page.getByRole('button',{name:'创建手动调查',exact:true});await expect(create).toBeVisible();
    const primary=await colors(page,'investigations-page .workspace-header .btn-primary');
    expect(primary.background).toEqual([38,95,153]);expect(primary.color).toEqual([255,255,255]);expect(primary.contrast).toBeGreaterThan(4.5);
    await create.click();await expect(page.getByRole('dialog',{name:'创建手动调查',exact:true})).toBeVisible();
    await page.keyboard.press('Escape');await expect(create).toBeFocused();
    evidence.push({name:'integrated-investigation-action',width,themeMode,primary});await shot(page,`investigation-${themeMode}-${width}`);
  }
  await pool.query('DELETE FROM database_instances WHERE id=?',[instanceId]);
});

test('explicit old blue, default UI choice, other tab, persistence, fresh login and custom color',async({page,context,browser})=>{
  await prefs({accentColor:'#409eff',themeMode:'light',locale:'zh-CN'});
  await login(page);await page.goto(`${base}/settings/platform/appearance`);
  await expect.poll(()=>accent(page)).toBe('#409eff');
  const other=await context.newPage();await other.goto(`${base}/dashboard?scope=instance`);await loaded(other);
  await page.getByRole('button',{name:/默认蓝|Default blue/i}).click();
  await expect.poll(()=>accent(other)).toBe('#265f99');
  await expect.poll(async()=>(await request('/api/user/preferences')).preferences.accentColor).toBe('#265f99');
  await other.reload();await loaded(other);expect(await accent(other)).toBe('#265f99');
  // A new browser context uses the real login form, without injecting a token.
  const fresh=await browser.newPage();await fresh.goto(`${base}/dashboard?scope=instance`);
  await fresh.locator('.login-gate input[type="text"]').fill('admin');
  await fresh.locator('.login-gate input[type="password"]').fill(password);
  await fresh.locator('.login-gate button[type="submit"]').click();await loaded(fresh);
  await expect.poll(()=>accent(fresh)).toBe('#265f99');
  await shot(fresh,'fresh-login-default');await fresh.close();
  await page.locator('appearance-settings input[type="color"]').first().fill('#14b8a6');
  await expect.poll(()=>accent(other)).toBe('#14b8a6');
  await expect.poll(async()=>(await request('/api/user/preferences')).preferences.accentColor).toBe('#14b8a6');
  await other.reload();await loaded(other);expect(await accent(other)).toBe('#14b8a6');
  await expect.poll(async()=>(await colors(other,'dashboard-page .btn-primary')).color).toEqual([255,255,255]);
  const customPrimary=await colors(other,'dashboard-page .btn-primary');expect(customPrimary.color).toEqual([255,255,255]);expect(customPrimary.contrast).toBeGreaterThan(4.5);
  evidence.push({name:'custom-color',customPrimary});await shot(other,'custom-light');
  await change(page,{btnPalette:{primaryBg:'#123456',primaryColor:'#ffffff',primaryBorder:'#123456'}});
  await expect.poll(async()=>(await colors(other,'dashboard-page .btn-primary')).background).toEqual([18,52,86]);
  await page.getByRole('button',{name:/默认蓝|Default blue/i}).click();await expect.poll(()=>accent(other)).toBe('#265f99');
  expect((await colors(other,'dashboard-page .btn-primary')).background).toEqual([18,52,86]);
  await other.reload();await loaded(other);
  expect((await colors(other,'dashboard-page .btn-primary')).background).toEqual([18,52,86]);
  evidence.push({name:'explicit-palette-retained',primary:await colors(other,'dashboard-page .btn-primary')});
  await change(page,{btnPalette:{}});await other.close();
});
