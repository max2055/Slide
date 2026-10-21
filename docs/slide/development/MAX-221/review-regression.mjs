// Read-only shared API, existing authorized session, isolated frontend. No model calls.
// Required: MAX221_SESSION_FILE, MAX221_OUTPUT_DIR, SLIDE_SOURCE_ROOT.
// Never include the session file or private service logs in a delivery archive.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding:'utf8' }).trim();
const out = process.env.MAX221_OUTPUT_DIR;
assert(out && process.env.MAX221_SESSION_FILE && process.env.SLIDE_SOURCE_ROOT, 'Required environment missing');
fs.mkdirSync(out, { recursive:true });
const req = createRequire(path.join(root, 'frontend/package.json'));
const apiReq = createRequire(path.join(process.env.SLIDE_SOURCE_ROOT, 'apps/db-ops-api/package.json'));
const { chromium, expect } = req('@playwright/test');
const saved = JSON.parse(fs.readFileSync(process.env.MAX221_SESSION_FILE, 'utf8'));
const token = saved.origins.flatMap(o => o.localStorage).find(s => s.name === 'token')?.value;
assert(token, 'Existing session unavailable');
const base = 'http://127.0.0.1:5223';
const receipt = { sha:execFileSync('git', ['rev-parse', 'HEAD'], {encoding:'utf8'}).trim(),
  startedAt:new Date().toISOString(), source:'shared API 3000; isolated frontend 5223', productModelCalls:0,
  captures:[], interactions:[], requests:[], blockedWrites:[], errors:[], contrast:[] };
const save = () => fs.writeFileSync(path.join(out, 'receipt.json'), JSON.stringify(receipt, null, 2));
let service, browser, db;
const pause = ms => new Promise(r => setTimeout(r, ms));
async function until(fn) { const end=Date.now()+30000; while(Date.now()<end) { if(await fn()) return; await pause(200); } throw Error('READINESS_TIMEOUT'); }
async function text(page, name, selector) {
 const data=await page.locator(selector).first().evaluate(el => {
  const read=n => n.nodeType===Node.TEXT_NODE ? n.textContent : n.matches?.('style,script') ? '' : [...(n.shadowRoot??n).childNodes].map(read).join('\n');
  return read(el);
 }); fs.writeFileSync(path.join(out,name+'.txt'),data);
}
async function settle(page, mode) {
 // Theme rendering only: no preference API writes, no changes to the source account.
 await page.evaluate(async mode => {
  const root=document.documentElement; root.dataset.themeMode=mode; root.style.colorScheme=mode;
  const roots=[document]; for(let i=0;i<roots.length;i++) for(const el of roots[i].querySelectorAll('*')) {
   if(el.updateComplete) await el.updateComplete; if(el.shadowRoot) roots.push(el.shadowRoot); el._chart?.resize();
  }
  await document.fonts.ready;
 },mode);
 const toggle=page.locator('.topbar-nav-toggle');
 if(await toggle.getAttribute('aria-expanded')==='true') await toggle.click();
 await pause(500);
}
async function shot(page,name) {
 await page.screenshot({path:path.join(out,name+'.png'),animations:'disabled'});
 receipt.captures.push({name,url:page.url(),width:page.viewportSize().width,theme:await page.evaluate(()=>document.documentElement.dataset.themeMode),
  overflow:await page.evaluate(()=>({viewport:innerWidth,scroll:document.documentElement.scrollWidth}))}); save();
}
async function matrix(page,name,selector) {
 for(const width of [1440,768,375]) for(const mode of ['light','dark']) {
  await page.setViewportSize({width,height:1000}); await settle(page,mode);
  if(selector) await page.locator(selector).first().scrollIntoViewIfNeeded(); await shot(page,`${name}-${width}-${mode}`);
 }
}
async function measure(locator) {
 return locator.evaluate(el=>{
  const canvas=document.createElement('canvas');canvas.width=canvas.height=1;const ctx=canvas.getContext('2d');
  const rgb=s=>{ctx.clearRect(0,0,1,1);ctx.fillStyle=s;ctx.fillRect(0,0,1,1);const v=[...ctx.getImageData(0,0,1,1).data];return [v[0],v[1],v[2],v[3]/255];};
  const blend=(a,b)=>[0,1,2].map(i=>a[i]*(a[3]??1)+b[i]*(1-(a[3]??1)));
  const ancestors=[]; let e=el; while(e) { ancestors.push(e);e=e.assignedSlot??e.parentElement??e.getRootNode()?.host; }
  let bg=[255,255,255]; for(const n of ancestors.reverse()) bg=blend(rgb(getComputedStyle(n).backgroundColor),bg);
  const lum=c=>c.map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((s,v,i)=>s+v*[.2126,.7152,.0722][i],0);
  const ratio=(a,b)=>(Math.max(lum(a),lum(b))+.05)/(Math.min(lum(a),lum(b))+.05);
  const s=getComputedStyle(el);return {text:el.textContent.trim().slice(0,60),background:bg,color:s.color,outline:s.outline,focused:el.matches(':focus-visible'),
   textContrast:ratio(blend(rgb(s.color),bg),bg),outlineContrast:ratio(blend(rgb(s.outlineColor),bg),bg)};
 });
}
try {
 // Count and filter against the actual consumer SQL in one read-only consistent snapshot.
 const cfg=apiReq('dotenv').parse(fs.readFileSync(path.join(process.env.SLIDE_SOURCE_ROOT,'apps/db-ops-api/.env')));
 db=await apiReq('mysql2/promise').createConnection({host:cfg.DB_HOST,port:Number(cfg.DB_PORT||3306),user:cfg.DB_USER,password:cfg.DB_PASSWORD,database:cfg.DB_NAME,dateStrings:true,timezone:'Z'});
 await db.query('SET SESSION TRANSACTION READ ONLY');await db.query('START TRANSACTION WITH CONSISTENT SNAPSHOT');
 const [[counts]]=await db.query('SELECT COUNT(*) AS count,MIN(observed_at) AS first,MAX(observed_at) AS last,UTC_TIMESTAMP(3) AS checked_at FROM metric_publications');
 const formal=fs.readFileSync(path.join(root,'apps/db-ops-api/src/metrics/rollout/formal-store.ts'),'utf8').match(/const formal = `([\s\S]*?)`;/)[1];
 const [groups]=await db.query(`SELECT r.resource_type,r.resource_id,JSON_UNQUOTE(JSON_EXTRACT(o.payload,'$.metric.id')) AS metric_id,COUNT(*) AS count,MIN(p.observed_at) AS first,MAX(p.observed_at) AS last ${formal} GROUP BY 1,2,3`);
 const [[inv]]=await db.query('SELECT id FROM investigations LIMIT 1');
 receipt.publications={target:'source platform DB from authorized environment (connection credentials withheld)',counts,filter:'exact formal-store.ts predicates',groups};
 await db.rollback();await db.end();db=null;save();
 const auth=await fetch('http://127.0.0.1:3000/api/user/preferences',{headers:{Authorization:'Bearer '+token}});
 assert.equal(auth.status,200,'Existing source session must authenticate');
 const fd=fs.openSync(path.join(root,'.multica/MAX-221-review/frontend.private.log'),'w',0o600);
 service=spawn(process.execPath,['node_modules/vite/bin/vite.js','--host','127.0.0.1','--port','5223','--strictPort'],{cwd:path.join(root,'frontend'),env:{...process.env,VITE_API_PROXY_TARGET:'http://127.0.0.1:3000',VITE_AGENT_WS_PROXY_TARGET:'http://127.0.0.1:28888'},stdio:['ignore',fd,fd]});fs.closeSync(fd);
 receipt.service={pid:service.pid,port:5223,cwd:path.join(root,'frontend'),command:'node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5223 --strictPort',sha:receipt.sha,log:'.multica/MAX-221-review/frontend.private.log'};save();
 await until(async()=>{if(service.exitCode!==null) throw Error('VITE_EXIT');try{return(await fetch(base)).ok;}catch{return false;}});
 browser=await chromium.launch({headless:true});const context=await browser.newContext({viewport:{width:1440,height:1000},locale:'zh-CN'});
 await context.addInitScript(token=>{localStorage.setItem('token',token);localStorage.setItem('slide.i18n.locale','zh-CN');},token);
 await context.route('**/api/**',route=>{
  const r=route.request(),p=new URL(r.url()).pathname;
  if(!['GET','HEAD','OPTIONS'].includes(r.method())&&!['/api/metrics/query','/api/auth/refresh','/api/platform/frontend-events','/api/device/register'].includes(p)) {
   receipt.blockedWrites.push({method:r.method(),path:p});return route.abort('blockedbyclient');
  }return route.continue();
 });
 const page=await context.newPage();page.on('pageerror',e=>receipt.errors.push(e.message));
 page.on('response',r=>{const p=new URL(r.url()).pathname;if(p.startsWith('/api/'))receipt.requests.push({path:p,method:r.request().method(),status:r.status()});});
 const run=async(name,fn)=>{try{await fn();receipt.interactions.push({name,passed:true});}catch(e){receipt.interactions.push({name,passed:false,reason:e.message});await shot(page,'failure-'+name);}save();};
 await run('investigation',async()=>{
  await page.goto(`${base}/investigations?investigation=${inv.id}`);
  await expect(page.locator('.investigation-result-summary')).toBeVisible({timeout:30000});
  await text(page,'investigation','investigations-page');await shot(page,'investigation-natural-entry');
  await matrix(page,'investigation-summary','.workspace-main app-card');
  const first=page.locator('.workspace-main app-card').first();
  await expect(first).toContainText('停止原因');await expect(first).toContainText('下一步');
  await expect(first.locator('details[aria-label="调查目标"]')).not.toHaveAttribute('open');
  for(const width of [768,375]) {
   await page.setViewportSize({width,height:1000});await settle(page,'light');
   const goal=first.locator('details[aria-label="调查目标"] summary');await goal.focus();await page.keyboard.press('Enter');await expect(first.locator('details[aria-label="调查目标"]')).toHaveAttribute('open');await page.keyboard.press('Enter');
   const button=page.getByRole('button',{name:'查看完整结果与证据',exact:true});await button.focus();
   const position=await page.evaluate(()=>({page:scrollY,list:document.querySelector('.investigation-list')?.scrollTop}));
   await page.keyboard.press('Enter');await expect(page.getByRole('dialog',{name:'证据与成果'})).toBeVisible();await shot(page,`investigation-evidence-${width}`);
   await page.keyboard.press('Escape');await expect(button).toBeFocused();
   assert.deepEqual(await page.evaluate(()=>({page:scrollY,list:document.querySelector('.investigation-list')?.scrollTop})),position);
   const process=page.locator('summary').filter({hasText:/^执行过程与技术详情$/});await process.focus();await page.keyboard.press('Enter');await shot(page,`investigation-process-${width}`);await page.keyboard.press('Enter');
  }
 });
 await run('packages',async()=>{
  await page.goto(base+'/settings/monitoring/metrics?view=packages');await expect(page.locator('metric-settings')).toBeVisible();
  await page.getByLabel('兼容性参考资源',{exact:true}).selectOption('instance:1');
  await page.evaluate(async()=>{const {applyAccentColor}=await import('/src/app/ui/app-settings.ts');applyAccentColor('#265f99');});
  const row=page.locator('metric-settings tbody tr').filter({has:page.getByText('MySQL 基础采集',{exact:true})});
  await expect(row).toContainText('已验证兼容');await expect(row).toContainText('可见资源绑定');await expect(row).not.toContainText('正在读取可见资源绑定数');
  await text(page,'packages','metric-settings');await matrix(page,'package-overview','metric-settings tbody tr:has-text("MySQL 基础采集")');
  for(const mode of ['light','dark']) {
   await page.setViewportSize({width:375,height:1000});await settle(page,mode);
   const region=page.getByRole('region',{name:'采集模板目录'});assert(await region.evaluate(el=>el.scrollWidth<=el.clientWidth));
   const button=row.getByRole('button',{name:'查看模板',exact:true});await button.scrollIntoViewIfNeeded();await button.focus();await page.keyboard.press('Tab');await page.keyboard.press('Shift+Tab');
   const sample=await measure(button);receipt.contrast.push({mode,...sample});assert(sample.focused&&sample.outlineContrast>=3&&sample.textContrast>=4.5);
   await shot(page,`template-focus-${mode}`);
   await page.keyboard.press('Enter');await expect(page.getByRole('dialog',{name:'采集模板详情'})).toBeVisible();await shot(page,`template-detail-375-${mode}`);await page.keyboard.press('Escape');await expect(button).toBeFocused();
  }
  await row.locator('.version-list > summary').focus();await page.keyboard.press('Enter');
  const old=row.getByRole('button',{name:'查看 MySQL 基础采集 1.0.0',exact:true});await old.click();
  await expect(page.getByRole('dialog',{name:'采集模板详情'})).toContainText('v1.0.0');await shot(page,'template-history');await page.keyboard.press('Escape');await expect(old).toBeFocused();
 });
 await run('health-consistency',async()=>{
  await page.goto(base+'/instances-db');await expect(page.locator('resource-metrics-table')).toBeVisible();await pause(1000);
  await text(page,'resource-list','instances-page');await matrix(page,'resource-list','instances-page');
  await page.goto(base+'/instance-detail?id=8');await expect(page.locator('instance-detail-page')).toBeVisible();await pause(1000);
  await text(page,'resource-detail','instance-detail-page');await matrix(page,'resource-detail','instance-detail-page');
  await page.getByRole('tab',{name:'健康评分',exact:true}).click();await expect(page.locator('health-score-tab')).toBeVisible();await pause(800);
  await text(page,'health','health-score-tab');await matrix(page,'health','health-score-tab');
 });
 await run('formal-trends',async()=>{
  await page.getByRole('tab',{name:'指标与趋势',exact:true}).click();
  await expect(page.locator('semantic-metrics .summary-grid')).toBeVisible({timeout:30000});
  await text(page,'semantic-all','semantic-metrics');
  const component=page.locator('semantic-metrics');
  receipt.semantic=await component.evaluate(el=>({window:el.result.window,resource:`${el.resourceType}:${el.resourceId}`,metrics:el.result.metrics.map(m=>({id:m.definition.id,state:m.state,series:m.series.length,zeroBuckets:m.series.flatMap(s=>s.buckets).filter(b=>b.value?.value!=null&&Number(b.value.value)===0).length,states:[...new Set(m.series.flatMap(s=>s.buckets).map(b=>`${b.quality.status}/${b.freshness}`))]}))}));save();
  for(const [name,id] of [['normal','db.uptime_seconds'],['zero','mysql.key_cache.used_blocks'],['failure','mysql.innodb.row_lock_average_ms'],['capability','mysql.queries.per_second'],['no-series','mysql.replication.sql_running']]) {
   await page.getByLabel('指标',{exact:true}).selectOption(id);
   await text(page,'semantic-'+name,'semantic-metrics');await matrix(page,'semantic-'+name,'semantic-metrics');
   receipt.chartEvidence??=[];
   receipt.chartEvidence.push({name,...await page.locator('semantic-metrics').evaluate(el=>({selected:el.selectedMetric,charts:[...el.shadowRoot.querySelectorAll('metric-chart')].map(c=>({title:c.title,unit:c.yAxisLabel,series:c.series,times:c.timeData,canvas:!!c.shadowRoot.querySelector('canvas'),actual:c._chart?.getOption()?.series?.map(s=>({data:s.data,color:s.itemStyle?.color}))}))}))});
  }
  const select=page.getByLabel('指标',{exact:true});await select.selectOption('mysql.key_cache.used_blocks');
  await page.getByLabel('时间范围',{exact:true}).selectOption('6');await expect(component.locator('.summary-grid')).toBeVisible();await shot(page,'semantic-window-6h');
  await page.getByLabel('时间范围',{exact:true}).selectOption('1');await expect(component.locator('.summary-grid')).toBeVisible();await page.getByRole('button',{name:'刷新标准指标',exact:true}).click();await expect(page.getByRole('button',{name:'刷新标准指标',exact:true})).toBeEnabled();await shot(page,'semantic-refresh');
 });
 assert(receipt.interactions.every(i=>i.passed), 'One or more business interactions failed');
 receipt.completed=true;
} catch(e) {receipt.failure=e.message;process.exitCode=1;}
finally {
 await browser?.close();await db?.end();
 if(service&&service.exitCode===null){service.kill('SIGTERM');await new Promise(resolve=>service.once('exit',resolve));}
 if(receipt.service)receipt.service.stopped=true;receipt.finishedAt=new Date().toISOString();save();
 console.log(JSON.stringify({completed:receipt.completed,failure:receipt.failure,interactions:receipt.interactions,captures:receipt.captures.length,errors:receipt.errors}));
}
