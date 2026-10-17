import { expect, test } from '@playwright/test';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { readFile, mkdir, writeFile, open } from 'node:fs/promises';
import { encryptData, decryptData } from '../../apps/db-ops-api/src/db-connection.js';
import { selectSceneModel } from '../../apps/db-ops-api/src/llm/scene-routing.js';
import { state as budget } from '../../scripts/qualification/max175-model-meter.mjs';

test.skip(process.env.MAX175_FORMAL_CHAIN!=='1','Explicit isolated full-chain opt-in required');
const require=createRequire(resolve('../apps/db-ops-api/package.json'));
const mysql=require('mysql2/promise'),bcrypt=require('bcrypt'),dotenv=require('dotenv');
const output=process.env.MAX175_OUTPUT_DIR!;
const schema=`db_ops_ai_qualification_max175_r11_${process.pid}`, dataSchema=`max175_data_${process.pid}`, reader=`max175_${process.pid}`;
const api='http://127.0.0.1:3175',site='http://127.0.0.1:5195';
const children:ChildProcess[]=[];
const encryption=randomBytes(32).toString('hex'),password=randomBytes(24).toString('hex'),readerPassword=randomBytes(24).toString('hex');
const targetHost=process.env.MAX175_TARGET_HOST!,targetRoot=randomBytes(32).toString('hex'),targetName=`max175-r11-target-${process.pid}`;
let pool:any,targetPool:any,token='',permissions:string[]=[],instanceId:number,targetStarted=false;
let apiProcess:ChildProcess,apiEnvironment:NodeJS.ProcessEnv;
async function startApi(name:string){
  apiProcess=await launch(['--import',resolve('../scripts/qualification/max175-model-meter.mjs'),'--import','tsx','server.ts'],resolve('../apps/db-ops-api'),apiEnvironment,name);
  report.apiRestarts??=[];report.apiRestarts.push({pid:apiProcess.pid,at:new Date().toISOString(),commit:report.candidate});
  await expect.poll(async()=>{if(apiProcess.exitCode!==null)throw Error('API exited');try{return(await fetch(api+'/api/health/ready')).status;}catch{return 0;}},{timeout:90000}).toBe(200);
  return apiProcess;
}
const schedulerOnly=process.env.MAX175_SCHEDULER_ONLY==='1';
const report:any={version:1,schedulerOnly,mode:'production Fastify/JWT/worker/scheduler/Agent; isolated MySQL 9.6',checks:{},http:[]};
async function save(){await writeFile(`${output}/formal-chain-${process.pid}.json`,JSON.stringify(report,null,2));}
async function request(path:string,body?:any,authorization=token,method=body===undefined?'GET':'POST') {
  const r=await fetch(api+path,{method,headers:{'Content-Type':'application/json',...(authorization?{Authorization:`Bearer ${authorization}`}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const value=await r.json();report.http.push({at:new Date().toISOString(),path,method,status:r.status});return {status:r.status,value};
}
async function launch(args:string[],cwd:string,env:NodeJS.ProcessEnv,name:string){const f=await open(`${output}/${name}.private.log`,'w',0o600);const c=spawn(process.execPath,args,{cwd,env,stdio:['ignore',f.fd,f.fd]});children.push(c);await f.close();return c;}
test.beforeAll(async()=>{
  test.setTimeout(420000);expect(output).toMatch(/^\/Users\/max\/Coding\/40-Slide\/outputs\/MAX-175-R11\//);report.baselineBudget=budget();await mkdir(output,{recursive:true});
  expect(targetHost).toMatch(/^192\.168\.1\.\d+$/);
  report.candidate=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
  report.main=execFileSync('git',['rev-parse','origin/main'],{encoding:'utf8'}).trim();
  expect(execFileSync('docker',['inspect','slide-max175-mysql','--format','{{.State.Status}}'],{encoding:'utf8'}).trim()).toBe('exited');
  execFileSync('docker',['run','-d','--name',targetName,'--publish',`${targetHost}:33176:3306`,'--env','MYSQL_ROOT_PASSWORD','--env','MYSQL_ROOT_HOST','mysql:9.6'],{env:{...process.env,MYSQL_ROOT_PASSWORD:targetRoot,MYSQL_ROOT_HOST:'%'},stdio:'pipe'});targetStarted=true;
  report.targetStartup={container:targetName,host:targetHost,port:33176,errors:[]};await save();
  await expect.poll(async()=>{try{const c=await mysql.createConnection({host:targetHost,port:33176,user:'root',password:targetRoot,connectTimeout:1000});await c.end();return true;}catch(e:any){report.targetStartup.errors.push({at:new Date().toISOString(),code:e.code});await save();return false;}},{timeout:180000}).toBe(true);
  targetPool=mysql.createPool({host:targetHost,port:33176,user:'root',password:targetRoot});
  const env={...process.env,DB_HOST:targetHost,DB_PORT:'33176',DB_USER:'root',DB_PASSWORD:targetRoot,DB_NAME:schema,
    JWT_SECRET_KEY:randomBytes(32).toString('hex'),ENCRYPTION_KEY:encryption,PORT:'3175',AGENT_WS_PORT:'29775',
    SLIDE_MEMORY_PIPELINE_ENABLED:'false',METRICS_COLLECTION_ENABLED:'true'};
  pool=mysql.createPool({host:targetHost,port:33176,user:'root',password:targetRoot,database:schema,timezone:'Z'});
  const migration=await launch(['--import','tsx','init-db.ts'],resolve('../apps/db-ops-api'),env,'migration');
  await new Promise<void>((ok,fail)=>{migration.once('exit',code=>code===0?ok():fail(Error('Formal migration failed')));migration.once('error',fail);});
  await pool.query("UPDATE users SET password_hash=?,status='active' WHERE username='admin'",[await bcrypt.hash(password,10)]);
  await pool.query("INSERT IGNORE INTO user_roles(user_id,role_id) SELECT u.id,r.id FROM users u JOIN roles r ON r.name='admin' WHERE u.username='admin'");
  await targetPool.query(`CREATE DATABASE ${dataSchema}`);await targetPool.query(`CREATE TABLE ${dataSchema}.readonly_sample(id INT PRIMARY KEY, label VARCHAR(64))`);
  await targetPool.query(`INSERT INTO ${dataSchema}.readonly_sample VALUES(1,'MAX-175 real readonly input')`);
  await targetPool.query('CREATE USER ?@\'%\' IDENTIFIED BY ?',[reader,readerPassword]);
  await targetPool.query(`GRANT SELECT,SHOW VIEW ON ${dataSchema}.* TO ?@'%'`,[reader]);
  await targetPool.query("GRANT PROCESS,REPLICATION CLIENT ON *.* TO ?@'%'",[reader]);
  report.target={host:targetHost,port:33176,container:targetName,image:'mysql:9.6',readonlyUser:reader};
  // SELECT-only source access; copy existing selected provider unchanged into the disposable database.
  const sharedEnv=dotenv.parse(await readFile('/Users/max/Coding/40-Slide/apps/db-ops-api/.env','utf8'));
  const shared=await mysql.createConnection({host:sharedEnv.DB_HOST,port:Number(sharedEnv.DB_PORT??3306),user:sharedEnv.DB_USER,password:sharedEnv.DB_PASSWORD,database:sharedEnv.DB_NAME});
  try {
    const [providers]=await shared.query('SELECT * FROM llm_providers'),[bindings]=await shared.query('SELECT * FROM llm_scene_bindings');
    const chosen=selectSceneModel(providers,bindings,'fault_diagnosis',{requiresFunctionCall:true});
    expect(chosen.model??chosen.provider.default_model).toBe('deepseek-flash');
    const row={...chosen.provider};row.api_key_encrypted=encryptData(decryptData(row.api_key_encrypted,sharedEnv.ENCRYPTION_KEY),encryption);
    const [columns]=await pool.query('SHOW COLUMNS FROM llm_providers');const keys=columns.map((c:any)=>c.Field).filter((k:string)=>k in row);
    await pool.query('DELETE FROM llm_scene_bindings');await pool.query('DELETE FROM llm_providers');
    await pool.query(`INSERT INTO llm_providers (${keys.map((k:string)=>'`'+k+'`').join(',')}) VALUES (${keys.map(()=>'?')})`,keys.map((k:string)=>typeof row[k]==='object'&&!(row[k] instanceof Date)&&row[k]!==null?JSON.stringify(row[k]):row[k]));
    for(const binding of bindings.filter((b:any)=>b.provider_id===row.id)) await pool.query('INSERT INTO llm_scene_bindings(scene,provider_id,model) VALUES(?,?,?)',[binding.scene,binding.provider_id,binding.model]);
    report.provider={id:row.id,name:row.name,model:chosen.model??row.default_model,max_tokens:row.max_tokens,scene:'fault_diagnosis',source:chosen.source,sharedWrites:0};
    Object.assign(env,{MAX175_METER:'1',MAX175_MODEL_ORIGIN:new URL(row.api_base_url).origin,MAX175_OUTPUT_CEILING:String(row.max_tokens)});
  } finally{await shared.end();}
  apiEnvironment=env;const child=await startApi('api');
  report.api={pid:child.pid,cwd:resolve('../apps/db-ops-api'),port:3175,ws:29775,command:'node --import max175-model-meter.mjs --import tsx server.ts',commit:report.candidate};
  await expect.poll(async()=>{if(child.exitCode!==null)throw Error('API exited');try{return(await fetch(api+'/api/health/ready')).status;}catch{return 0;}},{timeout:90000}).toBe(200);
  const login=await request('/api/auth/login',{username:'admin',password},'');expect(login.status).toBe(200);token=login.value.token;
  permissions=(await request('/api/auth/permissions')).value;
  const vite=await launch([resolve('node_modules/vite/bin/vite.js'),'--host','127.0.0.1','--port','5195','--strictPort'],resolve('.'),{...env,MAX175_METER:'0',VITE_API_PROXY_TARGET:api,VITE_AGENT_WS_PROXY_TARGET:'http://127.0.0.1:29775'},'vite');
  report.frontend={pid:vite.pid,port:5195,cwd:resolve('.'),commit:report.candidate};
  await expect.poll(async()=>{try{return(await fetch(site)).status;}catch{return 0;}},{timeout:30000}).toBe(200);await save();
});
test.afterAll(async()=>{
  test.setTimeout(90000);
  for(const c of children.reverse())if(c.exitCode===null){c.kill('SIGTERM');await new Promise<void>(ok=>{c.once('exit',()=>ok());setTimeout(()=>{if(c.exitCode===null)c.kill('SIGKILL');ok();},10000).unref();});}
  report.finalBudget=budget();report.cleanup={processes:children.map(c=>({pid:c.pid,exitCode:c.exitCode,signal:c.signalCode}))};
  report.cleanup.errors=[];
  const clean=async(name:string,fn:()=>Promise<unknown>)=>{try{await fn();}catch(e:any){report.cleanup.errors.push({step:name,code:e.code??e.name});}};
  if(pool)await clean('platform schema and reader',async()=>{
    await pool.query(`DROP DATABASE IF EXISTS ${schema}`);await pool.query(`DROP DATABASE IF EXISTS ${dataSchema}`);await pool.query("DROP USER IF EXISTS ?@'%'",[reader]);
    report.cleanup.schemas=(await pool.query('SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME IN (?,?)',[schema,dataSchema]))[0];
    report.cleanup.users=(await pool.query('SELECT User FROM mysql.user WHERE User=?',[reader]))[0];
  });
  if(pool)await clean('platform pool',()=>pool.end());
  if(targetPool)await clean('target pool',()=>targetPool.end());
  if(targetStarted){
    await clean('sanitized target startup',async()=>{const logs=execFileSync('docker',['logs',targetName],{encoding:'utf8',stdio:['ignore','pipe','pipe']});await writeFile(`${output}/target-startup.log`,logs.replaceAll(targetRoot,'[REDACTED]').replaceAll(readerPassword,'[REDACTED]'));});
    await clean('stop task container',async()=>{execFileSync('docker',['stop',targetName],{stdio:'pipe'});});
    await clean('remove task container and volume',async()=>{execFileSync('docker',['rm','--volumes',targetName],{stdio:'pipe'});report.cleanup.targetRemoved=true;});
  }
  await save();
});
(process.env.MAX175_PERMISSIONS_ONLY==='1'?test.skip:test)('production binding, scheduler, resource UI and real readonly Agent',async({page})=>{
  test.setTimeout(300000);
  const created=await request('/api/database/instances',{name:'MAX-175 R11 readonly MySQL',environment:'testing',db_type:'mysql',host:targetHost,port:33176,username:reader,password:readerPassword,database_name:dataSchema});
  expect(created.status).toBe(200);instanceId=created.value.id;report.resource={type:'instance',id:instanceId,dataSchema,readonlyUser:reader};
  const connected=await request(`/api/database/instances/${instanceId}/reload`,{});report.connection=connected;expect(connected.status).toBe(200);expect(connected.value.success).toBe(true);
  const catalog=(await request('/api/metrics/config/catalog')).value;
  const pkg=catalog.packages.find((r:any)=>r.package.id==='mysql-basic'&&r.package.version==='2.0.0').package;const pin={id:pkg.id,version:pkg.version,digest:pkg.digest};
  const policy=`/api/metrics/policy/resources/instance/${instanceId}`;
  const overrides={enabled:'enable',interval_ms:{mode:'set',value:5000},timeout_ms:{mode:'set',value:5000}};
  report.invalidBinding=await request(policy+'/publish',{expected_revision:0,package:pin,overrides:{interval_ms:{mode:'set',value:0}}});expect(report.invalidBinding.status).toBe(400);
  report.publish=await request(policy+'/publish',{expected_revision:0,package:pin,overrides});expect(report.publish.status).toBe(200);
  report.binding=(await request(policy)).value;expect(report.binding.binding.revision).toBe(1);
  const jobs=async()=> (await pool.query("SELECT id,state,payload,attempts,last_error,created_at,completed_at FROM workflow_jobs WHERE job_type='metrics.collect' ORDER BY created_at"))[0];
  try {await expect.poll(async()=>{const rows=await jobs();report.jobs=rows;await save();if(rows.some((j:any)=>j.state==='dead_letter'))throw Error('METRIC_JOB_DEAD_LETTER');return rows.filter((j:any)=>j.state==='completed').length;},{timeout:45000}).toBeGreaterThanOrEqual(2);report.checks.twoCycles=true;}
  catch {report.checks.twoCycles=false;}
  report.observations=(await pool.query("SELECT id,stage,payload,stored_at FROM metric_observations ORDER BY stored_at LIMIT 60"))[0];
  report.checks.normalizedObservations=report.observations.some((r:any)=>r.stage==='normalized');
  report.collectionAttempts=(await pool.query('SELECT id,payload,stored_at FROM metric_attempts'))[0];
  report.schedule=(await pool.query('SELECT * FROM metric_schedule'))[0];report.events=(await pool.query('SELECT * FROM metric_schedule_events'))[0];
  report.effective=(await request(policy+'/effective')).value;await save();
  if(!schedulerOnly){
  await page.addInitScript(({token,permissions})=>{localStorage.setItem('token',token);localStorage.setItem('slide.control.session_token.v1',token);localStorage.setItem('permissions',JSON.stringify(permissions));localStorage.setItem('slide.i18n.locale','zh-CN');},{token,permissions});
  await page.goto(`${site}/instance-detail?id=${instanceId}`);await expect(page.locator('instance-detail-page')).toContainText('MAX-175 R11 readonly MySQL');
  await page.screenshot({path:`${output}/resource-real.png`,fullPage:true});
  await page.getByRole('link',{name:'查看此资源的全部调查'}).click();
  await page.getByRole('button',{name:'创建手动调查',exact:true}).click();
  const form=page.locator('investigation-create');await form.getByLabel('调查标题',{exact:true}).fill('MAX-175 R11 真实只读调查');
  await form.getByLabel('调查目标',{exact:true}).fill(`目标为 resourceType=instance、resourceId=${instanceId} 的 MySQL。只做一次只读调查：仅调用一次 get_resource_observations，参数 resourceType=instance、resourceId=${instanceId}、metricIds=[connections]、limit=1，获取已保存的观测证据，然后立即用简短文字报告返回的事实、来源、时间及缺口。无需调用其他工具，不执行 SQL、SSH 或写操作，不推断根因。`);
  await form.getByRole('checkbox',{name:'MAX-175 R11 readonly MySQL · 数据库实例',exact:true}).check();
  const admitted=page.waitForResponse(r=>r.url().endsWith('/api/investigations')&&r.request().method()==='POST');
  await form.getByRole('button',{name:'提交调查',exact:true}).click();const response=await admitted;report.agentAdmission={status:response.status(),value:await response.json()};await save();expect(response.status()).toBe(202);
  try {await expect.poll(async()=>{const [rows]=await pool.query('SELECT id,session_id,lifecycle FROM investigations');report.investigations=rows;const [runs]=await pool.query('SELECT id,session_id,state,result_json FROM agent_runs');report.agentRuns=runs;await save();return runs.some((r:any)=>r.state==='completed')?'completed':runs.some((r:any)=>['failed','unknown','partial','cancelled','timed_out'].includes(r.state))?'failed':'pending';},{timeout:160000}).not.toBe('pending');report.checks.agentCompleted=report.agentRuns.some((r:any)=>r.state==='completed');}catch{report.checks.agentCompleted=false;}
  report.results=(await pool.query('SELECT * FROM investigation_results'))[0];report.evidence=(await pool.query('SELECT * FROM investigation_evidence'))[0];report.requests=(await pool.query('SELECT * FROM investigation_requests'))[0];
  report.checks.agentEvidenceRead=report.evidence.some((r:any)=>r.raw_json?.data?.observations?.length>0);
  const agentObservations=report.evidence.flatMap((r:any)=>r.raw_json?.data?.observations??[]);
  report.checks.agentObservationTimesValid=agentObservations.length>0&&agentObservations.every((r:any)=>typeof r.observedAt==='string'&&Number.isFinite(Date.parse(r.observedAt))&&r.observedAt===new Date(r.observedAt).toISOString()&&typeof r.validUntil==='string'&&Number.isFinite(Date.parse(r.validUntil)));
  report.checks.agentResultPersisted=report.results.length>0;report.checks.modelMeterCaptured=budget().requests>report.baselineBudget.requests;
  if(report.checks.agentCompleted){
    await page.getByRole('button',{name:'查看证据与成果',exact:true}).click();
    await expect(page.locator('investigation-context').filter({visible:true})).toContainText(report.results[0].result_json.summary);
    report.checks.agentDetail=true;
  }
  await page.screenshot({path:`${output}/agent-result-real.png`,fullPage:true});await page.reload();if(report.checks.agentCompleted){
    await expect(page.locator('.investigation-states')).toContainText('执行完成',{timeout:30000});
    await page.getByRole('button',{name:'查看证据与成果',exact:true}).click();
    await expect(page.locator('investigation-context').filter({visible:true})).toContainText(report.results[0].result_json.summary);
  }
  await page.screenshot({path:`${output}/agent-refresh-real.png`,fullPage:true});report.checks.agentRefresh=report.checks.agentCompleted;
  const permissionCheck=await launch(['--import','tsx','../../scripts/qualification/max175-failure-permissions.ts'],resolve('../apps/db-ops-api'),{...process.env,MAX175_CHECK_SCHEMA:schema,MAX175_TARGET_HOST:targetHost,MAX175_DB_PASSWORD:targetRoot,MAX175_OUTPUT_DIR:output},'permissions');
  report.checks.failurePermissions=await new Promise<boolean>(ok=>permissionCheck.once('exit',code=>ok(code===0)));await save();
  }
  report.disable=await request(policy+'/publish',{expected_revision:1,overrides:{...overrides,enabled:'disable'}});expect(report.disable.status).toBe(200);
  await expect.poll(async()=>((await request(policy)).value.application.applied_revision),{timeout:15000}).toBe(2);
  const count=async()=>Number((await pool.query('SELECT COUNT(*) n FROM metric_attempts'))[0][0].n);
  const before=await count(),jobsBefore=await jobs(),stoppedAt=new Date().toISOString();await new Promise(ok=>setTimeout(ok,11000));report.stop={stoppedAt,before,after:await count(),jobsBefore,jobs:await jobs()};
  report.checks.stopNoCollection=report.stop.after===before;report.checks.stopNoNewTasks=report.stop.jobs.length===jobsBefore.length;await save();
  // A fresh production process must honor persisted disabled application state.
  const stoppedPid=apiProcess.pid;apiProcess.kill('SIGTERM');
  await new Promise<void>((ok,fail)=>{
    const grace=setTimeout(()=>{report.restartRequiredSecondSignal=true;apiProcess.kill('SIGTERM');},10000);
    const deadline=setTimeout(()=>fail(Error('Owned API shutdown timeout')),25000);
    apiProcess.once('exit',()=>{clearTimeout(grace);clearTimeout(deadline);ok();});
  });
  await startApi('api-restarted');
  const restartBefore=await jobs(),restartAttempts=await count(),restartAt=new Date().toISOString();
  await new Promise(ok=>setTimeout(ok,11000));
  report.restartStop={stoppedPid,restartAt,before:restartBefore,after:await jobs(),attemptsBefore:restartAttempts,attemptsAfter:await count()};
  report.checks.restartNoTasks=report.restartStop.after.length===restartBefore.length&&report.restartStop.attemptsAfter===restartAttempts;
  expect.soft(report.checks.restartNoTasks,'Reloaded scheduler must keep disabled revision stopped').toBe(true);
  report.reenable=await request(policy+'/publish',{expected_revision:2,overrides});expect(report.reenable.status).toBe(200);
  await expect.poll(async()=> (await jobs()).filter((j:any)=>j.state==='completed'&&j.payload.revision===3).length,{timeout:25000}).toBeGreaterThanOrEqual(1);
  report.checks.newRevisionResumes=true;
  report.finalDisable=await request(policy+'/publish',{expected_revision:3,overrides:{...overrides,enabled:'disable'}});expect(report.finalDisable.status).toBe(200);
  await expect.poll(async()=>((await request(policy)).value.application.applied_revision),{timeout:15000}).toBe(4);
  const finalJobs=await jobs(),finalAttempts=await count(),finalAt=new Date().toISOString();await new Promise(ok=>setTimeout(ok,11000));
  report.finalStop={at:finalAt,before:finalJobs,after:await jobs(),attemptsBefore:finalAttempts,attemptsAfter:await count()};
  report.checks.finalStop=report.finalStop.after.length===finalJobs.length&&report.finalStop.attemptsAfter===finalAttempts;
  expect.soft(report.checks.finalStop,'New disabled revision also stops after application').toBe(true);
  report.finalBinding=(await request(policy)).value;
  if(schedulerOnly){report.checks.noNewModelCalls=budget().requests===report.baselineBudget.requests;expect(report.checks.noNewModelCalls).toBe(true);}
  await save();
  if(!schedulerOnly){
  expect.soft(report.checks.agentObservationTimesValid,'Observation timestamps must survive Agent evidence serialization').toBe(true);expect.soft(report.checks.agentEvidenceRead,'Actual observation tool evidence is required').toBe(true);expect.soft(report.checks.agentCompleted,'Real Agent must complete').toBe(true);expect.soft(report.checks.agentRefresh,'Agent result must survive refresh').toBe(true);expect.soft(report.checks.failurePermissions,'Real failure and permissions checks').toBe(true);}
  expect.soft(report.checks.stopNoCollection,'Disabled binding causes no collection').toBe(true);expect.soft(report.checks.stopNoNewTasks,'Contract requires no new jobs after disable').toBe(true);
  expect(report.checks.twoCycles,'Two real scheduler cycles are required; independent Agent and permission evidence is retained on failure').toBe(true);
});

(process.env.MAX175_PERMISSIONS_ONLY==='1'?test:test.skip)('independent real failure and revocation without model calls',async()=>{
  test.setTimeout(120000);
  const created=await request('/api/database/instances',{name:'MAX-175 R11 readonly MySQL',environment:'testing',db_type:'mysql',host:targetHost,port:33176,username:reader,password:readerPassword,database_name:dataSchema});
  expect(created.status).toBe(200);instanceId=created.value.id;
  report.resource={type:'instance',id:instanceId,dataSchema,readonlyUser:reader};
  report.connection=await request(`/api/database/instances/${instanceId}/reload`,{});expect(report.connection.status).toBe(200);
  const check=await launch(['--import','tsx','../../scripts/qualification/max175-failure-permissions.ts'],resolve('../apps/db-ops-api'),{...process.env,MAX175_CHECK_SCHEMA:schema,MAX175_TARGET_HOST:targetHost,MAX175_DB_PASSWORD:targetRoot,MAX175_OUTPUT_DIR:output},'permissions');
  report.checks.failurePermissions=await new Promise<boolean>(ok=>check.once('exit',code=>ok(code===0)));
  report.checks.noNewModelCalls=budget().requests===report.baselineBudget.requests;await save();
  expect(report.checks.failurePermissions).toBe(true);expect(report.checks.noNewModelCalls).toBe(true);
});
