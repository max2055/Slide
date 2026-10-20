import { test, expect, type Locator } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startOperationsServer } from './fixtures/operations-server.ts';

let env:Awaited<ReturnType<typeof startOperationsServer>>;
const output=process.env.MAX202_OUTPUT_DIR;
test.skip(!process.env.MAX202_MYSQL_PORT,'Requires a task-owned isolated MySQL via MAX202_MYSQL_PORT');
test.beforeAll(async()=>{env=await startOperationsServer();});
async function publishSynthetic(title:string) {
  const draft=await env.knowledge.create(env.author,{investigationId:env.source.inv.id,resultVersion:1,humanConfirmed:true,
    content:{title,symptoms:'SYNTHETIC bounded source',faultType:'synthetic',confirmedCause:'SYNTHETIC live source body',actions:'Synthetic observation only',actualEffect:'No business claim',counterexamples:'Not suitable for real incidents'},
    applicability:{conditions:'Synthetic browser verification only',productVersion:'synthetic-v1',resourceVersion:'synthetic-v1'},validUntil:new Date(Date.now()+1800000).toISOString()});
  const pending=await env.knowledge.submit(env.author,draft.id,{expectedRevision:draft.revision});
  await env.knowledge.review(env.reviewer,draft.id,{expectedRevision:pending.revision,version:draft.version,contentHash:draft.contentHash,decision:'approved',note:'Synthetic independent review'});
  return env.knowledge.detail(env.author,draft.id);
}
async function accessibleControls(root:Locator) {
  for(const control of await root.locator('button,input:not([type=hidden]),select,textarea,[role=tab]').all()) {
    if(await control.isVisible()){await expect(control).toHaveAccessibleName(/\S/);expect(Number(await control.getAttribute('tabindex')??0)).toBeLessThanOrEqual(0);}
  }
}

test.afterAll(async({browser})=>{for(const context of browser.contexts())await context.close();await env?.close();});
test('synthetic case authoring → independent review → search → revocation on real MySQL/JWT/HTTP',async({page,browser})=>{
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  async function identity(p:typeof page,actor=env.author) {
    await p.addInitScript(({token,actor})=>{
      localStorage.setItem('token',token);localStorage.setItem('user',JSON.stringify({id:actor.userId,username:actor.username}));
      localStorage.setItem('permissions',JSON.stringify(actor.permissions));
      localStorage.setItem('slide.control.settings.v1',JSON.stringify({locale:'zh-CN',navCollapsed:true,theme:'light'}));
    },{token:env.token(actor),actor});
  }
  await identity(page);
  await page.goto(`${env.url}/operations-knowledge?sourceInvestigation=${env.source.inv.id}&resultVersion=${env.source.result.version}`);
  const knowledge=page.locator('operations-knowledge');
  await expect(knowledge.getByRole('heading',{name:'可信运维知识',exact:true})).toBeVisible();
  await knowledge.getByRole('button',{name:'从调查整理案例',exact:true}).click();
  const dialog=knowledge.locator('app-dialog');
  const fields={'案例标题':'SYNTHETIC · 服务无响应后的受控恢复核验','问题现象':'合成只读指标用于浏览器验收，不是真实事故。','故障类型':'合成服务异常','已确认原因':'合成来源事实；不主张当前真实业务根因。','实际处理':'在隔离测试记录中核对健康观测，无外部执行。','实际效果':'合成指标恢复，仅用于功能验收。','反面证据与不适用条件':'资源耗尽、依赖故障、数据缺口均不适用。','适用条件':'有完整来源证据，资源与产品版本匹配。','产品版本':'synthetic-v1','资源版本':'synthetic-resource-v1'};
  for(const [name,value] of Object.entries(fields))await dialog.getByLabel(name,{exact:true}).fill(value);
  const date=new Date(Date.now()+1800000);const validUntil=new Date(+date-date.getTimezoneOffset()*60000).toISOString().slice(0,16);
  await dialog.getByLabel('有效期至',{exact:true}).fill(validUntil);
  await dialog.getByRole('checkbox').check();
  await dialog.getByRole('button',{name:'保存案例草稿',exact:true}).click();
  await expect(knowledge).toContainText('SYNTHETIC · 服务无响应后的受控恢复核验');
  const id=new URL(page.url()).searchParams.get('case')!;expect(id).toBeTruthy();
  await knowledge.getByRole('button',{name:'提交独立审核',exact:true}).click();
  await expect(knowledge).toContainText('待审核');
  await expect(knowledge.getByRole('button',{name:'审核发布当前版本',exact:true})).toBeDisabled();
  const context=await browser.newContext(),reviewer=await context.newPage();
  await identity(reviewer,env.reviewer);await reviewer.goto(`${env.url}/operations-knowledge?case=${id}`);
  const review=reviewer.locator('operations-knowledge');
  await review.getByLabel('审核或撤回依据',{exact:true}).fill('SYNTHETIC 第二测试身份独立审核来源、适用范围和反例。');
  await review.getByRole('button',{name:'审核发布当前版本',exact:true}).click();
  await expect(review).toContainText('已发布');
  const [head]=await env.rows('SELECT state,current_version,version FROM trusted_cases WHERE id=?',[id]);expect(head.state).toBe('published');
  await page.goto(`${env.url}/operations-knowledge`);
  await knowledge.getByLabel('搜索案例',{exact:true}).fill('服务无响应');await knowledge.getByRole('button',{name:'搜索',exact:true}).click();
  await expect(knowledge.getByRole('button',{name:'SYNTHETIC · 服务无响应后的受控恢复核验',exact:true})).toBeVisible();
  await knowledge.getByRole('button',{name:'SYNTHETIC · 服务无响应后的受控恢复核验',exact:true}).click();
  const screenshots:string[]=[];
  if(output){
    await mkdir(output,{recursive:true});
    for(const route of ['case','knowledge','actions']) {
      await page.goto(`${env.url}/${route==='actions'?'operations-actions':'operations-knowledge'}${route==='case'?`?case=${id}`:''}`);
      await expect(page.locator(route==='actions'?'operations-actions':'operations-knowledge').getByRole('heading',{level:1})).toBeVisible();
      for(const width of [1600,1024,390])for(const theme of ['light','dark']){
        await page.setViewportSize({width,height:1000});await page.evaluate(theme=>document.documentElement.dataset.themeMode=theme,theme);
        await page.waitForTimeout(100);
        expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
        const host=page.locator(route==='actions'?'operations-actions':'operations-knowledge');
        const box=await host.boundingBox();expect(box!.x).toBeGreaterThanOrEqual(0);
        const topbar=await page.locator('.topbar').boundingBox();expect(box!.y).toBeGreaterThanOrEqual(topbar!.y+topbar!.height);
        if(width===390)expect(box!.x).toBeGreaterThanOrEqual(70);
        expect(await page.evaluate(()=>document.documentElement.dataset.themeMode)).toBe(theme);
        const path=resolve(output,`${route}-${width}-${theme}.png`);await page.screenshot({path,fullPage:true});screenshots.push(path.split('/').at(-1)!);
      }
    }
    await writeFile(resolve(output,'browser-evidence.json'),JSON.stringify({source:'synthetic facts; real MySQL migrations/JWT/HTTP/domain/Lit',sourceInvestigation:env.source.inv.id,caseId:id,head,screenshots,pageErrors:errors,productModelCalls:0,externalActions:0},null,2));
  }
  await page.goto(`${env.url}/operations-knowledge?case=${id}`);await expect(knowledge).toContainText('已确认原因' in fields ? fields['已确认原因']:'合成来源事实');
  await env.rows('DELETE FROM instance_permissions WHERE user_id=101 AND instance_id=101');
  await knowledge.getByRole('button',{name:'刷新案例',exact:true}).click();
  await expect(knowledge).not.toContainText(fields['已确认原因']);await expect(knowledge).toContainText('不可访问');
  await env.rows("INSERT INTO instance_permissions(user_id,instance_id,access_level) VALUES(101,101,'admin')");
  await context.close();expect(errors).toEqual([]);
});

test('synthetic plan uses real version-bound submission and independent approval; editing invalidates the grant',async({browser})=>{
  const authorContext=await browser.newContext(),reviewContext=await browser.newContext();
  const author=await authorContext.newPage(),reviewer=await reviewContext.newPage();
  for(const [page,actor] of [[author,env.author],[reviewer,env.reviewer]] as const)await page.addInitScript(({token,actor})=>{
    localStorage.setItem('token',token);localStorage.setItem('user',JSON.stringify({id:actor.userId,username:actor.username}));localStorage.setItem('permissions',JSON.stringify(actor.permissions));
    localStorage.setItem('slide.control.settings.v1',JSON.stringify({locale:'zh-CN',navCollapsed:true}));
  },{token:env.token(actor),actor});
  await author.goto(`${env.url}/operations-actions?plan=${env.plan.id}`);
  const own=author.locator('operations-actions');await expect(own).toContainText('SYNTHETIC 独立审批测试');
  await own.getByRole('button',{name:'提交当前版本审批',exact:true}).click();
  await expect(own).toContainText('待独立审批');await expect(own.getByRole('button',{name:'批准当前版本',exact:true})).toBeDisabled();
  await reviewer.goto(`${env.url}/operations-actions`);const view=reviewer.locator('operations-actions');
  await view.getByRole('button',{name:`计划 ${env.plan.id} · v1`,exact:true}).click();
  await view.getByLabel('审批备注',{exact:true}).fill('SYNTHETIC 独立身份核对目标、影响、不可回退能力与版本。');
  const approve=view.getByRole('button',{name:'批准当前版本',exact:true});await approve.click();
  await expect(view.getByRole('dialog',{name:'确认当前计划审批'})).toBeVisible();
  await reviewer.keyboard.press('Escape');await expect(view.getByRole('dialog')).toHaveCount(0);await expect(approve).toBeFocused();
  await approve.click();await view.getByRole('button',{name:'确认批准当前版本',exact:true}).click();
  await expect(view).toContainText('已批准');await accessibleControls(view);
  if(output)for(const width of [1600,1024,390])for(const theme of ['light','dark']){
    await reviewer.setViewportSize({width,height:1000});await reviewer.evaluate(theme=>document.documentElement.dataset.themeMode=theme,theme);
    await expect(view).toContainText('执行与恢复');
    await reviewer.screenshot({path:resolve(output,`plan-${width}-${theme}.png`),fullPage:true});
  }
  await own.getByRole('button',{name:'刷新原计划',exact:true}).click();
  await own.getByRole('button',{name:'编辑为新计划版本',exact:true}).click();
  await own.getByLabel('预计影响',{exact:true}).fill('SYNTHETIC 新版本影响说明，不发送目标动作');
  await own.getByRole('button',{name:'保存新计划版本',exact:true}).click();await expect(own).toContainText('v2');
  const [old]=await env.rows('SELECT state FROM action_plan_versions WHERE plan_id=? AND version=1',[env.plan.id]);expect(old.state).toBe('superseded');
  const [count]=await env.rows('SELECT COUNT(*) n FROM action_executions');expect(Number(count.n)).toBe(0);
  if(output)await writeFile(resolve(output,'plan-evidence.json'),JSON.stringify({source:'synthetic environment; real source ACL/MySQL/JWT/HTTP/PlanService',planId:env.plan.id,oldState:old.state,newVersion:2,externalActions:0,productModelCalls:0,keyboard:'native modal Esc and focus restoration passed',limitations:['Synthetic identities/observations and isolated helper; no production qualification']},null,2));
  await authorContext.close();await reviewContext.close();
});

test('controlled HTTP fault matrix: loading, empty, failed, expired, revoked, unknown; long text and density',async({page})=>{
  // Deliberate HTTP response interception supplements the real-service flows above.
  // These states do not claim backend/domain or cross-package acceptance.
  const actor=env.author;
  await page.addInitScript(({token,actor})=>{
    localStorage.setItem('token',token);localStorage.setItem('user',JSON.stringify({id:actor.userId,username:actor.username}));localStorage.setItem('permissions',JSON.stringify(actor.permissions));
    localStorage.setItem('slide.control.settings.v1',JSON.stringify({locale:'zh-CN',navCollapsed:true}));
  },{token:env.token(actor),actor});
  const record={id:'controlled',revision:1,version:1,contentHash:'f'.repeat(64),state:'draft',author:{kind:'user',id:actor.userId},resources:[],validUntil:new Date(Date.now()+600000).toISOString(),tombstone:false,referenceOnly:true,
    content:{title:'SYNTHETIC 长文状态检查',symptoms:'合成受控长文本。'.repeat(250),faultType:'测试',confirmedCause:'CONTROLLED-SENSITIVE',actions:'不执行目标动作',actualEffect:'仅检查界面',counterexamples:'不能作为真实事件证据'},applicability:{conditions:'仅测试',productVersion:'synthetic',resourceVersion:'synthetic'},source:{investigationId:env.source.inv.id,resultVersion:1,resultId:'controlled',evidence:[]}};
  let mode='loading',writes=0;
  let release!:()=>void;const barrier=new Promise<void>(resolve=>release=resolve);
  await page.route('**/api/operations/knowledge**',async route=>{
    if(new URL(route.request().url()).pathname.endsWith('/watch')){await route.continue();return;}
    if(route.request().method()==='POST'){writes++;await route.fulfill({status:503,json:{reasonCode:'CONTROLLED_ACK_UNKNOWN'}});return;}
    if(mode==='loading')await barrier;
    if(mode==='failed'||mode==='revoked'){await route.fulfill({status:mode==='failed'?503:403,json:{reasonCode:'CONTROLLED_STATE'}});return;}
    if(mode==='expired'){await route.fulfill({json:{...record,state:'expired',tombstone:true,content:undefined,source:undefined,applicability:undefined,validUntil:'2020-01-01T00:00:00.000Z'}});return;}
    await route.fulfill({json:mode==='long'?record:{items:[],authorizedCounts:{total:0},nextCursor:null}});
  });
  await page.goto(`${env.url}/operations-knowledge`);const view=page.locator('operations-knowledge');
  await expect(view.getByRole('status')).toContainText('正在读取案例');mode='empty';release();
  await expect(view).toContainText('没有匹配的案例');
  mode='failed';await view.getByRole('button',{name:'搜索',exact:true}).click();await expect(view.getByRole('alert')).toContainText('服务暂不可用');
  mode='expired';await page.goto(`${env.url}/operations-knowledge?case=controlled`);await expect(view).toContainText('正文不可引用');await expect(view).not.toContainText('CONTROLLED-SENSITIVE');
  mode='long';await page.reload();await expect(view).toContainText('CONTROLLED-SENSITIVE');
  const densityEvidence=[];
  for(const density of ['compact','standard','comfortable']){
    await page.evaluate(async density=>{const {applyDensity}=await import('/src/app/ui/density.ts');applyDensity(density as 'compact'|'standard'|'comfortable');},density);
    for(const width of [1600,1024,390]){
      await page.setViewportSize({width,height:1000});
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
      for(const button of await view.getByRole('button').all())if(await button.isVisible())expect((await button.innerText()).trim()||await button.getAttribute('aria-label')).toBeTruthy();
      const heading=await view.getByRole('heading',{level:1}).boundingBox(),topbar=await page.locator('.topbar').boundingBox();
      expect(heading!.y).toBeGreaterThanOrEqual(topbar!.y+topbar!.height);
      densityEvidence.push({density,width,noOverflow:true,noToolbarOverlap:true});
      if(output && density==='comfortable')await page.screenshot({path:resolve(output,`controlled-long-${width}-${density}.png`),fullPage:true});
    }
  }
  await view.getByRole('button',{name:'提交独立审核',exact:true}).dblclick();
  await expect(view).toContainText('提交结果未知');expect(writes).toBe(1);
  mode='revoked';await page.reload();await expect(view.getByRole('alert')).toContainText('内容已清除');await expect(view).not.toContainText('CONTROLLED-SENSITIVE');
  if(output){await page.screenshot({path:resolve(output,'controlled-revoked-390.png'),fullPage:true});await writeFile(resolve(output,'controlled-state-evidence.json'),JSON.stringify({source:'explicit HTTP interception; supplements real service tests, not backend acceptance',states:['loading','empty','503 failure','expired tombstone','403 revoked','503 mutation unknown'],writeRequests:writes,densityEvidence,accessibleNames:'visible operations page buttons checked; modal keyboard/focus in real approval test',limitations:['No full axe/WCAG conformance claim','Special states use controlled HTTP interception']},null,2));}
});

test('trusted draft discovery and human case binding use live source/result/version ACL',async({page,request})=>{
  const headers={authorization:`Bearer ${env.token()}`};
  const send=(path:string,data:unknown)=>request.post(`${env.apiUrl}/api/operations${path}`,{headers,data});
  const input={investigationId:env.actionSource.inv.id,resultVersion:1,targetId:501,impact:'SYNTHETIC 可信服务端草案；无目标发送'};
  const forged=await send('/actions/drafts',{...input,tool:{hash:'f'.repeat(64)}});expect(forged.status()).toBe(422);
  const stale=await send('/actions/drafts',{...input,resultVersion:999});expect(stale.status()).toBe(409);
  const created=await send('/actions/drafts',input);expect(created.status()).toBe(201);const {plan}=await created.json();
  expect(plan.content.tool.hash).toBe('a'.repeat(64));expect(plan.content.evidence[0].id).toBe(env.actionSource.proof.id);
  const page1=await request.get(`${env.apiUrl}/api/operations/actions/plans?investigationId=${env.actionSource.inv.id}&limit=1`,{headers});
  expect(page1.status()).toBe(200);const first=await page1.json();expect(first.items).toHaveLength(1);expect(first.nextCursor).toBeTruthy();
  const next=await request.get(`${env.apiUrl}/api/operations/actions/plans?investigationId=${env.actionSource.inv.id}&limit=1&cursor=${encodeURIComponent(first.nextCursor)}`,{headers});expect(next.status()).toBe(200);expect((await next.json()).items[0].id).not.toBe(first.items[0].id);
  const changed=await request.get(`${env.apiUrl}/api/operations/actions/plans?investigationId=${env.actionSource.inv.id}&limit=1&state=approved&cursor=${encodeURIComponent(first.nextCursor)}`,{headers});expect(changed.status()).toBe(422);
  const candidate=await publishSynthetic('SYNTHETIC 手工绑定独立样本');
  const detail=await request.get(`${env.apiUrl}/api/investigations/${env.actionSource.inv.id}`,{headers});const inv=await detail.json();
  const binding={investigationId:inv.id,expectedVersion:inv.version,resultVersion:1,version:candidate.version,contentHash:candidate.contentHash,applicabilityConfirmed:true};
  const bad=await send(`/knowledge/${candidate.id}/bind`,{...binding,contentHash:'0'.repeat(64)});expect(bad.status()).toBe(422);
  await page.addInitScript(({token,actor})=>{localStorage.setItem('token',token);localStorage.setItem('user',JSON.stringify({id:actor.userId}));localStorage.setItem('permissions',JSON.stringify(actor.permissions));},{token:env.token(),actor:env.author});
  await page.goto(`${env.url}/operations-knowledge?case=${candidate.id}&sourceInvestigation=${inv.id}`);
  const knowledge=page.locator('operations-knowledge');await knowledge.getByRole('button',{name:'核对目标调查与当前结果'}).click();
  await accessibleControls(knowledge);await knowledge.getByRole('checkbox',{name:'确认案例适用条件'}).check();await knowledge.getByRole('button',{name:'绑定当前案例版本为参考'}).click();await expect(knowledge).toContainText('已绑定为历史参考');
  const [stored]=await env.rows('SELECT * FROM investigation_case_dependencies WHERE investigation_id=? AND case_id=?',[inv.id,candidate.id]);expect(stored.content_hash).toBe(candidate.contentHash);
  const audit=await env.rows("SELECT id FROM outbox_events WHERE event_type='operations.case.manually_bound' AND aggregate_id=?",[inv.id]);expect(audit).toHaveLength(1);
  // Open article must disappear without pressing refresh when source access is revoked.
  await env.rows('DELETE FROM instance_permissions WHERE user_id=101 AND instance_id=101');await expect(knowledge).not.toContainText(candidate.content!.confirmedCause,{timeout:10000});await expect(knowledge).toContainText('正文已清除');
  await env.rows("INSERT INTO instance_permissions(user_id,instance_id,access_level) VALUES(101,101,'admin')");
  expect(env.sends()).toBe(0);
});

test('browser executes one approved synthetic action, reads immutable effect report and closes/reopens investigation',async({page,request})=>{
  const headers={authorization:`Bearer ${env.token()}`};
  const plan=await env.ui.draft(env.author,{investigationId:env.actionSource.inv.id,resultVersion:1,targetId:501,impact:'SYNTHETIC 环回 SSH/helper；不连接生产目标'});
  const a=await env.plans.submit(env.author,{planId:plan.id,expectedVersion:plan.version});
  await env.plans.review(env.reviewer,{planId:plan.id,expectedVersion:plan.version,approvalId:a.approvalId,action:'approve',note:'Synthetic independent reviewer'});
  await page.addInitScript(({token,actor})=>{localStorage.setItem('token',token);localStorage.setItem('user',JSON.stringify({id:actor.userId}));localStorage.setItem('permissions',JSON.stringify(actor.permissions));},{token:env.token(),actor:env.author});
  await page.goto(`${env.url}/operations-actions?plan=${plan.id}`);const outcome=page.locator('operations-action-outcome');
  await outcome.getByRole('button',{name:'执行当前批准版本',exact:true}).click();
  await outcome.getByRole('button',{name:'确认执行一次',exact:true}).click();await expect(outcome).toContainText('已排队');
  const [execution]=await env.rows('SELECT id FROM action_executions WHERE plan_id=?',[plan.id]);expect(execution).toBeTruthy();
  const report=await env.runAction(execution.id);expect(report.state).toBe('passed');expect(env.sends()).toBe(1);
  await outcome.getByRole('button',{name:'只读刷新原执行',exact:true}).click();await expect(outcome).toContainText('验证通过');
  await outcome.getByRole('button',{name:'读取历史报告',exact:true}).click();await expect(outcome).toContainText('报告结论');await expect(outcome.locator('investigation-feedback')).toHaveCount(0);await outcome.getByRole('button',{name:'读取最新报告'}).click();
  await expect(outcome.locator('investigation-feedback')).toBeVisible();await accessibleControls(outcome);
  const feedback=outcome.locator('investigation-feedback');await feedback.getByLabel('记录类型',{exact:true}).selectOption('close');await feedback.getByLabel('业务问题状态',{exact:true}).selectOption('resolved');await feedback.getByRole('checkbox',{name:'使用当前效果报告'}).check();
  if(output)for(const width of [1600,1024,390])for(const theme of ['light','dark']){
    await page.setViewportSize({width,height:1000});await page.evaluate(t=>document.documentElement.dataset.themeMode=t,theme);
    await outcome.getByText('不可变效果报告与人工结案',{exact:true}).scrollIntoViewIfNeeded();await page.screenshot({path:resolve(output,`report-${width}-${theme}.png`)});
    await outcome.locator('investigation-feedback').scrollIntoViewIfNeeded();await page.screenshot({path:resolve(output,`feedback-${width}-${theme}.png`)});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  }
  await feedback.getByRole('checkbox',{name:'使用当前效果报告'}).check();await feedback.getByLabel('反馈与处理依据',{exact:true}).fill('SYNTHETIC 测试身份核对固定窗口报告，不代签真实业务批准');
  await feedback.getByRole('button',{name:'保存人工记录',exact:true}).click();
  await expect(outcome.getByRole('button',{name:'重新打开调查并使旧确认失效'})).toBeVisible();
  const candidate=await request.post(`${env.apiUrl}/api/operations/knowledge`,{headers,data:{investigationId:env.actionSource.inv.id,resultVersion:1,humanConfirmed:true,
    content:{title:'SYNTHETIC action lineage',symptoms:'Synthetic failure',faultType:'synthetic',confirmedCause:'Controlled helper observation',actions:'Loopback SSH/helper only',actualEffect:'Synthetic fixed-window health',counterexamples:'No production qualification'},
    applicability:{conditions:'Isolated test only',productVersion:'synthetic-v1',resourceVersion:'synthetic-v1'},validUntil:new Date(Date.now()+600000).toISOString()}});
  expect(candidate.status()).toBe(201);const item=await candidate.json();
  const submitted=await request.post(`${env.apiUrl}/api/operations/knowledge/${item.id}/submit`,{headers,data:{expectedRevision:item.revision}});expect(submitted.status()).toBe(200);
  const reviewed=await request.post(`${env.apiUrl}/api/operations/knowledge/${item.id}/review`,{headers:{authorization:`Bearer ${env.token(env.reviewer)}`},data:{expectedRevision:(await submitted.json()).revision,version:item.version,contentHash:item.contentHash,decision:'approved',note:'Synthetic independent case review'}});expect(reviewed.status()).toBe(200);
  expect((await (await request.get(`${env.apiUrl}/api/operations/knowledge/${item.id}`,{headers})).json()).content).toBeTruthy();
  await outcome.getByRole('button',{name:'重新打开调查并使旧确认失效'}).click();await expect(outcome).toContainText('调查已重开，原报告不能再用于确认恢复或结案');
  const stale=await request.get(`${env.apiUrl}/api/operations/knowledge/${item.id}`,{headers});expect((await stale.json()).tombstone).toBe(true);expect(await stale.json()).not.toHaveProperty('content');
  const current=await request.get(`${env.apiUrl}/api/investigations/${env.actionSource.inv.id}`,{headers});expect((await current.json()).problemStatus).toBe('unconfirmed');expect(env.sends()).toBe(1);
  if(output){for(const width of [1600,1024,390])for(const theme of ['light','dark']){await page.setViewportSize({width,height:1000});await page.evaluate(t=>document.documentElement.dataset.themeMode=t,theme);await page.screenshot({path:resolve(output,`outcome-${width}-${theme}.png`),fullPage:true});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);}}
  env.resetClock();
});

test('three resource details consume real relationship and baseline services; investigation uses live snapshots and human overrides',async({page})=>{
  page.setDefaultTimeout(15000);
  await page.addInitScript(({token,actor})=>{localStorage.setItem('token',token);localStorage.setItem('user',JSON.stringify({id:actor.userId}));localStorage.setItem('permissions',JSON.stringify(actor.permissions));localStorage.setItem('slide.control.settings.v1',JSON.stringify({locale:'zh-CN',navCollapsed:true}));},{token:env.token(),actor:env.author});
  const matrix=[];
  for(const [type,id,tab,param,tag] of [['instance',101,'instance-detail','id','instance-detail-page'],['server',501,'server-detail','id','server-detail'],['network_device',601,'network-device-detail','networkDeviceId','network-device-detail']] as const){
    await page.goto(`${env.url}/?tab=${tab}&${param}=${id}`);
    const detail=page.locator(tag);
    if(type==='network_device')await detail.getByRole('tab',{name:'关联资源',exact:true}).click();else await detail.getByRole('tab',{name:'概览',exact:true}).click();
    const relation=detail.locator('operations-resource-relations');await relation.locator('summary').click();await expect(relation).toContainText(/运行于|连接/);
    await expect(relation).not.toContainText('暂无可访问关系');
    if(output)await page.screenshot({path:resolve(output,`resource-${type}-relations.png`),fullPage:true});
    await detail.getByRole('tab',{name:'指标与趋势',exact:true}).click();
    const metrics=detail.locator('semantic-metrics');await expect(metrics).toContainText('行为基线');
    await metrics.locator('details').filter({hasText:'行为基线'}).locator('summary').first().click();
    const select=metrics.getByLabel('基线指标与维度');await select.selectOption({index:1});
    const baseline=metrics.locator('operations-behavior-baseline');await baseline.getByRole('button',{name:'评估此指标基线'}).click();await expect(baseline).toContainText('可提供比较');
    await accessibleControls(metrics);
    for(const width of [1600,1024,390])for(const theme of ['light','dark']){await page.setViewportSize({width,height:1000});await page.evaluate(t=>document.documentElement.dataset.themeMode=t,theme);expect(await baseline.evaluate(e=>e.scrollWidth<=e.clientWidth+1)).toBe(true);if(output){await baseline.scrollIntoViewIfNeeded();await page.screenshot({path:resolve(output,`resource-${type}-baseline-${width}-${theme}.png`)});}matrix.push({type,width,theme,source:'synthetic observation windows; real baseline store/HTTP/MySQL and product detail'});}
  }
  await page.goto(`${env.url}/investigations?investigation=${env.source.inv.id}`);
  const context=page.locator('investigation-operation-context');await expect(context).toBeVisible();await context.getByRole('button',{name:'评估当前关联事项'}).click();await expect(context).toContainText('关联事件');
  await context.getByLabel('人工关联或拆分依据').fill('SYNTHETIC 人工核对两个独立事件');await context.getByRole('button',{name:'人工拆分为独立事件'}).click();await expect(context.getByText('1 个关联事件',{exact:false})).toHaveCount(2);
  await context.getByLabel('人工关联或拆分依据').fill('SYNTHETIC 人工确认共同处理窗口');await context.getByRole('button',{name:'人工关联当前全部事件'}).click();await expect(context).toContainText('2 个关联事件');await accessibleControls(context);
  const snapshots=await env.rows('SELECT version FROM attention_correlation_snapshots');expect(snapshots.length).toBeGreaterThanOrEqual(3);
  if(output){await page.screenshot({path:resolve(output,'investigation-context-override.png'),fullPage:true});await writeFile(resolve(output,'resource-context-matrix.json'),JSON.stringify({matrix,investigation:'real authenticated WS transport harness + live SQL snapshot domain; formal adapter composition deferred to P11',overrides:'real AttentionStore immutable versions, split and merge',automatedAccessibility:'visible button names; native labelled inputs; keyboard dialog in approval flow; no full WCAG claim'},null,2));}
});

for(const reason of ['withdrawn','expired'] as const)test(`opened case clears immediately on real ${reason} without refresh`,async({page})=>{
  const item=await publishSynthetic(`SYNTHETIC ${reason} stream`);
  await page.addInitScript(({token,actor})=>{localStorage.setItem('token',token);localStorage.setItem('user',JSON.stringify({id:actor.userId}));localStorage.setItem('permissions',JSON.stringify(actor.permissions));},{token:env.token(),actor:env.author});
  await page.goto(`${env.url}/operations-knowledge?case=${item.id}`);const view=page.locator('operations-knowledge');await expect(view).toContainText(item.content!.confirmedCause);
  if(reason==='withdrawn')await env.knowledge.withdraw(env.author,item.id,{expectedRevision:item.revision,reason:'Synthetic invalidation'});
  else await env.rows('UPDATE trusted_case_versions SET valid_until=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 1 SECOND) WHERE case_id=?',[item.id]);
  await expect(view).not.toContainText(item.content!.confirmedCause,{timeout:10000});await expect(view).toContainText('正文已清除');
  if(output)await page.screenshot({path:resolve(output,`live-${reason}.png`),fullPage:true});
});

test('queued cancellation and unknown receipt reconciliation use original execution and never resend',async({page})=>{
  const before=env.sends();
  await page.addInitScript(({token,actor})=>{localStorage.setItem('token',token);localStorage.setItem('user',JSON.stringify({id:actor.userId}));localStorage.setItem('permissions',JSON.stringify(actor.permissions));},{token:env.token(),actor:env.author});
  for(const mode of ['cancel','unknown']) {
    const plan=await env.ui.draft(env.author,{investigationId:env.actionSource.inv.id,resultVersion:1,targetId:501,impact:`SYNTHETIC ${mode}; no real resource action`});
    const approval=await env.plans.submit(env.author,{planId:plan.id,expectedVersion:1});
    await env.plans.review(env.reviewer,{planId:plan.id,expectedVersion:1,approvalId:approval.approvalId,action:'approve',note:'Synthetic independent review'});
    await page.goto(`${env.url}/operations-actions?plan=${plan.id}`);const outcome=page.locator('operations-action-outcome');
    await outcome.getByRole('button',{name:'执行当前批准版本',exact:true}).click();await outcome.getByRole('button',{name:'确认执行一次',exact:true}).click();await expect(outcome).toContainText('已排队');
    const [execution]=await env.rows('SELECT id FROM action_executions WHERE plan_id=?',[plan.id]);
    if(mode==='cancel'){await outcome.getByRole('button',{name:'申请取消原执行'}).click();await expect(outcome).toContainText('已取消');expect(env.sends()).toBe(before);}
    else {
      await env.dispatchUnknown(execution.id);await outcome.getByRole('button',{name:'只读刷新原执行'}).click();await expect(outcome).toContainText('发送结果未知不等于未执行或已取消');
      await outcome.getByRole('button',{name:'核对原回执（不重发）'}).click();await expect(outcome).toContainText('执行成功');
      await outcome.getByRole('button',{name:'只读刷新原执行'}).click();await expect(outcome).toContainText('执行成功');
      expect(await env.helperRestarts()).toBe(1);
      expect(env.sends()).toBe(before+1);expect((await env.rows('SELECT id FROM action_executions WHERE plan_id=?',[plan.id]))).toHaveLength(1);
      if(output)await page.screenshot({path:resolve(output,'outcome-unknown-reconcile.png')});
    }
  }
});
