import { test, expect, type Page } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { startInvestigationServer } from './fixtures/investigation-server.ts';

let env: Awaited<ReturnType<typeof startInvestigationServer>>;
test.beforeAll(async () => { env = await startInvestigationServer({systemPilot:true}); });
test.afterAll(async () => { if (env) try {expect(env.workerErrors).toEqual([]);expect(env.observationErrors).toEqual([]);} finally {await env.close();} });
async function login(page:Page) {
  await page.addInitScript(({token,actor}) => {
    localStorage.setItem('token',token);localStorage.setItem('user',JSON.stringify({id:actor.userId,username:actor.username}));
    localStorage.setItem('permissions',JSON.stringify(actor.permissions));
    localStorage.setItem('slide.control.settings.v1',JSON.stringify({locale:'zh-CN',navCollapsed:true}));
  },{token:env.token(),actor:env.owner});
}
test('durable 5xx → official composition/admission/executor/source → WS Workspace → two continued Runs',async ({page}) => {
  await login(page);
  for (const status of [400,403]) expect((await fetch(`${env.apiUrl}/fixture/system-${status}`)).status).toBe(status);
  await env.system!.publisher!.drain();
  const [none] = await env.pool.query('SELECT COUNT(*) n FROM workflow_jobs');expect(Number(none[0].n)).toBe(0);
  expect((await fetch(`${env.apiUrl}/fixture/system-failure?private=never-store`)).status).toBe(503);
  await env.system!.publisher!.drain();
  let id='';
  await expect.poll(async () => {const [rows]=await env.pool.query('SELECT id FROM investigations WHERE profile_id=\'system\'');id=rows[0]?.id??'';return id;}).not.toBe('');
  await expect.poll(async () => {const [rows]=await env.pool.query('SELECT COUNT(*) n FROM investigation_results WHERE investigation_id=?',[id]);return Number(rows[0].n);}).toBe(1);
  await page.goto(`${env.url}/events?view=system`);
  await expect(page.getByRole('heading',{name:'平台异常'})).toBeVisible();
  await expect(page.getByText('api: HTTP_503',{exact:true})).toBeVisible();
  expect(await page.getByRole('link',{name:'打开调查'}).count()).toBe(0);
  await env.pool.query("INSERT INTO investigation_members (investigation_id,user_id,role,granted_by) VALUES (?,101,'operator',?)",[id,env.systemServiceId]);
  await page.getByRole('button',{name:'刷新异常'}).click();
  await page.getByRole('button',{name:'查看原始事实'}).click();
  await expect(page.locator('system-events-page pre')).toContainText('contentHash');
  await expect(page.locator('system-events-page pre')).not.toContainText('never-store');
  await page.getByRole('link',{name:'打开调查'}).click();
  await expect(page.locator('.investigation-states')).toContainText('执行完成');
  await expect.poll(() => page.evaluate(() => (document.querySelector('investigations-page') as any)?.controller?.online)).toBe(true);
  await expect(page.locator('.investigation-messages')).toContainText('read_source_region');
  const [initialEvidence]=await env.pool.query('SELECT raw_json FROM investigation_evidence WHERE investigation_id=?',[id]);
  const original=JSON.stringify(initialEvidence);expect(original).toContain('fixture-failure');expect(original).toContain('rootCauseVerified');expect(original).toContain('contentHash');
  await page.reload(); await expect(page.locator('.investigation-states')).toContainText('执行完成');
  for (let version=2;version<=3;version++) {
    await page.getByRole('textbox',{name:'继续调查',exact:true}).fill(`继续核验原始错误第${version}轮`);
    await page.getByRole('button',{name:'提交新 Run',exact:true}).click();
    await expect.poll(async () => {const [rows]=await env.pool.query('SELECT COUNT(*) n FROM investigation_results WHERE investigation_id=?',[id]);return Number(rows[0].n);}).toBe(version);
    const [diagnostic]=await env.pool.query('SELECT state,result_json FROM agent_runs WHERE session_id=(SELECT session_id FROM investigations WHERE id=?) ORDER BY created_at',[id]);
    await writeFile(test.info().outputPath('t09-run-diagnostic.json'),JSON.stringify({runs:diagnostic,prompts:env.promptObservations},null,2));
    await expect(page.locator('.investigation-states')).toContainText('执行完成');
  }
  const [runs]=await env.pool.query('SELECT id,state FROM agent_runs WHERE session_id=(SELECT session_id FROM investigations WHERE id=?)',[id]);
  expect(runs).toHaveLength(3);expect(new Set(runs.map((r:any)=>r.id)).size).toBe(3);expect(runs.every((r:any)=>r.state==='completed')).toBe(true);
  const [versions]=await env.pool.query('SELECT version FROM investigation_results WHERE investigation_id=? ORDER BY version',[id]);expect(versions.map((v:any)=>Number(v.version))).toEqual([1,2,3]);
  expect(env.systemConsumption).toEqual(Array.from({length:3},()=>({originalFact:true,exactSource:true})));
  await page.screenshot({path:test.info().outputPath('t09-system-workspace.png'),fullPage:true});
  await writeFile(test.info().outputPath('t09-system-evidence.json'),JSON.stringify({mode:'isolated MySQL/formal migrations/JWT/HTTP/WS/Chromium; controlled Provider/signed fixture source',investigationId:id,runs,versions,consumption:env.systemConsumption,evidence:initialEvidence},null,2));
  await env.pool.query("DELETE rp FROM role_permissions rp JOIN permissions p ON p.id=rp.permission_id WHERE rp.role_id=101 AND p.code='config:view'");
  await page.goto(`${env.url}/events?view=system`);await expect(page.getByRole('alert')).toContainText('无访问权限');
  await expect(page.getByText('api: HTTP_503',{exact:true})).toHaveCount(0);
});
