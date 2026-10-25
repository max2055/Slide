import { test, expect, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { INVESTIGATION_PROFILES, investigationProfileHash } from '../../apps/db-ops-api/src/investigations/profiles.js';

const output = process.env.MAX157_OUTPUT_DIR ?? 'test-results/max157-ui-acceptance';
const policy = { currency:'USD',maxConcurrent:4,manualReserved:1,maxPerResourceConcurrent:1,maxAutomaticRequestsPerHour:60,maxAutomaticTokensPerDay:500000,maxTotalTokensPerDay:1000000,maxCostMicrosPerDay:10000000 };
const admissionPolicy = { maxConcurrent:4,manualReserved:1,maxPerResourceConcurrent:1,maxAutomaticRequestsPerHour:60,maxAutomaticTokensPerDay:500000,maxTotalTokensPerDay:1000000,maxCostMicrosPerDay:10000000 };
const group = { state:'settled',mode:'manual',currency:'USD',count:2,knownUsageCount:2,unknownUsageCount:0,pendingUsageCount:0,knownInputTokens:12000,knownCachedInputTokens:4000,knownOutputTokens:6000,reservedTokens:64000,outstandingTokens:0,settledTokens:18000,reservedCostMicros:200000,outstandingCostMicros:0,estimatedSettledCostMicros:140000,unknownCostCount:0 };
const groups = [group,{...group,state:'unknown',knownUsageCount:0,unknownUsageCount:2,knownInputTokens:0,knownCachedInputTokens:0,knownOutputTokens:0,settledTokens:0,outstandingTokens:64000,outstandingCostMicros:200000,estimatedSettledCostMicros:0},...Array.from({length:4},(_,i) => ({...group,currency:i % 2 ? 'EUR':'USD',state:['sent','reserved','cancelled','settled'][i]}))];
const manifest = {releaseId:'source-acceptance',commitSha:'8bdd8a3c09ae5d9f5e5436f6f26153bdcddb6737',treeDigest:'a'.repeat(64),signature:'acceptance-signature',repository:{origin:'https://github.com',ref:'main'},completeness:'partial',verification:{status:'repository-unbound',reason:'SOURCE_DEPLOYMENT_UNKNOWN'},files:Array.from({length:1971},(_,i) => ({path:`packages/agent-core/src/collectors/group-${Math.floor(i/50)+1}/resource-collector-${i+1}.ts`,bytes:1248+i*13,digest:'b'.repeat(64)})),skippedFiles:Array.from({length:123},(_,i) => ({path:`config/group-${i+1}/config-${i+1}.json`,reason:i % 2 ? 'SOURCE_BINARY_FILE':'SOURCE_SYMLINK_SKIPPED'})),warnings:[{path:'src/retained.ts',reason:'SOURCE_LARGE_FILE'}]};

async function fixture(page: Page, mode = 'normal', theme = 'dark', accent = '#409eff') {
  let calls = 0;
  await page.addInitScript(({theme,accent}) => {
    localStorage.setItem('token','controlled-acceptance-token');localStorage.setItem('refreshToken','controlled-refresh');
    localStorage.setItem('slide.control.session_token.v1','controlled-acceptance-token');localStorage.setItem('permissions','["*"]');
    localStorage.setItem('slide.i18n.locale','zh-CN');
    localStorage.setItem('app-theme-mode',theme);
    localStorage.setItem('slide.control.settings.v1:default',JSON.stringify({locale:'zh-CN',themeMode:theme,accentColor:accent,navCollapsed:false}));
  },{theme,accent});
  await page.routeWebSocket('**/agent-ws',socket => socket.onMessage(message => { if(JSON.parse(String(message)).type === 'auth') socket.send(JSON.stringify({type:'auth_ok'})); }));
  await page.route('**/api/**',async route => {
    const url = new URL(route.request().url()), path = url.pathname;
    if (!path.startsWith('/api/')) return route.fallback();
    let body: unknown = {};
    if (path === '/api/auth/permissions') body = ['*'];
    if (path === '/api/user/preferences') body = {preferences:{locale:'zh-CN',themeMode:theme,accentColor:accent}};
    if (path === '/api/platform/source/config') body = {config:{provider:'github',baseUrl:'https://github.com',repositoryPath:'slide/acceptance',allowedPaths:[],allowModelContent:false}};
    if (path === '/api/platform/source/manifest') body = manifest;
    if (path === '/api/investigation-profiles') body = {items:Object.values(INVESTIGATION_PROFILES).map(profile => ({profile,profileHash:investigationProfileHash(profile),toolAvailability:'not_evaluated',outputSchemaId:'InvestigationResult'}))};
    if (path === '/api/investigation-policies') body = {configurationStatus:mode === 'empty'?'not_configured':'configured',integrationStatus:mode === 'empty'?'not_connected':'connected',source:'production_composition',originBoundary:'investigation_engine_persist_only',items:mode === 'empty'?[]:[{id:'database-alert-pilot',version:1,enabled:false}]};
    if (path === '/api/investigation-budget') body = {source:'investigationBudgetConfiguration',policy,reserveCostMicros:100000,persistedPolicy:mode === 'empty'?null:{...policy,maxTotalTokensPerDay:mode === 'conflict'?800000:policy.maxTotalTokensPerDay},admissionStatus:mode === 'empty'?'uninitialized':mode === 'conflict'?'conflict':'matching',automaticTriggerStatus:'connected',domain:'investigation-v1',admissionRevision:1,policySource:'configuration'};
    if (path === '/api/investigation-budget/effective') {
      const runtime = {contextWindowTokens:1000000,outputTokens:16384,summaryOutputTokens:16384,maxExecutionTokens:1000000};
      const profileLimits = {deadlineMs:600000,maxToolCalls:36,maxProviderAttempts:8,maxRows:200,maxBytes:128000,maxWindowMs:3600000};
      const admission = {revision:1,policy:admissionPolicy};
      body = {schemaVersion:1,source:mode === 'empty'?'defaults':'settings',
        effective:{schemaVersion:1,version:mode === 'empty'?0:3,runtime,profileLimits,admission,updatedAt:'2026-10-25T00:00:00.000Z'},
        defaults:{schemaVersion:1,version:0,runtime,profileLimits,admission,updatedAt:'2026-10-25T00:00:00.000Z'},
        provider:{model:'controlled-model',contextWindowTokens:1000000,maxOutputTokens:393216,preferredOutputTokens:393216,source:'configuration'},
        capabilityVerified:true,
        admission:{domain:'investigation-v1',revision:1,source:mode === 'empty'?'defaults':'settings'}};
    }
    if (path === '/api/investigation-usage') { const offset = Number(url.searchParams.get('offset') ?? 0),limit = Number(url.searchParams.get('limit') ?? 20); body = {total:mode === 'empty'?0:12,groupCount:mode === 'empty'?0:6,counts:{reserved:2,sent:2,settled:4,unknown:2,cancelled:2},knownUsageCount:4,unknownUsageCount:2,pendingUsageCount:2,reservedTokens:384000,outstandingTokens:192000,settledTokens:36000,costs:mode === 'empty'?[]:[{currency:'USD',reservedCostMicros:1200000,outstandingCostMicros:600000,estimatedSettledCostMicros:280000}],items:mode === 'empty'?[]:groups.slice(offset,offset+limit),nextOffset:mode !== 'empty' && offset+limit<groups.length?offset+limit:null}; }
    if (path === '/api/resources') body = {items:[{resource:{type:'instance',id:1},label:'订单数据库',status:'online',attributes:{}}]};
    if (path.endsWith('/evidence')) body = {generatedAt:new Date().toISOString(),facts:mode === 'empty'?[]:Array.from({length:4},(_,i) => ({id:`evidence-${i}`,kind:'observation',status:'fact',quality:i===3?'degraded':'good',observedAt:i===3?'2020-01-01T00:00:00Z':new Date().toISOString(),validUntil:i===3?'2020-01-01T01:00:00Z':new Date(Date.now()+300000).toISOString(),source:'metrics',correlationId:'controlled-correlation',payload:{metricId:['cpu','disk_usage','connections','memory_usage'][i],value:i===3?null:[92.4,57.1,410][i]}})),inferences:[],hypotheses:[],gaps:mode === 'empty'?['OBSERVATIONS_EMPTY']:['EVIDENCE_STALE'],truncated:mode==='truncated'};
    if (path.endsWith('/diagnose-agent')) { calls++;body={analysisId:42,status:'queued'}; }
    if (path.includes('/analyses/')) body={analysisId:42,status:mode === 'unknown'?'unknown':mode==='running'?'running':'completed',createdAt:new Date().toISOString(),completedAt:new Date().toISOString(),result:{verification:'partial',evidenceSnapshot:{collectedAt:'2026-10-01T08:00:00Z'},conclusions:['CPU 超出配置范围，根因待人工验证'],recommendations:[{action:'核对采集来源与业务负载'}]}};
    if (path.endsWith('/evaluation')) body={rulesVersion:1,generatedAt:new Date().toISOString(),invariants:[],expectations:[],gaps:['MISSING_INPUT']};
    if (mode === 'empty' && path === '/api/investigation-profiles') body={items:[]};
    const affected = /\/api\/investigation-|\/api\/platform\/source\/manifest|\/evidence$/.test(path);
    if (mode === 'loading' && affected) await new Promise(resolve => setTimeout(resolve,1500));
    if (affected && ['failed','forbidden'].includes(mode)) return route.fulfill({status:mode==='failed'?503:403,json:{error:'SOURCE_READ_FORBIDDEN'}});
    await route.fulfill({json:body});
  });
  return () => calls;
}
async function capture(page: Page, name: string) {
  await mkdir(output,{recursive:true});
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({path:`${output}/${name}.png`,fullPage:true});
}
for (const width of [1280,390]) for (const theme of ['dark','light']) {
  test(`R2 six product pages at ${width}px ${theme}`,async ({page}) => {
    const errors: string[]=[];page.on('pageerror',error => { errors.push(error.message); console.error('Acceptance page error:',error.message); });
    await page.setViewportSize({width,height:950});await fixture(page,'normal',theme);
    const pages = [['source','/settings/platform/source','source-settings'],['profiles','/settings/ai/profiles','investigation-profiles-page'],['policies','/settings/ai/policies','investigation-governance-page'],['budget','/settings/ai/budget','investigation-governance-page'],['usage','/settings/ai/usage','investigation-governance-page'],['diagnosis','/resource-diagnosis?resourceType=instance&resourceId=1','resource-diagnosis-page']];
    for (const [name,path,selector] of pages) {
      await page.goto(path);await expect(page.locator('html')).toHaveAttribute('data-theme-mode',theme);await expect(page.locator(selector).getByRole('heading').first()).toBeVisible();
      await expect(page.locator(selector).locator('app-data-table').first()).toBeVisible();
      await capture(page,`${name}-${width}-${theme}-controlled`);
      if(name === 'profiles') {
        const button=page.getByRole('button',{name:'查看资源调查 V1 预置详情 →',exact:true});await button.click();
        await expect(page.locator('app-dialog').filter({has:page.locator('dialog[open]')})).toContainText('执行限制');await capture(page,`profile-dialog-${width}-${theme}`);
        await page.keyboard.press('Escape');await expect(button).toBeFocused();
      }
      if(name === 'diagnosis') {
        const button=page.getByRole('button',{name:'查看证据 evidence-0'});await button.click();await expect(page.locator('app-dialog').filter({has:page.locator('dialog[open]')})).toContainText('观测时间');
        await page.keyboard.press('Escape');await expect(button).toBeFocused();
      }
    }
    expect(errors).toEqual([]);
  });
}
test('snapshot large list uses bounded paging, filters, deep links and metadata focus restoration',async ({page}) => {
  await fixture(page);await page.goto('/settings/platform/source');
  const view=page.locator('source-manifest');await expect(view).not.toContainText(manifest.files[0].path);
  await view.getByRole('button',{name:'浏览快照 →'}).click();await expect(page).toHaveURL(/sourceView=details/);
  await expect(view.locator('tbody tr')).toHaveCount(10);await view.getByRole('button',{name:'下一页',exact:true}).click();await expect(page).toHaveURL(/sourcePage=1/);
  await view.getByRole('searchbox').fill('resource-collector-1971.ts');await expect(view.locator('tbody tr')).toHaveCount(1);await expect(page).toHaveURL(/sourcePage=0/);
  await page.reload();await expect(view.getByRole('searchbox')).toHaveValue('resource-collector-1971.ts');
  await view.getByRole('button',{name:'查看',exact:true}).click();await expect(view.locator('app-dialog').filter({has:page.locator('dialog[open]')})).toContainText('文件摘要');await page.keyboard.press('Escape');await expect(view.getByRole('button',{name:'查看',exact:true})).toBeFocused();
  await view.getByRole('searchbox').fill('no-matching-path');await expect(view).toContainText('没有匹配的条目');await expect(view.getByRole('button',{name:'下一页',exact:true})).toBeDisabled();
  await view.getByRole('tab',{name:/已跳过/}).click();await view.getByRole('combobox',{name:'筛选原因'}).selectOption('SOURCE_SYMLINK_SKIPPED');await expect(view).toContainText('符号链接');
  await view.getByRole('combobox',{name:'每页文件数'}).selectOption('25');await expect(view.locator('tbody tr')).toHaveCount(25);
  await view.getByRole('button',{name:'下一页',exact:true}).click();await view.getByRole('button',{name:'返回源码仓库'}).click();await expect(view).not.toContainText('config/group-51');
  await page.goBack();await expect(view.getByRole('combobox',{name:'每页文件数'})).toHaveValue('25');await expect(view).toContainText('2 / 3');
  await capture(page,'source-detail-1280-dark-controlled');
  const meta=view.getByRole('button',{name:'版本元数据',exact:true});await meta.click();await expect(view.locator('app-dialog').filter({has:page.locator('dialog[open]')})).toContainText(manifest.commitSha);await page.keyboard.press('Escape');await expect(meta).toBeFocused();
});
for (const mode of ['empty','failed','forbidden','loading','conflict','unknown','running','truncated']) test(`controlled state ${mode}`,async ({page}) => {
  await fixture(page,mode);await page.setViewportSize({width:390,height:950});
  const path=['unknown','running','truncated'].includes(mode)?`/resource-diagnosis?resourceType=instance&resourceId=1${mode==='truncated'?'':'&analysisId=42'}`:mode==='conflict'?'/settings/ai/budget':'/settings/ai/usage';
  await page.goto(path);
  if(mode==='unknown') { await expect(page.locator('[data-task-status]')).toContainText('结果未知');await expect(page.getByRole('button',{name:'开始只读诊断',exact:true})).toBeDisabled(); }
  else if(mode==='running') await expect(page.locator('[data-task-status]')).toContainText('运行中');
  else if(mode==='truncated') await expect(page.getByRole('status').filter({hasText:'返回证据已截断'})).toBeVisible();
  else if(mode==='loading') await expect(page.getByRole('status').filter({hasText:'正在加载调查设置'})).toBeVisible();
  else if(mode==='conflict') await expect(page.getByRole('alert')).toContainText('冲突');
  else if(mode==='empty') await expect(page.getByText('暂无持久用量',{exact:true})).toBeVisible();
  else await expect(page.getByRole('alert')).toBeVisible();
  await capture(page,`${mode}-390-dark-controlled`);
});
test('saved emphasis color and usage unknown detail do not imply measured zero',async ({page}) => {
  await fixture(page,'normal','dark','#8b7cf8');await page.goto('/settings/ai/usage');
  await page.locator('[data-usage-group="USD/unknown/manual"]').click();await expect(page.locator('app-dialog').filter({has:page.locator('dialog[open]')})).toContainText('未计量');await capture(page,'usage-unknown-detail-violet');
  await page.keyboard.press('Escape');await page.getByRole('combobox',{name:'每页分组'}).selectOption('5');await expect(page.locator('[data-usage-group]')).toHaveCount(5);await page.getByRole('button',{name:'下一组页'}).click();await expect(page.locator('[data-usage-group]')).toHaveCount(1);
});
for (const mode of ['empty','loading','failed','forbidden']) test(`all four governance pages: ${mode}`,async ({page}) => {
  await fixture(page,mode); await page.setViewportSize({width:390,height:950});
  for (const kind of ['profiles','policies','budget','usage']) {
    await page.goto(`/settings/ai/${kind}`);
    const view = page.locator(kind === 'profiles' ? 'investigation-profiles-page' : 'investigation-governance-page');
    if (mode === 'loading') await expect(view.getByRole('status')).toContainText('正在加载');
    else if (mode === 'empty') await expect(view).toContainText({profiles:'尚未配置 Profiles',policies:'尚未配置调查策略',budget:'尚未初始化冻结预算',usage:'暂无持久用量'}[kind]!);
    else { await expect(view.getByRole('alert')).toBeVisible(); await expect(view.locator('app-data-table')).toHaveCount(0); }
    await capture(page,`${kind}-${mode}-390-dark-controlled`);
  }
});
