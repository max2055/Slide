import { test, expect, type Page } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { startInvestigationServer } from './fixtures/investigation-server.ts';

let env: Awaited<ReturnType<typeof startInvestigationServer>>;
test.beforeAll(async () => { env = await startInvestigationServer({ systemPilot: true, systemAutomatic: false }); });
test.afterAll(async () => { if (env) await env.close(); });
async function login(page: Page) {
  await page.addInitScript(({token,actor}) => {
    localStorage.setItem('token',token);localStorage.setItem('user',JSON.stringify({id:actor.userId,username:actor.username}));
    localStorage.setItem('permissions',JSON.stringify(actor.permissions));
    localStorage.setItem('slide.control.settings.v1',JSON.stringify({locale:'zh-CN',navCollapsed:true}));
  }, {token:env.token(),actor:env.owner});
}
const api = (path: string, body?: unknown, key?: string, token?: string) => fetch(`${env.apiUrl}${path}`, {
  method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token ?? env.token()}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(key ? { 'Idempotency-Key': key } : {}) },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

test('MAX243 real 503 → durable event → no-model System draft → three verification outcomes and durable audit', async ({page}) => {
  await login(page);
  expect((await fetch(`${env.apiUrl}/fixture/system-failure?private=never-store`)).status).toBe(503);
  await env.system!.publisher!.drain();
  let eventId = '';
  await expect.poll(async () => {
    const [rows] = await env.pool.query("SELECT id FROM operational_events WHERE source='slide.system.api'");
    eventId = rows[0]?.id ?? ''; return eventId;
  }).not.toBe('');
  const runtime = await (await api('/api/platform/observations')).json();
  expect(runtime.system).toMatchObject({ collection: { configured: true, effective: true }, automatic: { configured: false, effective: false }, actual: { admissions: 0, lastRunAt: null } });
  expect(env.counts().providerCalls).toBe(0);
  await page.goto(`${env.url}/events?view=system`);
  await expect(page.getByRole('heading',{name:'平台异常'})).toBeVisible();
  await page.getByRole('button',{name:'打开只读调查',exact:true}).focus(); await page.keyboard.press('Enter');
  await expect(page.locator('system-investigation-facts')).toContainText('HTTP_503');
  await expect(page.locator('.investigation-states')).toContainText('尚未执行');
  await expect.poll(() => page.evaluate(() => (document.querySelector('investigations-page') as any)?.controller?.online)).toBe(true);
  const id = new URL(page.url()).searchParams.get('investigation')!;
  expect(id).toBeTruthy();
  expect(await (await api(`/api/platform/system-events/${eventId}/investigation`, {})).json()).toMatchObject({id,eventId,modelInvoked:false});
  expect((await api(`/api/platform/system-events/${eventId}/investigation`, {}, undefined, env.token(env.viewer))).status).toBe(404);
  const ops = await env.bridge.create(env.owner, { title:'资源边界负例',goal:'只读资源事实',profileId:'ops',profileVersion:1,
    resources:[{type:'instance',id:101,role:'primary'}],idempotencyKey:'cross-domain-negative' });
  expect((await api(`/api/investigations/${ops.investigation.id}/platform-events`)).status).toBe(404);
  expect((await api(`/api/platform/system-events/${eventId}/verifications`,{investigationId:ops.investigation.id,expectedVersion:1},crypto.randomUUID())).status).toBe(404);
  await env.pool.query("INSERT INTO investigation_members (investigation_id,user_id,role,granted_by) VALUES (?,102,'viewer',101)",[id]);
  expect((await api(`/api/investigations/${id}/platform-events`,undefined,undefined,env.token(env.viewer))).status).toBe(200);
  expect((await api(`/api/platform/system-events/${eventId}/verifications`,{investigationId:id,expectedVersion:1},crypto.randomUUID(),env.token(env.viewer))).status).toBe(403);
  const [jobs] = await env.pool.query("SELECT COUNT(*) n FROM investigation_requests WHERE investigation_id=?",[id]);expect(Number(jobs[0].n)).toBe(0);
  expect(env.counts().providerCalls).toBe(0);
  // New failure after the original is a valid 'not improved' observation.
  expect((await fetch(`${env.apiUrl}/fixture/system-failure?private=never-store`)).status).toBe(503);
  const retryKeys: string[] = [];
  const verificationPath = '**/api/platform/system-events/*/verifications';
  await page.route(verificationPath, async route => {
    retryKeys.push(route.request().headers()['idempotency-key']);
    if (retryKeys.length === 1) await route.abort('connectionreset');
    else await route.continue();
  });
  await page.getByRole('button',{name:'复测原异常',exact:true}).click();
  await expect(page.locator('system-investigation-facts [role=alert]')).toBeVisible();
  await expect(page.locator('system-investigation-facts')).not.toContainText('后续观测支持恢复');
  await page.getByRole('button',{name:'重试原复测请求',exact:true}).click();
  await expect(page.locator('system-investigation-facts')).toContainText('仍有失败信号');
  expect(retryKeys).toHaveLength(2); expect(retryKeys[1]).toBe(retryKeys[0]);
  await page.unroute(verificationPath);
  await expect(page.locator('.investigation-states')).toContainText('处理中');
  // A changed deployment cannot serve as same-deployment recovery evidence.
  env.setSystemFailureStatus(200);
  const originalCommit = process.env.SLIDE_COMMIT_SHA!;
  process.env.SLIDE_COMMIT_SHA = 'b'.repeat(40);
  await fetch(`${env.apiUrl}/fixture/system-failure?private=never-store`);
  process.env.SLIDE_COMMIT_SHA = originalCommit;
  await page.getByRole('button',{name:'复测原异常',exact:true}).click();
  await expect(page.locator('system-investigation-facts')).toContainText('证据不足，状态未知');
  await expect(page.locator('.investigation-states')).toContainText('未确认');
  // Return to the original version: old mismatching evidence remains a gap.
  await fetch(`${env.apiUrl}/fixture/system-failure?private=never-store`);
  const detail = await (await api(`/api/investigations/${id}`)).json();
  const key = crypto.randomUUID(), body = { investigationId: id, expectedVersion: detail.version };
  const first = await api(`/api/platform/system-events/${eventId}/verifications`,body,key);
  expect(first.status).toBe(200); const receipt = await first.json();
  expect(receipt.conclusion).toBe('insufficient_evidence');
  expect(await (await api(`/api/platform/system-events/${eventId}/verifications`,body,key)).json()).toEqual(receipt);
  expect((await api(`/api/platform/system-events/${eventId}/verifications`,{...body,expectedVersion:1},key)).status).toBe(409);
  expect((await api(`/api/platform/system-events/${eventId}/verifications`,body,crypto.randomUUID())).status).toBe(409);
  // A second original anomaly after version restoration has a clean observation window.
  const [beforeEvents] = await env.pool.query('SELECT id FROM operational_events');
  const oldIds = new Set(beforeEvents.map((r:any) => r.id));
  env.setSystemFailureStatus(503); await fetch(`${env.apiUrl}/fixture/system-failure`); await env.system!.publisher!.drain();
  let second = '';
  await expect.poll(async () => { const [rows] = await env.pool.query('SELECT id FROM operational_events ORDER BY received_at DESC'); second = rows.find((r:any) => !oldIds.has(r.id))?.id ?? ''; return second; }).not.toBe('');
  const next = await (await api(`/api/platform/system-events/${second}/investigation`,{})).json();
  env.setSystemFailureStatus(200); await fetch(`${env.apiUrl}/fixture/system-failure`);
  const recovery = await (await api(`/api/platform/system-events/${second}/verifications`, { investigationId:next.id,expectedVersion:1 },crypto.randomUUID())).json();
  expect(recovery).toMatchObject({ conclusion:'recovered',gaps:[],originalHash:expect.any(String),modelInvoked:false });
  await page.goto(`${env.url}/investigations?investigation=${next.id}`);
  await expect(page.locator('.investigation-states')).toContainText('已验证恢复');
  await expect(page.locator('system-investigation-facts')).toContainText('后续观测支持恢复');
  for (const [width,height] of [[1440,900],[1366,768],[1920,1080]]) {
    await page.setViewportSize({width,height});
    await page.locator('system-investigation-facts').scrollIntoViewIfNeeded();
    await expect(page.getByRole('link',{name:'返回原平台异常'})).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({path:test.info().outputPath(`platform-${width}.png`),fullPage:true});
  }
  await page.reload(); await expect(page.locator('system-investigation-facts')).toContainText('后续观测支持恢复');
  await page.getByRole('link',{name:'返回原平台异常'}).click();
  await expect(page.locator('system-events-page pre')).toContainText('HTTP_503');
  expect(env.counts().providerCalls).toBe(0);
  const facts = await (await api(`/api/investigations/${id}/platform-events`)).json();
  const [rows] = await env.pool.query('SELECT id,event_id,investigation_id,payload FROM platform_event_verifications ORDER BY created_at');
  await writeFile(test.info().outputPath('evidence.json'), JSON.stringify({ boundary:'own MySQL, formal migrations, JWT, real HTTP/Chromium; no external Provider or production operations', runtime, facts, rows, retryKeys, counts:env.counts() },null,2));
  expect(JSON.stringify(facts)).not.toContain('never-store');
  // R2: a real mounted component switches investigations while POST A is pending.
  // Its late denial must not clear B or release B's in-flight verification.
  const aDetail = await (await api(`/api/investigations/${id}`)).json();
  await page.evaluate(({id,version}) => {
    const el = document.createElement('system-investigation-facts') as any;
    el.id='race-facts';el.investigationId=id;el.version=version;document.body.append(el);
  }, {id,version:aDetail.version});
  const race = page.locator('#race-facts');
  await expect(race).toContainText(eventId);
  let oldRoute: import('@playwright/test').Route | undefined;
  let newRoute: import('@playwright/test').Route | undefined;
  const keys: string[] = [];
  await page.route(verificationPath, async route => {
    if (!oldRoute) oldRoute=route;
    else { keys.push(route.request().headers()['idempotency-key']);newRoute=route; }
  });
  await race.getByRole('button',{name:'复测原异常',exact:true}).click();
  await expect.poll(()=>!!oldRoute).toBe(true);
  const bDetail = await (await api(`/api/investigations/${next.id}`)).json();
  await page.evaluate(({id,version}) => {
    const el=document.querySelector('#race-facts') as any;el.investigationId=id;el.version=version;
  }, {id:next.id,version:bDetail.version});
  await expect(race).toContainText(second);
  await race.getByRole('button',{name:'复测原异常',exact:true}).click();
  await expect.poll(()=>!!newRoute).toBe(true);
  await oldRoute!.fulfill({status:403,contentType:'application/json',body:'{}'});
  await expect(race).toContainText(second);
  await expect(race.getByRole('button',{name:'正在复测…',exact:true})).toBeDisabled();
  await newRoute!.abort('connectionreset');
  await expect(race.getByRole('button',{name:'重试原复测请求',exact:true})).toBeEnabled();
  await page.unroute(verificationPath);
  await page.route(verificationPath, async route => { keys.push(route.request().headers()['idempotency-key']);await route.continue(); });
  await race.getByRole('button',{name:'重试原复测请求',exact:true}).click();
  await expect(race.getByRole('button',{name:'复测原异常',exact:true})).toBeEnabled();
  expect(keys).toHaveLength(2);expect(keys[1]).toBe(keys[0]);
  await page.unroute(verificationPath);
  await page.evaluate(()=>document.querySelector('#race-facts')!.remove());
  // Joint integration: missing deployment/model and unavailable reads stay unknown.
  env.failProvider(true);
  const priorEvents = new Set((await env.pool.query('SELECT id FROM operational_events'))[0].map((r:any)=>r.id));
  const savedCommit = process.env.SLIDE_COMMIT_SHA;
  delete process.env.SLIDE_COMMIT_SHA;
  env.setSystemFailureStatus(503);
  try { await fetch(`${env.apiUrl}/fixture/system-failure`);await env.system!.publisher!.drain(); }
  finally { if(savedCommit !== undefined) process.env.SLIDE_COMMIT_SHA=savedCommit; }
  let missingEvent='';
  await expect.poll(async()=>{
    const [events]=await env.pool.query('SELECT id FROM operational_events ORDER BY received_at DESC');
    missingEvent=events.find((r:any)=>!priorEvents.has(r.id))?.id??'';return missingEvent;
  }).not.toBe('');
  const missing = await (await api(`/api/platform/system-events/${missingEvent}/investigation`,{})).json();
  await page.goto(`${env.url}/investigations?investigation=${missing.id}`);
  await expect(page.locator('system-investigation-facts')).toContainText('缺少源码版本');
  await expect.poll(() => page.evaluate(() => (document.querySelector('investigations-page') as any)?.controller?.online)).toBe(true);
  await page.getByRole('button',{name:'复测原异常',exact:true}).click();
  await expect(page.locator('system-investigation-facts')).toContainText('证据不足，状态未知');
  await expect(page.locator('system-investigation-facts')).toContainText('缺少故障部署版本');
  for(const [width,height] of [[1440,900],[1366,768],[1920,1080]]) {
    await page.setViewportSize({width,height});
    await page.locator('system-investigation-facts').scrollIntoViewIfNeeded();
    await expect(page.getByRole('link',{name:'返回原平台异常'})).toBeInViewport();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await page.screenshot({path:test.info().outputPath(`unknown-${width}.png`),fullPage:true});
  }
  const factsPath=`**/api/investigations/${missing.id}/platform-events`;
  await page.route(factsPath,route=>route.fulfill({status:503,contentType:'application/json',body:'{}'}));
  await page.locator('system-investigation-facts').getByRole('button',{name:'刷新原异常',exact:true}).click();
  await expect(page.locator('system-investigation-facts [role=alert]')).toContainText('当前状态未知');
  await expect(page.locator('system-investigation-facts')).not.toContainText('HTTP_503');
  await page.unroute(factsPath);
  await page.locator('system-investigation-facts').getByRole('button',{name:'刷新原异常',exact:true}).click();
  await expect(page.locator('system-investigation-facts')).toContainText('缺少源码版本');
  // A disabled actual collector cannot reuse a previously healthy observation.
  await env.system!.close();
  const current = await (await api(`/api/investigations/${next.id}`)).json();
  const disabled = await (await api(`/api/platform/system-events/${second}/verifications`,
    {investigationId:next.id,expectedVersion:current.version},crypto.randomUUID())).json();
  expect(disabled).toMatchObject({conclusion:'insufficient_evidence',gaps:expect.arrayContaining(['SYSTEM_COLLECTION_DISABLED']),modelInvoked:false});
  const disabledRuntime=await (await api('/api/platform/observations')).json();
  expect(disabledRuntime.system.collection).toMatchObject({configured:true,effective:false});
  expect(env.counts().providerCalls).toBe(0);
  await writeFile(test.info().outputPath('negative-evidence.json'),JSON.stringify({
    boundary:'isolated SQL/HTTP/Chromium; unavailable Provider is a controlled fixture; no external model send',
    missing:await (await api(`/api/investigations/${missing.id}/platform-events`)).json(),disabled,disabledRuntime,counts:env.counts(),
  },null,2));
  // Revocation erases facts in the already mounted component and rejects HTTP.
  await page.goto(`${env.url}/investigations?investigation=${next.id}`);
  await expect(page.locator('system-investigation-facts')).toContainText('HTTP_503');
  await env.pool.query("DELETE rp FROM role_permissions rp JOIN permissions p ON p.id=rp.permission_id WHERE rp.role_id=101 AND p.code='config:view'");
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('slide-permissions-loaded',{detail:{permissions:['chat:view']}})));
  await expect(page.locator('main')).not.toContainText('HTTP_503');
  expect((await api(`/api/investigations/${next.id}/platform-events`)).status).toBe(404);
  expect((await api(`/api/platform/system-events/${second}/verifications`,{investigationId:next.id,expectedVersion:2},crypto.randomUUID())).status).toBe(404);
});
