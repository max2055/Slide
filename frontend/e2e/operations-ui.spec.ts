import { test, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startOperationsServer } from './fixtures/operations-server.ts';

let env:Awaited<ReturnType<typeof startOperationsServer>>;
const output=process.env.MAX202_OUTPUT_DIR;
test.skip(!process.env.MAX202_MYSQL_PORT,'Requires a task-owned isolated MySQL via MAX202_MYSQL_PORT');
test.beforeAll(async()=>{env=await startOperationsServer();});
test.afterAll(async()=>{await env?.close();});
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
  const date=new Date(Date.now()+1800000);const validUntil=new Date(+date-date.getTimezoneOffset()*60000).toISOString().slice(0,23);
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
  await expect(view).toContainText('已批准');
  if(output)for(const width of [1600,1024,390])for(const theme of ['light','dark']){
    await reviewer.setViewportSize({width,height:1000});await reviewer.evaluate(theme=>document.documentElement.dataset.themeMode=theme,theme);
    await expect(view).toContainText('执行入口尚未接入当前服务');
    await reviewer.screenshot({path:resolve(output,`plan-${width}-${theme}.png`),fullPage:true});
  }
  await own.getByRole('button',{name:'刷新原计划',exact:true}).click();
  await own.getByRole('button',{name:'编辑为新计划版本',exact:true}).click();
  await own.getByLabel('预计影响',{exact:true}).fill('SYNTHETIC 新版本影响说明，不发送目标动作');
  await own.getByRole('button',{name:'保存新计划版本',exact:true}).click();await expect(own).toContainText('v2');
  const [old]=await env.rows('SELECT state FROM action_plan_versions WHERE plan_id=? AND version=1',[env.plan.id]);expect(old.state).toBe('superseded');
  const [count]=await env.rows('SELECT COUNT(*) n FROM action_executions');expect(Number(count.n)).toBe(0);
  if(output)await writeFile(resolve(output,'plan-evidence.json'),JSON.stringify({source:'synthetic environment; real source ACL/MySQL/JWT/HTTP/PlanService',planId:env.plan.id,oldState:old.state,newVersion:2,externalActions:0,productModelCalls:0,keyboard:'native modal Esc and focus restoration passed',limitations:['No real environment qualification','Dispatch and verification HTTP composition pending P11']},null,2));
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
  if(output){await page.screenshot({path:resolve(output,'controlled-revoked-390.png'),fullPage:true});await writeFile(resolve(output,'controlled-state-evidence.json'),JSON.stringify({source:'explicit HTTP interception; supplements real service tests, not backend acceptance',states:['loading','empty','503 failure','expired tombstone','403 revoked','503 mutation unknown'],writeRequests:writes,densityEvidence,accessibleNames:'visible operations page buttons checked; modal keyboard/focus in real approval test',limitations:['No full axe/WCAG conformance claim','Resource context browser matrix remains pending']},null,2));}
});
