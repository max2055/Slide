import { expect, test } from '@playwright/test';
import Fastify from '../../apps/db-ops-api/node_modules/fastify/fastify.js';
import { createServer } from 'vite';
import { Client } from 'ssh2';
import { randomBytes } from 'node:crypto';
import { spawn, spawnSync, execFileSync, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { mkdir, open, writeFile } from 'node:fs/promises';
import { encryptData, decryptData } from '../../apps/db-ops-api/src/db-connection.js';
import { ActorContextService } from '../../apps/db-ops-api/src/auth/actor-context.js';
import { createVerifyToken } from '../../apps/db-ops-api/src/auth-middleware.js';
import { requirePermission } from '../../apps/db-ops-api/src/auth/require-permission.js';
import sshSessionPool from '../../apps/db-ops-api/src/ssh-session-pool.js';
import { ServerDiagnosticService } from '../../apps/db-ops-api/src/server-diagnostic-service.js';
import { SnmpClient } from '../../apps/db-ops-api/src/network-devices/snmp-client.js';
import { SnmpDiscovery } from '../../apps/db-ops-api/src/metrics/snmp/collector.js';
import { createConfigurationRegistry } from '../../apps/db-ops-api/src/metrics/config/registry.js';
import { bindMySql, bindSnmp, type Transport } from '../../apps/db-ops-api/src/metrics/packages/adapters.js';
import { runPackage, type PackageResult } from '../../apps/db-ops-api/src/metrics/packages/runner.js';
import { MysqlMetricStorage } from '../../apps/db-ops-api/src/metrics/storage.js';
import { MysqlPolicyStore } from '../../apps/db-ops-api/src/metrics/policy/store.js';
import { PolicyService } from '../../apps/db-ops-api/src/metrics/policy/service.js';
import { RolloutControl } from '../../apps/db-ops-api/src/metrics/rollout/control.js';

// Opt-in REAL protocol qualification, not a simulated SNMP agent or response fixture.
// The ONLY HTTP overlay is diagnostic POST: real service + real SSH, with a
// loopback connection seam (production target authorization is deliberately unchanged).
test.skip(process.env.MAX175_LIVE_TARGET !== '1', 'Requires MAX-175 exclusive Docker targets and ports');
const require = createRequire(resolve('../apps/db-ops-api/package.json'));
const mysql = require('mysql2/promise'), bcrypt = require('bcrypt');
const output = process.env.MAX175_OUTPUT_DIR ?? '/Users/max/Coding/40-Slide/outputs/MAX-175-R6';
const mysqlId = 'a6e6f31f6fa7a1ad1490a13bf094caa842809fa19b4b496d6c47f1385d52b313';
const schema = `db_ops_ai_qualification_max175_live_${process.pid}`;
const children: ChildProcess[] = [], sshClients = new Set<Client>();
const sshCalls: unknown[] = [], snmpCalls: unknown[] = [], collections: unknown[] = [], queries: unknown[] = [];
const registry = createConfigurationRegistry();
let pool: any, api: ChildProcess, vite: Awaited<ReturnType<typeof createServer>>, overlay: ReturnType<typeof Fastify>;
let targetId: string | undefined, dockerNetworkId: string | undefined, mysqlStarted = false, token: string, permissions: string[], url: string;
let serverId: number, instanceId: number, networkId: number, diagnostics: any, metadata: any;
const secret = randomBytes(32).toString('hex'), encryption = randomBytes(32).toString('hex');
const password = randomBytes(24).toString('hex'), community = randomBytes(24).toString('hex');
const pins = Object.fromEntries(['mysql-representative', 'linux-host', 'snmp-standard'].map(id => {
  const p = registry.list().find(r => r.package.id === id && r.package.version === '1.0.0')!.package;
  return [id, { id: p.id, version: p.version, digest: p.digest }];
}));
function docker(args: string[], input?: string) {
  return execFileSync('docker', args, { input, encoding: 'utf8', timeout: 30_000 });
}
async function connect() {
  const client = new Client(); sshClients.add(client);
  await new Promise<void>((ok, fail) => client.once('ready', ok).once('error', fail).connect({
    host: '127.0.0.1', port: 22175, username: 'fixture', password, readyTimeout: 5000,
  }));
  return client;
}
async function execute(client: Client, commands: string[], options: any) {
  const results = await sshSessionPool.execCommands(client, commands, options);
  sshCalls.push({ commands, results }); return results;
}
async function ready(address: string, process?: ChildProcess) {
  await expect.poll(async () => {
    if (process?.exitCode != null) throw new Error('Task process exited; inspect task log');
    try { return (await fetch(address)).status; } catch { return 0; }
  }, { timeout: 60_000 }).toBe(200);
}
test.beforeAll(async () => {
  test.setTimeout(180_000); await mkdir(output, { recursive: true });
  expect(docker(['inspect', 'slide-max175-mysql', '--format', '{{.Id}}']).trim()).toBe(mysqlId);
  expect(docker(['inspect', mysqlId, '--format', '{{.State.Status}}']).trim()).toBe('exited');
  docker(['start', mysqlId]); mysqlStarted = true;
  dockerNetworkId=docker(['network','create','--label','slide.task=MAX-175',`max175-live-${process.pid}`]).trim();
  targetId = docker(['run', '-d', '--name', 'slide-max175-live-target', '--label', 'slide.task=MAX-175',
    '--network',dockerNetworkId,'--memory=512m', '--cpus=1', '--pids-limit=128', '-p', '127.0.0.1:22175:22',
    '-p', '127.0.0.1:16175:161/udp', '-p', '127.0.0.1:18175:8080', 'slide-max175-live-target:r5']).trim();
  await ready('http://127.0.0.1:18175/');
  docker(['exec', '-i', targetId, 'chpasswd'], `fixture:${password}\n`);
  docker(['exec', '-i', targetId, 'sh', '-c', 'umask 077; cat > /run/max175-snmpd.conf'],
    `agentaddress udp:0.0.0.0:161\nview max175 included .1.3.6.1.2.1\nrocommunity ${community} default -V max175\n`);
  docker(['exec', '-d', targetId, '/usr/sbin/snmpd', '-f', '-Lo', '-C', '-c', '/run/max175-snmpd.conf']);
  docker(['exec', targetId, 'sh', '-c', 'printf "MAX175_REAL_JOURNAL_WORKLOAD warning from actual logger\n" | systemd-cat -t max175-isolation -p warning']);
  docker(['exec',targetId,'logger','-u','/run/max175-log.sock','-p','user.warning','-t','max175-isolation','MAX175_REAL_SYSLOG_WORKLOAD from actual logger']);
  docker(['exec',targetId,'sh','-c','for dir in /run/log/journal /var/log/journal; do if [ -d "$dir" ]; then chgrp -R systemd-journal "$dir"; chmod -R g+rX "$dir"; fi; done; chgrp systemd-journal /var/log/messages; chmod 0640 /var/log/messages']);
  const probe=(args:string[])=>{const r=spawnSync('docker',['exec',targetId!,'runuser','-u','fixture','--','journalctl','--no-pager','--quiet','--output=json',...args,'--priority=warning','--lines=200'],{encoding:'utf8',timeout:5000});return {status:r.status,stdout:r.stdout,stderr:r.stderr};};
  metadata = { container: targetId, network:dockerNetworkId, image: docker(['inspect', targetId, '--format', '{{.Image}}']).trim(),
    os: docker(['exec', targetId, 'cat', '/etc/os-release']),
    versions: docker(['exec', targetId, 'rpm', '-q', 'openssh-server', 'net-snmp', 'procps-ng', 'iproute', 'systemd', 'python3','rsyslog']),
    ports: JSON.parse(docker(['inspect', targetId, '--format', '{{json .HostConfig.PortBindings}}'])),
    processes: docker(['exec', targetId, 'ps', '-eo', 'pid,comm,args']),
    journalArgumentProbe:{legacySplit:probe(['--since=-5','minutes']),singleArgument:probe(['--since=-5 minutes'])},
  };
  const env = { ...process.env, DB_HOST: '127.0.0.1', DB_PORT: '33175', DB_USER: 'root', DB_PASSWORD: '', DB_NAME: schema,
    JWT_SECRET_KEY: secret, ENCRYPTION_KEY: encryption, PORT: '3175', AGENT_WS_PORT: '29775', SLIDE_MEMORY_PIPELINE_ENABLED: 'false', METRICS_COLLECTION_ENABLED:'false' };
  const apiCwd = resolve('../apps/db-ops-api');
  // Wait for this exact, previously stopped task database; never fall back to another port.
  await expect.poll(async () => { try { const c = await mysql.createConnection({ host:'127.0.0.1',port:33175,user:'root' }); await c.end(); return true; } catch { return false; } }, { timeout:30_000 }).toBe(true);
  await writeFile(`${output}/migration.log`, execFileSync(process.execPath, ['--import','tsx','init-db.ts'], {cwd:apiCwd,env,encoding:'utf8'}));
  pool = mysql.createPool({ host:'127.0.0.1',port:33175,user:'root',database:schema,timezone:'Z' });
  await pool.query('UPDATE llm_providers SET enabled=0');
  await pool.query("UPDATE users SET password_hash=?,status='active' WHERE username='admin'", [await bcrypt.hash(password,10)]);
  await pool.query("INSERT IGNORE INTO user_roles(user_id,role_id) SELECT u.id,r.id FROM users u JOIN roles r ON r.name='admin' WHERE u.username='admin'");
  const [instance] = await pool.query("INSERT INTO database_instances(name,db_type,host,port,username,password_encrypted,status,health_status) VALUES ('MAX-175 真实隔离 MySQL','mysql','127.0.0.1',33175,'root',?,'inactive','unknown')", [encryptData('',encryption)]);
  instanceId = instance.insertId;
  const [server] = await pool.query("INSERT INTO servers(host,port,label,os_type,credential_type,credential_encrypted,status,collection_enabled) VALUES ('127.0.0.1',22175,'MAX-175 真实 CentOS Stream 9 容器','centos','password',?,'offline',0)", [encryptData(JSON.stringify({username:'fixture',password}),encryption)]);
  serverId = server.insertId;
  // Existing vendor column has no generic Linux option. Huawei identifies the inventory
  // schema only; the label and evidence explicitly say Linux, and no enterprise OID is used.
  const [network] = await pool.query("INSERT INTO network_devices(name,label,host,vendor,collection_enabled,status) VALUES ('max175-real-linux-snmp','MAX-175 Linux Net-SNMP · 非厂商交换机','127.0.0.1','huawei',0,'unknown')");
  networkId = network.insertId;
  const contexts = new ActorContextService(() => pool), actor = await contexts.loadActiveActor(1);
  const storage = new MysqlMetricStorage(pool), policyStore = new MysqlPolicyStore(() => pool);
  const policy = new PolicyService(policyStore,registry,{exists:async()=>true,inventory:ref=>storage.inventory(ref.type,String(ref.id))});
  const control = new RolloutControl(pool), published = new Set<string>();
  const ssh = await connect();
  const wire = bindSnmp(new SnmpClient(),{version:2,host:'127.0.0.1',port:16175,community,retries:0}) as Extract<Transport,{method:'snmp'}>;
  const snmp: Extract<Transport,{method:'snmp'}> = {
    method:'snmp',
    get:async(oids,timeout)=>{const rows=await wire.get!(oids,timeout);snmpCalls.push({oids,rows});return rows;},
    table:async(root,timeout)=>{const rows=await wire.table(root,timeout);snmpCalls.push({root,rows});return rows;},
  };
  const discovery = new SnmpDiscovery();
  const jobs = [
    {type:'instance' as const,id:instanceId,pin:pins['mysql-representative'],attributes:{'db.engine':'mysql','db.version':'8.4'},transport:bindMySql(pool),evidence:{},collector_ids:['mysql-connections','mysql-limit','mysql-size']},
    {type:'server' as const,id:serverId,pin:pins['linux-host'],attributes:{'os.family':'linux'},transport:{method:'ssh',client:ssh,pool:{execCommands:execute}} as Transport,evidence:{},collector_ids:['linux-host-gauges','linux-filesystem']},
    {type:'network_device' as const,id:networkId,pin:pins['snmp-standard'],attributes:{'snmp.version':2},transport:snmp,evidence:{snmp:discovery}},
  ];
  for(const job of jobs) {
    const at=new Date().toISOString();
    await storage.writeInventory({type:job.type,id:String(job.id),attributes:Object.fromEntries(Object.entries(job.attributes).map(([k,value])=>[k,{value,observed_at:at,source:'real-isolated-target-identity'}]))});
    await policy.changeBinding(actor,{type:job.type,id:job.id},{expected_revision:0,package:job.pin,overrides:{max_rows:{mode:'set',value:16},max_series_per_resource:{mode:'set',value:512}}},true);
  }
  const previous = new Map<string,PackageResult>();
  for(let round=0;round<2;round++) {
    // Net-SNMP's Linux interface cache refresh is about 5s; allow it to observe
    // the completed transfer. This is bounded target sampling, not CI polling.
    if(round) { const response=await fetch('http://127.0.0.1:18175/payload'); expect((await response.arrayBuffer()).byteLength).toBe(2097152); await new Promise(ok=>setTimeout(ok,6000)); }
    for(const job of jobs) {
      const at=new Date().toISOString(), key=`${job.type}:${job.id}`;
      const result=await runPackage(registry,{package:job.pin,credential_ref:'credential:max175-isolated',overrides:{max_rows:16}},{
        resource:(await storage.inventory(job.type,String(job.id)))!,binding_id:key,attempt_id:`max175-live-${round}-${key}`,config_revision:1,observed_at:at,
        evidence:job.evidence,resolve:async()=>job.transport,states:previous.get(key)?.states,
        ...('collector_ids' in job?{collector_ids:job.collector_ids}:{}),...('metric_keys' in job?{metric_keys:job.metric_keys}:{}),
      });
      collections.push({round,resource:key,result});
      expect(result.attempts.every(a=>a.status==='succeeded'),JSON.stringify(result.attempts)).toBe(true);
      expect(result.observations.length).toBeGreaterThan(0);
      const definitions=registry.catalog(job.pin);
      for(const {observation} of result.observations) {
        const series=JSON.stringify([observation.resource_type,observation.resource_id,observation.metric,observation.dimensions]);
        const ticket={source:'semantic',generation:1,revision:1};
        if(!published.has(series)) { await control.initialize(observation,{source:'semantic',read:'semantic',package:job.pin,revision:1}); await control.applied(observation,ticket); published.add(series); }
        await control.publish(observation,definitions.find(d=>d.id===observation.metric.id)!,ticket);
      }
      await policyStore.reportCapabilities({type:job.type,id:job.id},1,result.capabilities,null);
      previous.set(key,result);
    }
  }
  const networkResult=previous.get(`network_device:${networkId}`)!;
  const rates=networkResult.observations.filter(o=>o.observation.metric.id==='snmp.interface.tx_bits_per_second');
  const rate=rates.find(o=>o.observation.value?.encoding==='float64' && o.observation.value.value>0 && ['good','partial'].includes(o.observation.quality.status))!.observation;
  expect(rate).toBeDefined();
  const first=(collections.find((c:any)=>c.round===0 && c.resource===`network_device:${networkId}`) as any).result.observations;
  const counter=(items:any[])=>items.find(o=>o.observation.metric.id==='snmp.interface.tx_octets_total' && o.observation.dimensions.if_index===rate.dimensions.if_index).observation;
  const before=counter(first),after=counter(networkResult.observations);
  const delta=BigInt(after.value.value)-BigInt(before.value.value);
  expect(delta).toBeGreaterThanOrEqual(2097152n);
  expect(after.counter.discontinuity.epoch).toBe(before.counter.discontinuity.epoch);
  expect((rate.value as any).value).toBeCloseTo(Number(delta)*8000/(Date.parse(after.observed_at)-Date.parse(before.observed_at)),6);
  // Persist interface inventory from the same real IF-MIB table, never invented names/capacity.
  const table=await snmp.table('1.3.6.1.2.1.2.2',5000);
  for(const row of table) {
    const v=(n:number)=>row.values[`1.3.6.1.2.1.2.2.1.${n}`]??row.values[String(n)];
    const value=(n:number)=>{const raw=v(n) as any;return raw && typeof raw==='object' && !Buffer.isBuffer(raw) && 'value' in raw?raw.value:raw;};
    const name=value(2); await pool.query("INSERT INTO network_device_interfaces(device_id,if_index,if_name,speed_bps,admin_status,oper_status,last_seen_at) VALUES (?,?,?,?,?,?,NOW())",[networkId,Number(row.index),Buffer.isBuffer(name)?name.toString():String(name),Number(value(5)),Number(value(7))===1?'up':'down',Number(value(8))===1?'up':'down']);
  }
  const log = await open(`${output}/api.log`,'w');
  api=spawn(process.execPath,['--import','tsx','server.ts'],{cwd:apiCwd,env,stdio:['ignore',log.fd,log.fd]}); children.push(api); await log.close();
  await ready('http://127.0.0.1:3175/api/health/ready',api);
  const login=await fetch('http://127.0.0.1:3175/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'admin',password})}); expect(login.ok).toBe(true); token=(await login.json()).token;
  permissions=await (await fetch('http://127.0.0.1:3175/api/auth/permissions',{headers:{Authorization:`Bearer ${token}`}})).json();
  const service=new ServerDiagnosticService({serverDatabaseService:{
    getServerById:async id=>(await pool.query('SELECT * FROM servers WHERE id=?',[id]))[0][0]??null,
    getDecryptedCredentials:async id=>{const row=(await pool.query('SELECT credential_encrypted FROM servers WHERE id=?',[id]))[0][0];return row?JSON.parse(decryptData(row.credential_encrypted,encryption)):null;},
  },sshSessionPool:{getConnection:connect,execCommands:execute,releaseConnection:client=>{client.end();sshClients.delete(client);},closeConnection:client=>{client.destroy();sshClients.delete(client);}}});
  overlay=Fastify(); const verify=createVerifyToken(secret,contexts);
  overlay.post(`/api/servers/${serverId}/collect-diagnostics`,{preHandler:[verify,requirePermission('servers:manage')]},async()=>{
    diagnostics=await service.collectDiagnostics(serverId);return {success:true,diagnostics};
  });
  const overlayUrl=await overlay.listen({host:'127.0.0.1',port:0});
  // Vite merges object keys without reordering the repository's /api prefix.
  // Put the single qualification route first AFTER resolution, before proxy setup.
  vite=await createServer({root:resolve('.'),configFile:resolve('vite.config.js'),plugins:[{
    name:'max175-real-ssh-qualification-route',configResolved(config){
      config.server.proxy={
        [`^/api/servers/${serverId}/collect-diagnostics$`]:{target:overlayUrl},
        ...config.server.proxy,
      };
    },
  }],server:{host:'127.0.0.1',port:5195,strictPort:true,proxy:{
    '/api':{target:'http://127.0.0.1:3175'},'/__slide':{target:'http://127.0.0.1:29775'},'/agent-ws':{target:'http://127.0.0.1:29775',ws:true},
  }}}); await vite.listen(); url='http://127.0.0.1:5195';
});
test.afterAll(async()=>{
  await vite?.close(); await overlay?.close(); for(const client of sshClients) client.destroy(); sshSessionPool.closeAll();
  for(const child of children.reverse()) if(child.exitCode===null) { child.kill('SIGTERM'); await new Promise<void>(ok=>{child.once('exit',()=>ok());setTimeout(()=>{if(child.exitCode===null) child.kill('SIGKILL');ok();},5000).unref();}); }
  if(pool) {await pool.query(`DROP DATABASE IF EXISTS ${schema}`);await pool.end();}
  const cleanup:any={schemaDropped:!!pool,serviceHandlesClosed:true};
  if(targetId) {expect(docker(['inspect',targetId,'--format','{{index .Config.Labels "slide.task"}}']).trim()).toBe('MAX-175');docker(['stop',targetId]);docker(['rm',targetId]);cleanup.targetRemoved=targetId;}
  if(dockerNetworkId) {docker(['network','rm',dockerNetworkId]);cleanup.networkRemoved=dockerNetworkId;}
  if(mysqlStarted) {docker(['stop',mysqlId]);cleanup.mysqlStopped=mysqlId;}
  await writeFile(`${output}/cleanup.json`,JSON.stringify(cleanup,null,2));
  const evidence=JSON.stringify({sourceHead:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),metadata,
    limitations:['Real protocol isolation, NOT shared online SSH/SNMP qualification','Only diagnostic POST uses real-SSH loopback connection seam; other HTTP uses full formal Fastify','Linux Net-SNMP target is NOT Huawei hardware; inventory enum does not establish vendor support','Container has no systemd PID1; services remain unknown; overall diagnostic is partial','Direct package invocation/publication does not qualify the production scheduler or online binding activation'],
    collections,queries,diagnostics,sshCalls,snmpCalls,productModelCalls:0},null,2);
  for(const credential of [password,community,secret,encryption,token].filter(Boolean)) expect(evidence.includes(credential)).toBe(false);
  await writeFile(`${output}/live-evidence.json`,evidence);
});

test('real isolated collection → formal storage/query → normal metrics, logs and interfaces',async({page})=>{
  test.setTimeout(120_000); const requests:string[]=[],errors:string[]=[];
  page.on('request',r=>{if(r.url().includes('diagnostics'))requests.push(`${r.method()} ${new URL(r.url()).pathname}`);});
  page.on('pageerror',e=>errors.push(e.message));
  page.on('response',async r=>{if(r.url().endsWith('/api/metrics/query'))queries.push({status:r.status(),body:await r.json()});});
  await page.addInitScript(({token,permissions})=>{localStorage.setItem('token',token);localStorage.setItem('slide.control.session_token.v1',token);localStorage.setItem('permissions',JSON.stringify(permissions));localStorage.setItem('slide.i18n.locale','zh-CN');},{token,permissions});
  for(const width of [1440,768,390]) for(const theme of ['light','dark']) {
    await page.setViewportSize({width,height:1000});
    for(const [type,path,tag] of [['instance',`/instance-detail?id=${instanceId}`,'instance-detail-page'],['server',`/server-detail?id=${serverId}`,'server-detail'],['network_device',`/network-device-detail?networkDeviceId=${networkId}`,'network-device-detail']] as const) {
      await page.goto(url+path); await page.evaluate(theme=>document.documentElement.dataset.themeMode=theme,theme);
      const view=page.locator(tag); await view.getByRole('tab',{name:'指标与趋势',exact:true}).click();
      const metrics=view.locator('semantic-metrics'); await expect(metrics.locator('.current').first()).toBeVisible();
      expect(await metrics.locator('.current').count()).toBeGreaterThan(0); await expect(metrics.locator('time').first()).toHaveAttribute('datetime',/2026-/);
      const current=await metrics.locator('.current').allTextContents(); expect(current.some(text=>!text.includes('未知'))).toBe(true);
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
      await page.screenshot({path:`${output}/${type}-live-metrics-${width}-${theme}.png`,fullPage:true});
      if(type==='network_device') {await view.getByRole('tab',{name:'接口',exact:true}).click();await expect(view.locator('app-data-table')).toContainText('eth0');await page.screenshot({path:`${output}/network-live-interfaces-${width}-${theme}.png`,fullPage:true});}
      if(type==='server') {
        await view.getByRole('tab',{name:'日志',exact:true}).click(); await view.getByRole('button',{name:'刷新',exact:true}).click();
        expect(requests.filter(r=>r.startsWith('GET '))).toEqual([]);
        await expect(view).toContainText('当前页面尚未取得诊断证据');
        const response=page.waitForResponse(r=>r.url().endsWith('/collect-diagnostics'));
        await view.getByRole('button',{name:'采集诊断证据',exact:true}).click(); expect((await response).status()).toBe(200);
        await expect(view.locator('server-diagnostic-panel')).toContainText('MAX175_REAL_JOURNAL_WORKLOAD');
        expect(diagnostics.quality).toBe('partial'); expect(diagnostics.recentSystemLogs.quality).toBe('good');
        expect(diagnostics.recentSystemLogs.reason).toBeUndefined();
        expect(diagnostics.recentSystemLogs.items.some((item: any) => item.message.includes('MAX175_REAL_JOURNAL_WORKLOAD') && item.timestamp)).toBe(true);
        expect(sshCalls.some((call: any) => call.commands.some((command: string) => command.includes('tail -n 200')))).toBe(false);
        expect(diagnostics.serviceStatus.quality).toBe('unknown');
        await page.screenshot({path:`${output}/server-live-logs-${width}-${theme}.png`,fullPage:true});
      }
    }
  }
  expect(requests.filter(r=>r.startsWith('GET '))).toEqual([]); expect(requests.filter(r=>r.startsWith('POST '))).toHaveLength(6);expect(errors).toEqual([]);
  await writeFile(`${output}/browser.json`,JSON.stringify({viewports:[1440,768,390],themes:['light','dark'],requests,errors,source:'real collected values; formal application shell and API; diagnostic POST transport qualification seam'},null,2));
});
