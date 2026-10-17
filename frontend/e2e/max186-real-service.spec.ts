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

test('button consistency across formal resource and governance pages', async ({ page }) => {
  test.setTimeout(240_000);
  await page.addInitScript(({ token, permissions }) => {
    localStorage.setItem('token', token); localStorage.setItem('permissions', JSON.stringify(permissions));
    localStorage.setItem('slide.i18n.locale', 'zh-CN');
  }, { token, permissions });
  const measurements: unknown[] = [];
  const paths = [
    ['dashboard', 'dashboard-page'], ['instances-db', 'instances-page'], ['servers', 'servers-page'],
    ['network-devices', 'network-devices-page'], ['attention', 'attention-page'],
    ['agent-tools', 'agent-tools-page'], ['health', 'health-center-page'],
  ];
  for (const [width, mode, density] of [[1440, 'light', 'standard'], [1440, 'dark', 'standard'], [1440, 'dark', 'compact'], [1440, 'light', 'comfortable'], [390, 'light', 'compact'], [390, 'dark', 'comfortable']] as const) {
    await page.setViewportSize({ width, height: 900 });
    const preferences = { locale: 'zh-CN', theme: 'claw', themeMode: mode, fontDensity: density, accentColor: '#265f99' };
    const saved = await fetch(`http://127.0.0.1:${apiPort}/api/user/preferences`, { method: 'PUT', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ preferences }) });
    expect(saved.ok).toBe(true);
    let reference: unknown;
    for (const [path, tag] of paths) {
      await page.mouse.move(0, 0);
      await page.goto(`${base}/${path}`);
      await expect(page.locator('html')).toHaveAttribute('data-theme-mode', mode);
      await expect(page.locator('html')).toHaveAttribute('data-density', density);
      const button = page.locator(tag).locator('.btn-refresh').first();
      await expect(button).toBeVisible(); await expect(button).toBeEnabled();
      await expect(button).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
      await expect(button).toHaveCSS('border-color', 'rgba(0, 0, 0, 0)');
      // Theme attributes change before the button's color transition finishes.
      const expectedColor = await button.evaluate(el => {
        const probe = document.createElement('span'); probe.style.color = 'var(--btn-ghost-color)';
        el.append(probe); const color = getComputedStyle(probe).color; probe.remove(); return color;
      });
      await expect(button).toHaveCSS('color', expectedColor);
      const style = await button.evaluate(el => {
        const s = getComputedStyle(el), icon = getComputedStyle(el, '::before');
        return { height: Math.round(el.getBoundingClientRect().height * 100) / 100, font: s.fontSize, weight: s.fontWeight, padding: s.padding, radius: s.borderRadius, color: s.color, background: s.backgroundColor, border: s.borderColor, icon: icon.maskImage, iconSize: icon.width };
      });
      if (!reference) reference = style;
      expect(style, `${path}: ${width}/${mode}/${density}`).toEqual(reference);
      expect(style.iconSize).toBe('16px');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), path).toBe(true);
      await button.focus(); await expect(button).toBeFocused();
      await button.click(); // Same formal read endpoint, never a diagnostic/model action.
      await expect(button).toBeEnabled();
      measurements.push({ path, width, mode, density, style });
      await page.mouse.move(0, 0);
      await expect(button).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
      await expect(button).toHaveCSS('color', expectedColor);
      await page.screenshot({ path: `${output}/consistency-${path}-${width}-${mode}-${density}.png`, fullPage: true, animations: 'disabled' });
    }
  }
  await writeFile(`${output}/button-consistency.json`, JSON.stringify(measurements, null, 2));
});
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
    PORT:String(apiPort), AGENT_WS_PORT:'29886', SLIDE_MEMORY_PIPELINE_ENABLED:'false', METRICS_COLLECTION_ENABLED:'false' };
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

test('feedback: readable actions, consistent resource gutters, inset selects and protected form drafts', async ({ page }) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.setDefaultTimeout(10_000);
  page.on('pageerror', error => errors.push(error.message));
  const [instance] = await pool.query('SELECT id FROM database_instances LIMIT 1');
  await pool.query("INSERT INTO alerts(instance_id,alert_type,level,title,message,status) VALUES(?,'performance','warning','MAX-186 活动告警按钮验收','隔离合成告警，不调用模型','unread')", [instance[0].id]);
  await pool.query("INSERT INTO alert_events(event_id,instance_id,title,severity,status) VALUES(UUID(),?,'MAX-186 待处理事项 · 长标题用于间距复核','warning','open')", [instance[0].id]);
  await page.addInitScript(({ token, permissions }) => {
    localStorage.setItem('token', token);
    localStorage.setItem('permissions', JSON.stringify(permissions));
    localStorage.setItem('slide.i18n.locale', 'zh-CN');
  }, { token, permissions });
  const measurements: unknown[] = [];
  for (const [width, mode, accent, density] of [
    [1440, 'light', '#409eff', 'standard'], [1440, 'dark', '#409eff', 'standard'],
    [390, 'light', '#409eff', 'compact'], [390, 'dark', '#409eff', 'compact'],
    [1440, 'light', '#14b8a6', 'standard'], [1440, 'dark', '#14b8a6', 'standard'],
  ] as const) {
    await page.setViewportSize({ width, height: 900 });
    const preferences = { locale: 'zh-CN', theme: 'claw', themeMode: mode, accentColor: accent, fontDensity: density };
    const saved = await fetch(`http://127.0.0.1:${apiPort}/api/user/preferences`, { method: 'PUT', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ preferences }) });
    expect(saved.ok).toBe(true);
    for (const path of ['instances-db', 'servers', 'network-devices', 'attention', 'investigations', 'events']) {
      await page.goto(`${base}/${path}`);
      const view = page.locator(path === 'instances-db' ? 'instances-page' : path === 'events' ? 'alerts-page' : `${path}-page`);
      if (['instances-db', 'servers', 'network-devices'].includes(path)) {
        await expect(view.locator('resource-metrics-table')).toBeVisible();
        const table = view.locator('resource-metrics-table');
        const gutter = await table.evaluate(el => parseFloat(getComputedStyle(el).paddingLeft));
        expect(gutter).toBeGreaterThanOrEqual(8);
        expect(gutter).toBe(await view.locator('.resource-toolbar').evaluate(el => parseFloat(getComputedStyle(el).paddingLeft)));
        await expect(table.locator('.toolbar')).toHaveCount(0);
        await expect(view.locator('.resource-toolbar').getByRole('button', { name: '列设置', exact: true })).toBeVisible();
      } else if (path === 'attention') {
        await expect(view.getByText('MAX-186 待处理事项 · 长标题用于间距复核')).toBeVisible();
        const gap = await view.evaluate(el => {
          const table = el.querySelector('app-data-table')!.getBoundingClientRect();
          const actions = el.querySelector('.attention-actions')!.getBoundingClientRect();
          return actions.top - table.bottom;
        });
        expect(gap).toBeGreaterThanOrEqual(12);
      } else if (path === 'investigations') {
        await expect(view.getByRole('button', { name: '创建手动调查', exact: true })).toBeVisible();
        const select = view.getByRole('combobox', { name: '调查状态', exact: true });
        if (width > 600) expect((await select.boundingBox())!.width).toBeLessThanOrEqual(145);
      }
      if (path === 'events') {
        await expect(view.getByRole('button', { name: '确认', exact: true }).first()).toBeVisible();
        for (const badge of await view.locator('.instance-badge').all()) {
          if (!(await badge.isVisible())) continue;
          expect(await badge.evaluate(el => el.getBoundingClientRect().right <= el.parentElement!.getBoundingClientRect().right)).toBe(true);
        }
      }
      const selects = view.locator('select:not([multiple]):not([size])');
      for (const select of await selects.all()) {
        if (!(await select.isVisible())) continue;
        const style = await select.evaluate(el => ({ appearance: getComputedStyle(el).appearance, padding: parseFloat(getComputedStyle(el).paddingRight), position: getComputedStyle(el).backgroundPosition }));
        expect(style.appearance).toBe('none'); expect(style.padding).toBeGreaterThanOrEqual(36);
        expect(style.position).toContain('12px');
      }
      for (const button of await view.locator('.btn-primary, .action-btn.primary, .btn.primary').all()) {
        if (!(await button.isVisible())) continue;
        const style = await button.evaluate(el => ({ color: getComputedStyle(el).color, background: getComputedStyle(el).backgroundColor }));
        expect(style.color).toBe('rgb(255, 255, 255)');
        const rgb = style.background.match(/[\d.]+/g)!.slice(0, 3).map(Number).map(v => v / 255).map(v => v <= 0.04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4);
        expect(1.05 / (.2126 * rgb[0] + .7152 * rgb[1] + .0722 * rgb[2] + .05)).toBeGreaterThanOrEqual(4.5);
        measurements.push({ width, mode, accent, density, path, ...style });
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: `${output}/feedback-${path}-${width}-${mode}-${accent.slice(1)}.png`, fullPage: true, animations: 'disabled' });
      if (['instances-db', 'servers', 'network-devices'].includes(path)) {
        const trigger = view.locator('.resource-action--add');
        await trigger.click();
        const modal = view.locator('app-dialog');
        const input = modal.locator('input:visible:not([type=number]):not([type=password])').first();
        await input.fill('误触后保留的资源表单');
        await page.mouse.click(4, 4);
        await expect(input).toHaveValue('误触后保留的资源表单');
        if (width === 1440 && mode === 'light' && accent === '#409eff') await page.screenshot({ path: `${output}/feedback-form-${path}.png`, fullPage: true, animations: 'disabled' });
        await page.keyboard.press('Escape'); await expect(view.getByRole('dialog')).toHaveCount(0); await expect(trigger).toBeFocused();
      }
      if (path === 'investigations') {
        const trigger = view.getByRole('button', { name: '创建手动调查', exact: true });
        await trigger.click();
        const dialog = page.getByRole('dialog', { name: '创建手动调查', exact: true });
        await expect(dialog).toBeVisible();
        await page.getByRole('textbox', { name: '调查标题', exact: true }).fill('误触后保留的调查标题');
        await page.getByRole('textbox', { name: '调查目标', exact: true }).fill('误触遮罩后仍保留的未提交内容');
        await page.mouse.click(4, 4);
        await expect(dialog).toBeVisible();
        await expect(page.getByRole('textbox', { name: '调查目标', exact: true })).toHaveValue('误触遮罩后仍保留的未提交内容');
        await page.screenshot({ path: `${output}/feedback-create-${width}-${mode}-${accent.slice(1)}.png`, fullPage: true, animations: 'disabled' });
        await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0); await expect(trigger).toBeFocused();
      }
    }
  }
  expect(errors).toEqual([]);
  expect(Number((await pool.query('SELECT COUNT(*) AS n FROM agent_runs'))[0][0].n)).toBe(0);
  await writeFile(`${output}/feedback-measurements.json`, JSON.stringify({ source: 'formal HTTP/JWT + task-owned SQL synthetic inventory and events; no shared sessions or model calls', measurements, errors }, null, 2));
});


test('resource feedback: unified stored refresh, compact columns, neutral names, unique hosts and row numbers', async ({ page }) => {
  test.setTimeout(150_000);
  page.setDefaultTimeout(10_000);
  await pool.query("UPDATE servers SET label=host WHERE id=?", [serverId]);
  await page.addInitScript(({ token, permissions }) => {
    localStorage.setItem('token', token); localStorage.setItem('permissions', JSON.stringify(permissions));
    localStorage.setItem('slide.i18n.locale', 'zh-CN');
  }, { token, permissions });
  const measurements: unknown[] = [], errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  for (const [width, mode] of [[1920, 'light'], [1440, 'dark'], [390, 'light'], [390, 'dark']] as const) {
    await page.setViewportSize({ width, height: 900 });
    const saved = await fetch(`http://127.0.0.1:${apiPort}/api/user/preferences`, { method:'PUT', headers:{authorization:`Bearer ${token}`, 'content-type':'application/json'}, body:JSON.stringify({preferences:{locale:'zh-CN',theme:'claw',themeMode:mode,accentColor:'#265f99',fontDensity:'standard'}}) });
    expect(saved.ok).toBe(true);
    for (const [path, tag, endpoint] of [
      ['instances-db', 'instances-page', '/api/database/instances'],
      ['servers', 'servers-page', '/api/servers'],
      ['network-devices', 'network-devices-page', '/api/network-devices'],
    ]) {
      await page.goto(`${base}/${path}`);
      const view = page.locator(tag), table = view.locator('resource-metrics-table');
      const refresh = view.getByRole('button', { name:'刷新', exact:true });
      await expect(refresh).toHaveCount(1); await expect(refresh).toBeEnabled();
      await expect(view.getByRole('button', {name:'刷新指标', exact:true})).toHaveCount(0);
      const columns = view.locator('.resource-toolbar').getByRole('button', {name:'列设置',exact:true});
      await expect(columns).toBeVisible();
      await columns.focus(); await page.keyboard.press('Enter');
      const dialog = table.locator('app-dialog[title="列设置"]');
      await expect(dialog.getByRole('dialog', {name:'列设置',exact:true})).toBeVisible();
      const choice = dialog.getByRole('checkbox').first(), name = await choice.evaluate(el=>el.parentElement!.textContent!.trim());
      await choice.uncheck(); await dialog.getByRole('button',{name:'完成',exact:true}).click();
      await expect(columns).toBeFocused();
      await expect(table.getByRole('columnheader',{name,exact:true})).toHaveCount(0);
      await columns.click(); await dialog.getByRole('button',{name:'恢复默认',exact:true}).click();
      await page.keyboard.press('Escape'); await expect(columns).toBeFocused();
      await expect(table.getByRole('columnheader',{name:'序号',exact:true})).toBeVisible();
      expect(await table.locator('tbody tr td:first-child').allTextContents()).toEqual(path === 'servers' ? ['1','2'] : ['1']);
      if (path === 'servers') {
        const host = table.locator('tbody tr').filter({hasText:'max186-no-target.invalid'}).locator('td').nth(1);
        expect((await host.innerText()).match(/max186-no-target\.invalid/g)).toHaveLength(1);
      }
      const nameButton = table.locator('tbody tr').first().locator('td').nth(1).getByRole('button').first();
      const nameColor = await nameButton.evaluate(el=>getComputedStyle(el).color);
      // Names on all three pages use the same shared ghost button palette.
      await expect(nameButton).toHaveCSS('color', await nameButton.evaluate(el=>{
        const span=document.createElement('span');span.style.color='var(--btn-ghost-color)';el.append(span);const value=getComputedStyle(span).color;span.remove();return value;
      }));
      const reads: string[] = [], writes: string[] = [];
      const listener = (request: import('@playwright/test').Request) => {
        const url=new URL(request.url());if(!url.pathname.startsWith('/api/'))return;
        if(request.method()==='GET' || url.pathname==='/api/metrics/query') reads.push(url.pathname); else writes.push(url.pathname);
      };
      page.on('request',listener);
      await refresh.focus(); await page.keyboard.press('Enter'); await expect(refresh).toBeEnabled();
      await expect.poll(()=>reads.filter(p=>p===endpoint).length).toBe(1);
      await expect.poll(()=>reads.filter(p=>p==='/api/metrics/query').length).toBe(path === 'servers' ? 2 : 1);
      await expect(refresh).toBeEnabled(); page.off('request', listener);
      expect(writes).toEqual([]);
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
      if(width===1920) {
        const search = view.locator('.resource-toolbar input').first();
        expect(Math.abs((await search.boundingBox())!.y-(await columns.boundingBox())!.y)).toBeLessThan(10);
      }
      await page.mouse.move(0,0);
      await page.screenshot({path:`${output}/resource-${path}-${width}-${mode}.png`,fullPage:true,animations:'disabled'});
      measurements.push({path,width,mode,nameColor,reads,writes});
    }
  }
  expect(errors).toEqual([]);
  expect(Number((await pool.query('SELECT COUNT(*) AS n FROM agent_runs'))[0][0].n)).toBe(0);
  await writeFile(`${output}/resource-feedback.json`,JSON.stringify({source:'formal Fastify/HTTP/JWT and isolated persisted synthetic inventory, no business HTTP mocks or collection/model calls',measurements,errors},null,2));
});
