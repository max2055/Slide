import { expect, test } from '@playwright/test';
import { createServer } from 'vite';
import { randomBytes } from 'node:crypto';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { mkdir, open, writeFile } from 'node:fs/promises';
import { encryptData } from '../../apps/db-ops-api/src/db-connection.js';
import { ActorContextService } from '../../apps/db-ops-api/src/auth/actor-context.js';
import sshSessionPool from '../../apps/db-ops-api/src/ssh-session-pool.js';
import { createConfigurationRegistry } from '../../apps/db-ops-api/src/metrics-v2/config/registry.js';
import { runPackage, type PackageResult } from '../../apps/db-ops-api/src/metrics-v2/packages/runner.js';
import { MysqlMetricStorage } from '../../apps/db-ops-api/src/metrics-v2/storage.js';
import { MysqlPolicyStore } from '../../apps/db-ops-api/src/metrics-v2/policy/store.js';
import { PolicyService } from '../../apps/db-ops-api/src/metrics-v2/policy/service.js';
import { RolloutControl } from '../../apps/db-ops-api/src/metrics-v2/rollout/control.js';

// Explicit opt-in for a member-authorized test host. No credential literals.
// All HTTP, target authorization, host-key verification and SSH use production code.
test.skip(process.env.MAX175_SYSTEMD_TARGET !== '1', 'Requires an explicitly authorized MAX-175 systemd test host');
const require = createRequire(resolve('../apps/db-ops-api/package.json'));
const mysql = require('mysql2/promise'), bcrypt = require('bcrypt');
const output = process.env.MAX175_OUTPUT_DIR ?? '/Users/max/Coding/40-Slide/outputs/MAX-175-R7';
const host = process.env.MAX175_TEST_HOST!;
const hostPassword = process.env.MAX175_TEST_PASSWORD!;
const fingerprint = process.env.MAX175_TEST_FINGERPRINT!;
const mysqlId = 'a6e6f31f6fa7a1ad1490a13bf094caa842809fa19b4b496d6c47f1385d52b313';
const schema = `db_ops_ai_qualification_max175_systemd_${process.pid}`;
const secret = randomBytes(32).toString('hex'), encryption = randomBytes(32).toString('hex');
const password = randomBytes(24).toString('hex');
const registry = createConfigurationRegistry();
const release = registry.list().find(r => r.package.id === 'linux-host' && r.package.version === '1.0.0')!.package;
const pin = { id: release.id, version: release.version, digest: release.digest };
const children: ChildProcess[] = [], collections: any[] = [], queries: any[] = [];
let pool: any, vite: Awaited<ReturnType<typeof createServer>> | undefined, mysqlStarted = false;
let serverId: number, token: string, permissions: string[], identity: any, diagnostics: any;
const marker = `MAX175_SYSTEMD_VALIDATION_${process.pid}`;
function docker(args: string[]) { return execFileSync('docker', args, { encoding: 'utf8', timeout: 30_000 }); }
async function ready(address: string, child?: ChildProcess) {
  await expect.poll(async () => {
    if (child?.exitCode != null) throw new Error('Task service exited');
    try { return (await fetch(address)).status; } catch { return 0; }
  }, { timeout: 60_000 }).toBe(200);
}

test.beforeAll(async () => {
  test.setTimeout(180_000);
  expect(host).toBeTruthy(); expect(hostPassword).toBeTruthy(); expect(fingerprint).toMatch(/^SHA256:/);
  await mkdir(output, { recursive: true });
  expect(docker(['inspect', 'slide-max175-mysql', '--format', '{{.Id}}']).trim()).toBe(mysqlId);
  expect(docker(['inspect', mysqlId, '--format', '{{.State.Status}}']).trim()).toBe('exited');
  docker(['start', mysqlId]); mysqlStarted = true;
  await expect.poll(async () => { try { const c = await mysql.createConnection({host:'127.0.0.1',port:33175,user:'root'}); await c.end(); return true; } catch { return false; } }, {timeout:30_000}).toBe(true);
  const env = {...process.env, DB_HOST:'127.0.0.1',DB_PORT:'33175',DB_USER:'root',DB_PASSWORD:'',DB_NAME:schema,
    JWT_SECRET_KEY:secret,ENCRYPTION_KEY:encryption,PORT:'3175',AGENT_WS_PORT:'29775',
    SLIDE_MEMORY_PIPELINE_ENABLED:'false',METRICS_V2_COLLECTION_ENABLED:'false'};
  // The API receives only its encrypted task inventory credential, not test variables.
  delete env.MAX175_TEST_PASSWORD;
  const apiCwd = resolve('../apps/db-ops-api');
  execFileSync(process.execPath, ['--import','tsx','init-db.ts'], {cwd:apiCwd,env,stdio:'pipe'});
  pool = mysql.createPool({host:'127.0.0.1',port:33175,user:'root',database:schema,timezone:'Z'});
  await pool.query('UPDATE llm_providers SET enabled=0');
  await pool.query("UPDATE users SET password_hash=?,status='active' WHERE username='admin'", [await bcrypt.hash(password,10)]);
  await pool.query("INSERT IGNORE INTO user_roles(user_id,role_id) SELECT u.id,r.id FROM users u JOIN roles r ON r.name='admin' WHERE u.username='admin'");
  const [row] = await pool.query("INSERT INTO servers(host,port,label,os_type,credential_type,credential_encrypted,host_key_fingerprint,status,collection_enabled) VALUES (?,22,'MAX-175 授权麒麟 V11 systemd 测试主机','kylin','password',?,?,'offline',0)",
    [host,encryptData(JSON.stringify({username:'root',password:hostPassword}),encryption),fingerprint]);
  serverId = row.insertId;
  const client = await sshSessionPool.getConnection(host,22,'root','password',hostPassword,fingerprint);
  try {
    const commands = ['LC_ALL=C LANG=C cat /etc/os-release','LC_ALL=C LANG=C ps -p 1 -o comm=',
      'LC_ALL=C LANG=C systemctl is-system-running','LC_ALL=C LANG=C systemctl --version | head -1',
      'LC_ALL=C LANG=C uname -r','LC_ALL=C LANG=C date -u +%Y-%m-%dT%H:%M:%SZ',
      'LC_ALL=C LANG=C systemctl show sshd -p MainPID -p ExecStart -p ActiveState',
      `LC_ALL=C LANG=C logger -p user.warning -t max175-validation ${marker}`];
    const results = await sshSessionPool.execCommands(client,commands,{timeoutMs:15_000,maxOutputBytes:32*1024});
    identity = {host,port:22,username:'root',fingerprint,commands,results};
    expect(results.every(r=>r.exitCode===0 && !r.truncated)).toBe(true);
    expect(results[0].stdout).toContain('ID="kylin"'); expect(results[1].stdout.trim()).toBe('systemd');
    expect(results[2].stdout.trim()).toBe('running');
    const storage = new MysqlMetricStorage(pool), policyStore = new MysqlPolicyStore(()=>pool);
    const actor = await new ActorContextService(()=>pool).loadActiveActor(1);
    const policy = new PolicyService(policyStore,registry,{exists:async()=>true,inventory:ref=>storage.inventory(ref.type,String(ref.id))});
    const control = new RolloutControl(pool), published = new Set<string>();
    const at = new Date().toISOString();
    await storage.writeInventory({type:'server',id:String(serverId),attributes:{'os.family':{value:'linux',observed_at:at,source:'authorized-real-systemd-host-identity'}}});
    await policy.changeBinding(actor,{type:'server',id:serverId},{expected_revision:0,package:pin,overrides:{max_rows:{mode:'set',value:32},max_series_per_resource:{mode:'set',value:512}}},true);
    let previous: PackageResult | undefined;
    for (let round=0;round<2;round++) {
      if(round) await new Promise(ok=>setTimeout(ok,2000));
      const result=await runPackage(registry,{package:pin,credential_ref:'credential:max175-authorized-test-host',overrides:{max_rows:32}},{
        resource:(await storage.inventory('server',String(serverId)))!,binding_id:`server:${serverId}`,attempt_id:`max175-systemd-${round}`,config_revision:1,
        observed_at:new Date().toISOString(),evidence:{},resolve:async()=>({method:'ssh',client,pool:sshSessionPool}),states:previous?.states,
        collector_ids:['linux-host-gauges','linux-filesystem'],
      });
      collections.push({round,result});
      expect(result.attempts.every(a=>a.status==='succeeded'),JSON.stringify(result.attempts)).toBe(true);
      expect(result.observations.length).toBeGreaterThan(0);
      for(const {observation} of result.observations) {
        const key=JSON.stringify([observation.metric,observation.dimensions]), ticket={source:'v2',generation:1,revision:1};
        if(!published.has(key)) {await control.initialize(observation,{source:'v2',read:'v2',package:pin,revision:1});await control.applied(observation,ticket);published.add(key);}
        await control.publish(observation,registry.catalog(pin).find(d=>d.id===observation.metric.id)!,ticket);
      }
      await policyStore.reportCapabilities({type:'server',id:serverId},1,result.capabilities,null); previous=result;
    }
  } finally { sshSessionPool.closeConnection(client); }
  const log=await open(`${output}/api-local.log`,'w');
  const api=spawn(process.execPath,['--import','tsx','server.ts'],{cwd:apiCwd,env,stdio:['ignore',log.fd,log.fd]});children.push(api);await log.close();
  await ready('http://127.0.0.1:3175/api/health/ready',api);
  const login=await fetch('http://127.0.0.1:3175/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'admin',password})});
  expect(login.ok).toBe(true);token=(await login.json()).token;
  permissions=await(await fetch('http://127.0.0.1:3175/api/auth/permissions',{headers:{Authorization:`Bearer ${token}`}})).json();
  vite=await createServer({root:resolve('.'),configFile:resolve('vite.config.js'),server:{host:'127.0.0.1',port:5195,strictPort:true,proxy:{
    '/api':{target:'http://127.0.0.1:3175'},'/__slide':{target:'http://127.0.0.1:29775'},'/agent-ws':{target:'http://127.0.0.1:29775',ws:true},
  }}});await vite.listen();
});

test.afterAll(async()=>{
  await vite?.close();sshSessionPool.closeAll();
  for(const child of children.reverse()) if(child.exitCode===null) {child.kill('SIGTERM');await new Promise<void>(ok=>{child.once('exit',()=>ok());setTimeout(()=>{if(child.exitCode===null)child.kill('SIGKILL');ok();},5000).unref();});}
  if(pool) {await pool.query(`DROP DATABASE IF EXISTS ${schema}`);await pool.end();}
  if(mysqlStarted)docker(['stop',mysqlId]);
  const evidence=JSON.stringify({sourceHead:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),identity,serverId,marker,collections,queries,diagnostics,
    qualification:'Authorized real Kylin V11 systemd host; production target policy, pinned SSH and complete formal HTTP route; no transport seam or HTTP overlay',
    limitations:['Task-only inventory/database and direct package publication; production scheduler/shared binding/Agent chain not qualified','No SNMP or vendor-device qualification','One task warning journal entry remains; no configuration/package/service changes'],
    productModelCalls:0,cleanup:{schemaDropped:!!pool,localServiceHandlesClosed:true,mysqlRestoredToExited:mysqlStarted,remoteConfigurationChanged:false}},null,2);
  for(const credential of [hostPassword,password,secret,encryption,token].filter(Boolean))expect(evidence.includes(credential)).toBe(false);
  await writeFile(`${output}/systemd-evidence.json`,evidence);
});

test.beforeEach(async({page})=>{
  await page.addInitScript(({token,permissions})=>{localStorage.setItem('token',token);localStorage.setItem('slide.control.session_token.v1',token);localStorage.setItem('permissions',JSON.stringify(permissions));localStorage.setItem('slide.i18n.locale','zh-CN');},{token,permissions});
});

test('authorized host metrics → production SSH, formal storage/query and six page variants',async({page})=>{
  test.setTimeout(120_000);const requests:string[]=[],errors:string[]=[],views:any[]=[];
  page.on('request',r=>{if(r.url().includes('diagnostics'))requests.push(`${r.method()} ${new URL(r.url()).pathname}`);});
  page.on('pageerror',e=>errors.push(e.message));
  page.on('response',async r=>{if(r.url().endsWith('/api/metrics-v2/query'))queries.push({status:r.status(),body:await r.json()});});
  await page.goto(`http://127.0.0.1:5195/server-detail?id=${serverId}`);
  const view=page.locator('server-detail');
  for(const width of [1440,768,390])for(const theme of ['light','dark']) {
    await page.setViewportSize({width,height:1000});await page.evaluate(theme=>document.documentElement.dataset.themeMode=theme,theme);
    await view.getByRole('tab',{name:'指标与趋势',exact:true}).click();const metrics=view.locator('semantic-metrics');
    await expect(metrics.locator('.current').first()).toBeVisible();const current=await metrics.locator('.current').allTextContents();
    expect(current.some(t=>!t.includes('未知'))).toBe(true);await expect(metrics.locator('time').first()).toHaveAttribute('datetime',/2026-/);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await page.screenshot({path:`${output}/systemd-metrics-${width}-${theme}.png`,fullPage:true});views.push({width,theme,current});
  }
  expect(requests).toEqual([]);expect(errors).toEqual([]);
  await writeFile(`${output}/browser-metrics.json`,JSON.stringify({views,requests,errors,source:'Formal page/query, real host samples; direct package publication; no transport seam'},null,2));
});

test('authorized systemd host → production SSH and diagnostic POST → formal server logs',async({page})=>{
  test.setTimeout(120_000);const requests:string[]=[],errors:string[]=[];
  page.on('request',r=>{if(r.url().includes('diagnostics'))requests.push(`${r.method()} ${new URL(r.url()).pathname}`);});
  page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`http://127.0.0.1:5195/server-detail?id=${serverId}`);
  const view=page.locator('server-detail');await view.getByRole('tab',{name:'日志',exact:true}).click();
  await view.getByRole('button',{name:'刷新',exact:true}).click();
  await expect(view).toContainText('当前页面尚未取得诊断证据');expect(requests).toEqual([]);
  const response=page.waitForResponse(r=>r.url().endsWith('/collect-diagnostics'));
  const started=Date.now();await view.getByRole('button',{name:'采集诊断证据',exact:true}).click();
  const collected=await response;const body=await collected.json();diagnostics=body.diagnostics;
  await writeFile(`${output}/diagnostic-response.json`,JSON.stringify({status:collected.status(),body},null,2));
  if(collected.status()!==200) {
    for(const width of [1440,768,390])for(const theme of ['light','dark']) {
      await page.setViewportSize({width,height:1000});await page.evaluate(theme=>document.documentElement.dataset.themeMode=theme,theme);
      await page.screenshot({path:`${output}/systemd-logs-failed-${width}-${theme}.png`,fullPage:true});
    }
    await writeFile(`${output}/browser-diagnostics.json`,JSON.stringify({requests,errors,status:collected.status(),body,source:'Real production diagnostic failure, not a normal-flow pass'},null,2));
  }
  expect(collected.status(),JSON.stringify(body)).toBe(200);
  expect(diagnostics.serviceStatus.quality).toBe('good');expect(diagnostics.serviceStatus.items.length).toBeGreaterThan(0);
  expect(diagnostics.recentSystemLogs.quality).toBe('good');expect(diagnostics.recentSystemLogs.reason).toBeUndefined();
  expect(diagnostics.recentSystemLogs.items.some((i:any)=>i.message.includes(marker)&&i.timestamp)).toBe(true);
  await expect(view.locator('server-diagnostic-panel')).toContainText(marker);
  const diagnosticToVisibleMs=Date.now()-started;
  for(const width of [1440,768,390])for(const theme of ['light','dark']) {
    await page.setViewportSize({width,height:1000});await page.evaluate(theme=>document.documentElement.dataset.themeMode=theme,theme);
    await view.getByRole('tab',{name:'日志',exact:true}).click();await expect(view.locator('server-diagnostic-panel')).toContainText(marker);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await page.screenshot({path:`${output}/systemd-logs-${width}-${theme}.png`,fullPage:true});
  }
  expect(requests.filter(r=>r.startsWith('GET '))).toEqual([]);expect(requests.filter(r=>r.startsWith('POST '))).toHaveLength(1);expect(errors).toEqual([]);
  await writeFile(`${output}/browser-diagnostics.json`,JSON.stringify({requests,errors,diagnosticToVisibleMs,source:'Formal page, formal Fastify diagnostics route, pinned production SSH; no overlay'},null,2));
});
