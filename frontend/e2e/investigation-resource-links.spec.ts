import { test, expect, type Page } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { resourceQualificationProvider } from '../../apps/db-ops-api/src/investigations/resource-real-provider-qualification.ts';
import { startInvestigationServer } from './fixtures/investigation-server.ts';


test.describe.configure({mode:'serial'});
let env: Awaited<ReturnType<typeof startInvestigationServer>>;
let real: Awaited<ReturnType<typeof resourceQualificationProvider>> | undefined;
const receipts: Record<string,{alert:number;investigation:string;evidenceId?:string}> = {};
test.beforeAll(async()=>{
  if(process.env.T10_REAL_PROVIDER==='1')real=await resourceQualificationProvider();
  env=await startInvestigationServer({databaseAlertPilot:true,resourcePilot:true,realProvider:real?.provider});
});
test.afterAll(async()=>{
  try { if(env){expect(env.workerErrors).toEqual([]);} }
  finally { try {await env?.close();} finally {if(real){const state=real.finish();await writeFile(test.info().outputPath('model-budget.json'),JSON.stringify(state,null,2));}} }
});
async function login(page:Page){const actor=env.owner;await page.addInitScript(({token,actor})=>{
  localStorage.setItem('token',token);localStorage.setItem('user',JSON.stringify({id:actor.userId,username:actor.username}));
  localStorage.setItem('permissions',JSON.stringify(actor.permissions));
  localStorage.setItem('slide.control.settings.v1',JSON.stringify({locale:'zh-CN',navCollapsed:true}));
},{token:env.token(),actor});}
for(const type of ['instance','server','network_device'] as const)test(`${type}: alert → same investigation → evidence → follow-up → resource`,async({page})=>{
  const field=type==='instance'?'instance_id':type==='server'?'server_id':'network_device_id';
  const observedAt=new Date(Date.now()-2000).toISOString(),from=new Date(Date.now()-62000).toISOString();
  const tags={observed_at:observedAt,observed_from:from,observed_to:observedAt,quality:type==='network_device'?'unknown':'good'};
  const [row]=await env.pool.query(`INSERT INTO alerts (${field},target_type,alert_type,level,title,message,metric_name,metric_value,tags)
    VALUES (101,?,'performance','critical',?,?,'cpu_usage',?,?)`,[type,`${type} 资源往返夹具`,`${type}:101 冻结观测；缺指标不判断正常或宕机；请先调用 get_resource_observations，resourceType=${type}，resourceId=101，再基于返回事实给出中文摘要`,type==='network_device'?null:'91',JSON.stringify(tags)]);
  await login(page);await page.goto(`${env.url}/alerts`);
  const card=page.getByRole('row').filter({hasText:`${type} 资源往返夹具`});
  await expect(card).toBeVisible();
  await card.getByRole('button',{name:'AI',exact:true}).click();
  await expect(page.locator('.investigation-states')).toContainText('执行完成',{timeout:90_000});
  const id=new URL(page.url()).searchParams.get('investigation')!;expect(id).toBeTruthy();receipts[type]={alert:row.insertId,investigation:id};
  const again=await page.request.post(`${env.url}/api/alerts/${row.insertId}/investigation`,{headers:{authorization:`Bearer ${env.token()}`},data:{}});
  expect(again.status()).toBe(202);expect((await again.json()).investigationId).toBe(id);
  await expect(page.locator('investigation-context .evidence-entry').first()).toBeAttached();
  await expect(page.locator('.investigation-messages')).toContainText('get_resource_observations');
  await expect.poll(()=>page.evaluate(()=>{const c=(document.querySelector('investigations-page') as any)?.controller;return c?.online===true;})).toBe(true);
  // The SQL context is also exposed by the authenticated formal detail route.
  const response=await page.request.get(`${env.url}/api/investigations/${id}`,{headers:{authorization:`Bearer ${env.token()}`}});
  expect((await response.json()).context).toMatchObject({subject:{kind:'resource',resource:{type,id:101}},from,to:observedAt});
  await page.getByRole('textbox',{name:'继续调查',exact:true}).fill(`${type}:101 请调用 get_resource_observations（resourceType=${type}，resourceId=101）再次读取本资源观测；缺指标不推断设备正常或宕机。`);
  await page.getByRole('button',{name:'提交新 Run',exact:true}).click();
  await expect.poll(async()=>{const [rows]=await env.pool.query('SELECT COUNT(*) AS n FROM investigation_results WHERE investigation_id=?',[id]);return Number(rows[0].n);},{timeout:90_000}).toBe(2);
  await expect(page.locator('.investigation-states')).toContainText('执行完成',{timeout:90_000});
  await page.getByRole('link',{name:`返回原资源 ${type}:101`,exact:true}).click();
  const links=page.locator('resource-investigation-links');await expect(links.getByRole('link',{name:`${type} 资源往返夹具`,exact:true})).toBeVisible();
  for(const width of [1440,1024,390]){
    await page.setViewportSize({width,height:950});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await expect.poll(async()=>{
      const content=await links.boundingBox(),nav=await page.locator('.shell-nav').boundingBox();
      return content!.x>=nav!.x+nav!.width && content!.x+content!.width<=width;
    }).toBe(true);
    await page.screenshot({path:test.info().outputPath(`${type}-resource-${width}.png`),fullPage:true});
  }
  await page.evaluate(()=>document.documentElement.dataset.sidebarPosition='right');
  await expect.poll(async()=>{
    const content=await links.boundingBox(),nav=await page.locator('.shell-nav').boundingBox();
    return content!.x+content!.width<=nav!.x;
  }).toBe(true);
  await page.evaluate(()=>delete document.documentElement.dataset.sidebarPosition);
  const before=env.counts();
  await links.getByRole('link',{name:`${type} 资源往返夹具`,exact:true}).click();
  await expect(page.locator('.investigation-states')).toContainText('执行完成',{timeout:90_000});
  expect(new URL(page.url()).searchParams.get('investigation')).toBe(id);expect(env.counts()).toEqual(before);
  const [runs]=await env.pool.query('SELECT state FROM agent_runs WHERE session_id=(SELECT session_id FROM investigations WHERE id=?)',[id]);
  expect(runs).toHaveLength(2);expect(runs.every((r:any)=>r.state==='completed')).toBe(true);
  const [bindings]=await env.pool.query('SELECT resource_type,resource_id,role FROM investigation_resources WHERE investigation_id=?',[id]);
  await expect.poll(()=>page.evaluate(()=>(document.querySelector('investigations-page') as any)?.controller?.evidence?.length??0)).toBeGreaterThan(0);
  const evidenceId=await page.evaluate(()=>(document.querySelector('investigations-page') as any).controller.evidence[0].id);
  receipts[type].evidenceId=evidenceId;
  const evidenceResponse=await page.request.get(`${env.url}/api/investigations/${id}/evidence/${evidenceId}?raw=true`,{headers:{authorization:`Bearer ${env.token()}`}});
  expect(evidenceResponse.status()).toBe(200);
  const [results]=await env.pool.query('SELECT version,result_json FROM investigation_results WHERE investigation_id=? ORDER BY version',[id]);
  await writeFile(test.info().outputPath(`${type}-roundtrip.json`),JSON.stringify({mode:real?'real-provider':'controlled-provider',source:{type,id:101,alertId:row.insertId,tags},investigationId:id,
    context:(await response.json()).context,bindings,runs,evidence:await evidenceResponse.json(),results,counts:env.counts()},null,2));

});
test('same JWT revocation blocks source/deep link/evidence/WS and every required scope',async({page})=>{
  await login(page);const id=receipts.network_device.investigation;
  await page.goto(`${env.url}/investigations?investigation=${id}`);await expect(page.locator('.investigation-messages')).toBeVisible();
  await expect.poll(()=>page.evaluate(()=>(document.querySelector('investigations-page') as any)?.controller?.online)).toBe(true);
  const multi=await env.bridge.create(env.owner,{title:'全部必需 scope',goal:'不得越权',profileId:'ops',profileVersion:1,resources:[{type:'instance',id:101,role:'primary'},{type:'network_device',id:101,role:'related'}],idempotencyKey:crypto.randomUUID()});
  await env.pool.query("DELETE rp FROM role_permissions rp JOIN permissions p ON p.id=rp.permission_id WHERE rp.role_id=101 AND p.code='network_devices:view'");
  await expect(page.locator('.investigation-messages')).toHaveCount(0);
  const headers={authorization:`Bearer ${env.token()}`};
  expect((await page.request.post(`${env.url}/api/alerts/${receipts.network_device.alert}/investigation`,{headers,data:{}})).status()).toBe(404);
  for(const denied of [id,multi.investigation.id]){
    expect((await page.request.get(`${env.url}/api/investigations/${denied}`,{headers})).status()).toBe(404);
    if(denied===id)expect((await page.request.get(`${env.url}/api/investigations/${denied}/evidence/${receipts.network_device.evidenceId}?raw=true`,{headers})).status()).toBe(404);
  }
  await page.reload();await expect(page.locator('investigations-page')).not.toContainText('network_device 资源往返夹具');
  const list=await page.request.get(`${env.url}/api/investigations?resource=network_device:101`,{headers});expect((await list.json()).items).toEqual([]);
  await page.goto(`${env.url}/?tab=network-device-detail&networkDeviceId=101`);await expect(page.locator('network-device-detail')).not.toContainText('网络无数据夹具');
});
