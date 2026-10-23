import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { fork, execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import mysql, { type Pool, type RowDataPacket } from 'mysql2/promise';
import Fastify from 'fastify';
import { ToolRegistry, OpenAIProvider, estimateWithProvider, type LLMProvider } from '@slide/agent-core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MigrationRunner } from '../migrations/runner.js';
import { ActorContextService, signAccessToken } from '../auth/actor-context.js';
import { createVerifyToken } from '../auth-middleware.js';
import { InvestigationAuthorization } from './authorization.js';
import { InvestigationSessionBridge, investigationBudgetConfiguration } from './session-bridge.js';
import { InvestigationExecutor, investigationContextMessages } from './executor.js';
import { LegacyAnalysisBridge } from './legacy-analysis-bridge.js';
import { registerInvestigationRoutes } from './routes.js';
import { MysqlWorkflowStore, WorkerRuntime } from '../workflows/worker-runtime.js';
import { createInvestigationWorkflowHandler } from './workflow-handler.js';
import { MysqlInvestigationBudgetLedger } from './budget-ledger.js';
import { INVESTIGATION_PROFILES } from './profiles.js';
import { MAX222_OFFLINE_EXECUTION } from './execution-allocation.js';
import { planned, batches, toolReply, syntheticAnalysisFromWire, sha, bytes } from './execution-allocation.fixture.js';

// Opt-in integration gate. The runner owns a fresh container and schema; it
// never uses DB_* or the application's .env/real provider credentials.
describe.skipIf(process.env.FROZEN_ALLOCATION_MYSQL !== '1')('frozen task allocation / JWT HTTP + Worker + SQL + loopback SDK', () => {
  const database = `inv_allocation_${process.pid}_${randomUUID().replaceAll('-','')}`;
  const container = `slide-frozen-${process.pid}-${randomUUID()}`;
  const secret = randomUUID();
  const policy = {...investigationBudgetConfiguration().policy, maxAutomaticTokensPerDay:1200000, maxTotalTokensPerDay:1200000};
  const budget = {domain:`qualification.max222.${randomUUID()}`,policy,reserveCostMicros:1000000,
    prices:{input:1,cachedInput:1,output:1}, taskExecution:MAX222_OFFLINE_EXECUTION};
  let admin:Pool, pool:Pool, contexts:ActorContextService, authorization:InvestigationAuthorization;
  let app:ReturnType<typeof Fastify>, baseURL:string, token:string, mysqlPort:number;
  const rows = async(sql:string, params:any[]=[]) => (await pool.query<RowDataPacket[]>(sql,params))[0];
  const decode=(v:any)=>typeof v==='string'?JSON.parse(v):v;
  const save=(name:string,v:unknown)=>{ const dir=process.env.FROZEN_ALLOCATION_EVIDENCE_DIR; if(dir){mkdirSync(dir,{recursive:true});writeFileSync(join(dir,name+'.json'),JSON.stringify(v,null,2)+'\n');} };
  const ledger=()=>new MysqlInvestigationBudgetLedger(()=>pool,policy);
  const startAPI=async()=>{
    const bridge=new InvestigationSessionBridge(()=>pool,authorization,budget);
    app=Fastify(); await registerInvestigationRoutes(app,createVerifyToken(secret,contexts),bridge,bridge.observationServices(),new LegacyAnalysisBridge(()=>pool,authorization,bridge));
    baseURL=await app.listen({host:'127.0.0.1',port:0});
  };
  const http=async(path:string,body?:unknown)=>{
    const response=await fetch(baseURL+'/api/investigations'+path,{method:body?'POST':'GET',
      headers:{authorization:`Bearer ${token}`,...(body?{'content-type':'application/json','idempotency-key':randomUUID()}: {})},
      ...(body?{body:JSON.stringify(body)}:{})});
    return {status:response.status,body:await response.json() as any};
  };
  const admit=()=>http('',{title:'SYNTHETIC frozen allocation',goal:'合成数据集成验证，不是自主分析或正式采集。',profileId:'ops',
    resourceRefs:[{type:'instance',id:1,role:'primary'},{type:'server',id:3,role:'related'}],
    subject:{kind:'resource',resource:{type:'instance',id:1}}});
  beforeAll(async()=>{
    execFileSync('docker',['run','--detach','--rm','--name',container,'--env','MYSQL_ALLOW_EMPTY_PASSWORD=yes','--publish','127.0.0.1::3306','mysql:8.4'],{stdio:'pipe'});
    const port=mysqlPort=Number(execFileSync('docker',['port',container,'3306/tcp'],{encoding:'utf8'}).trim().split(':').at(-1));
    const options={host:'127.0.0.1',port,user:'root',password:'',timezone:'Z'};
    admin=mysql.createPool(options);
    const until=Date.now()+45000;
    for(;;){try{await admin.query('SELECT 1');break;}catch(e){if(Date.now()>until)throw e;await new Promise(r=>setTimeout(r,250));}}
    await admin.query(`CREATE DATABASE ${database}`);pool=mysql.createPool({...options,database,connectionLimit:12});
    pool.on('connection',c=>c.query("SET time_zone='+00:00'"));
    await new MigrationRunner(pool).run();
    await pool.query("INSERT INTO users (id,username,password_hash) VALUES (101,'synthetic-allocation','no-login')");
    await pool.query("INSERT INTO roles (id,name) VALUES (101,'synthetic-allocation')");
    await pool.query("INSERT INTO role_permissions (role_id,permission_id) SELECT 101,id FROM permissions WHERE code IN ('chat:view','instance:view','metric:view','alert:view','servers:view')");
    await pool.query('INSERT INTO user_roles (user_id,role_id) VALUES (101,101)');
    await pool.query("INSERT INTO database_instances (id,name,host,port,username,password_encrypted) VALUES (1,'synthetic-instance','fixture.invalid',3306,'unused','unused')");
    await pool.query("INSERT INTO servers (id,label,host,os_type,credential_type,credential_encrypted) VALUES (3,'synthetic-server','fixture.invalid','Other','password','unused')");
    await pool.query("INSERT INTO instance_permissions (user_id,instance_id,access_level) VALUES (101,1,'read-only')");
    contexts=new ActorContextService(()=>pool as never);authorization=new InvestigationAuthorization(contexts);
    token=signAccessToken(await contexts.loadActiveActor(101),secret);
    await startAPI();
    save('identity',{pid:process.pid,cwd:process.cwd(),container,database,port,apiURL:baseURL,command:'FROZEN_ALLOCATION_MYSQL=1 vitest execution-allocation.mysql.test.ts',
      baseline:'33b9eb081fac24de1eaf2ae2bb25d85916d63c5f',fixtureSha256:sha(bytes),scope:'disposable synthetic data, no target or product provider'});
  },60000);
  beforeEach(async()=>{
    for(const table of ['investigation_results','investigation_evidence','investigation_stream_events','investigation_stream_heads','investigation_observed_sources',
      'investigation_budget_resources','investigation_budget_ledger','investigation_budget_domains','investigation_admission_keys','investigation_create_keys',
      'investigation_members','investigation_resources','investigation_requests','investigations','agent_canonical_facts','agent_runs','chat_messages','chat_sessions','workflow_jobs','outbox_events']) await pool.query(`DELETE FROM ${table}`);
  });
  afterAll(async()=>{
    await app?.close();await pool?.end();
    if(admin){if(!/^inv_allocation_\d+_[a-f0-9]+$/.test(database))throw Error('UNSAFE_TEST_SCHEMA');await admin.query(`DROP DATABASE IF EXISTS ${database}`);await admin.end();}
    execFileSync('docker',['stop','--time','10',container],{stdio:'pipe'});
    save('cleanup',{container,database,apiClosed:true,poolClosed:true,containerStopped:true});
  },30000);
  async function execute(provider:LLMProvider,tools:ToolRegistry,options:Record<string,any>={}){
    const executor=new InvestigationExecutor({pool:()=>pool,authorization,providerForPurpose:async()=>provider,toolsForActor:()=>tools,budget,...options});
    const worker=new WorkerRuntime(new MysqlWorkflowStore(()=>pool as never),'frozen-worker',120);
    const handler=createInvestigationWorkflowHandler(async()=>({executeInvestigation:(c:any)=>executor.execute(c)} as any));
    let command:any,run:any;
    try{await worker.runOnce(async(job,context)=>{command={investigationId:(job.payload as any).investigationId,requestId:(job.payload as any).requestId,job,context};run=await handler(job.payload,job,context);});}
    finally{await worker.shutdown(5000);}
    return {run,command,executor};
  }
  it('admits, freezes, dispatches 36 reads, publishes strict references and survives two API/Worker restarts with zero sends',async()=>{
    const accepted=await admit();expect(accepted.status).toBe(202);
    const {requestId,id}=accepted.body;
    const request=decode((await rows('SELECT request_snapshot FROM investigation_requests WHERE id=?',[requestId]))[0].request_snapshot);
    expect(request.executionAllocation.configuration).toEqual(MAX222_OFFLINE_EXECUTION);
    const wires:any[]=[],responses:any[]=[],executed:string[]=[],estimates:number[]=[];
    let nextInput=0;
    let oracle:ReturnType<typeof syntheticAnalysisFromWire>|undefined, error:unknown;
    const receiver=createServer(async(req,res)=>{try{
      const chunks:Buffer[]=[];for await(const c of req)chunks.push(c);
      const body=JSON.parse(Buffer.concat(chunks).toString()),index=wires.length;wires.push(body);
      expect(body.max_tokens).toBe(8192);expect(body.tools?.length??0).toBe(index===3?0:body.tools.length);
      if(index===3)oracle=syntheticAnalysisFromWire(body);
      const message=index<3?toolReply(batches[index]):{role:'assistant',content:JSON.stringify(oracle!.answer)};
      const reply={choices:[{index:0,message,finish_reason:index<3?'tool_calls':'stop'}],usage:{prompt_tokens:nextInput,completion_tokens:8192,prompt_tokens_details:{cached_tokens:0}}};
      responses.push(reply);res.setHeader('content-type','application/json');res.end(JSON.stringify(reply));
    }catch(e){error=e;res.statusCode=500;res.end(JSON.stringify({error:{message:'SYNTHETIC_ASSERTION',type:'local'}}));}});
    await new Promise<void>(r=>receiver.listen(0,'127.0.0.1',r));
    const actual=new OpenAIProvider({apiKey:'synthetic-unused',model:'deepseek-flash',baseURL:`http://127.0.0.1:${(receiver.address() as any).port}/v1`,
      capabilities:{model:'deepseek-flash',contextWindowTokens:1048576,maxOutputTokens:393216,source:'configuration',version:'synthetic-frozen-allocation/v1'}});
    const tools=new ToolRegistry();
    for(const name of new Set(planned.map(p=>p.call.function.name)))tools.register({name,description:'Synthetic local readonly receipt',parameters:{type:'object',properties:{}},readOnly:true,concurrencySafe:false,exclusive:true,
      execute:async(args:any)=>{
        const p=planned[executed.length];expect(p.call.function.name).toBe(name);
        const expected=JSON.parse(p.call.function.arguments);
        for(const [k,v]of Object.entries(expected))expect(args[k]).toEqual(v);
        executed.push(p.call.id);return structuredClone(p.receipt);
      }});
    const projection={getModelCapabilities:actual.getModelCapabilities.bind(actual),countPromptTokens:actual.countPromptTokens.bind(actual),
      projectMessages:(m:any[])=>investigationContextMessages(actual.projectMessages(m),'ops')};
    const provider:LLMProvider={getDefaultModel:()=>actual.getDefaultModel(),...projection,
      chat:async(messages,defs,options)=>{
        nextInput=estimateWithProvider(projection.projectMessages(messages),defs??[],'deepseek-flash',provider).tokens;
        expect(nextInput).toBeLessThanOrEqual(285696);estimates.push(nextInput);
        return actual.chat(messages,defs,options);
      },chatStream:async()=>{throw Error('UNPLANNED_SUMMARY');}};
    let result:any;
    try{result=await execute(provider,tools);}finally{await new Promise<void>(r=>receiver.close(()=>r()));}
    if(error)throw error;
    save('joint-attempt',{accepted,wires,responses,executed,run:result.run});
    expect(result.run.state).toBe('completed');expect(wires).toHaveLength(4);expect(executed).toHaveLength(36);
    expect(wires[3].tools??[]).toHaveLength(0);
    const state=result.run.result.investigationExecution;
    expect(state.executionAllocation).toEqual(request.executionAllocation);expect(state.allocationRunId).toBe(result.run.id);
    expect(state.reservedTokens).toBe(1200000);expect(state.runtimeContext).toMatchObject({contextWindowTokens:294912,maxTokens:8192,summaryMaxTokens:10240});
    const [entry]=await rows('SELECT * FROM investigation_budget_ledger WHERE request_id=?',[requestId]);
    expect(entry.state).toBe('settled');expect(Number(entry.reserved_tokens)).toBe(1200000);expect(Number(entry.charged_tokens)).toBe(estimates.reduce((n,x)=>n+x+8192,0));
    expect(Number(entry.charged_tokens)).toBeGreaterThan(128000);
    expect(decode(entry.reservation_snapshot).executionAllocation.hash).toBe(request.executionAllocation.hash);
    const frozen=decode((await rows('SELECT request_snapshot FROM investigation_requests WHERE id=?',[requestId]))[0].request_snapshot);
    expect(frozen.budgetReceipt.executionAllocationHash).toBe(request.executionAllocation.hash);
    const evidence=await rows('SELECT * FROM investigation_evidence WHERE investigation_id=?',[id]);
    const byCall=new Map(evidence.map(e=>[decode(e.metadata_json).source.slice(5),e]));
    // Audit EVERY FS pair, each of six windows, against real SQL evidence, not
    // merely the strict schema or the first FS claim in the scripted answer.
    const audit=oracle!.filesystems.map((fs:any)=>{
      const pair=fs.toolCallIds.map((callId:string)=>{const e=byCall.get(callId)!;expect(e).toBeTruthy();return {callId,evidenceId:e.id,contentHash:e.content_hash};});
      for(const callId of fs.toolCallIds){const e=byCall.get(callId)!;const raw=decode(e.raw_json);const p=planned.find(p=>p.call.id===callId)!;expect(raw).toEqual(p.receipt);}
      expect(fs.rows).toHaveLength(6);return {...fs,sources:pair};
    });
    expect(audit).toHaveLength(11);
    const published=await http(`/${id}/results`);expect(published.status).toBe(200);
    expect(published.body.items[0].result.summary).toBe(oracle!.answer.summary);
    expect(published.body.items[0].result.claims[3].supportingEvidenceIds).toEqual(oracle!.filesystems[0].toolCallIds.map((c:string)=>byCall.get(c)!.id));
    const debugBridge=new InvestigationSessionBridge(()=>pool,authorization,budget);
    const debugActor=await contexts.loadActiveActor(101);
    for(const [stage,work]of Object.entries({detail:()=>debugBridge.storeFor(debugActor).detail({kind:'user',id:101},id),stream:()=>debugBridge.observationServices().stream.snapshot(debugActor,id),legacy:()=>new LegacyAnalysisBridge(()=>pool,authorization,debugBridge).read(debugActor,id)})){
      try{await work();}catch(e){save('detail-diagnostic',{stage,message:String(e),stack:(e as Error).stack});throw e;}
    }
    const before=await http(`/${id}`);save('detail-attempt',before);expect(before.status).toBe(200);expect(before.body.latestResult).toEqual(published.body.items[0]);
    const snapshot=await rows('SELECT * FROM agent_runs WHERE id=?',[result.run.id]);
    const recoveryProcesses:any[]=[];
    await app.close();
    for(let i=0;i<2;i++){
      // Explicit test fixture: lost workflow completion ack. Recovery must claim
      // a NEW lease/fence; the old completed-job lease correctly refuses reuse.
      await pool.query("UPDATE workflow_jobs SET state='retry',lease_owner=NULL,lease_expires_at=NULL,available_at=NOW(3) WHERE id=?",[result.command.job.id]);
      const child=fork(fileURLToPath(new URL('./execution-allocation-child.ts',import.meta.url)),[],{
        execArgv:['--import',import.meta.resolve('tsx')],silent:true,env:{...process.env,FROZEN_ALLOCATION_MYSQL:'1'}});
      let diagnostic='';child.stdout?.on('data',v=>{diagnostic+=v;});child.stderr?.on('data',v=>{diagnostic+=v;});
      const messages:any[]=[];
      const exited=new Promise<void>((resolve,reject)=>child.once('exit',(code)=>code===0?resolve():reject(Error('CHILD_EXIT '+code+' '+diagnostic))));
      const ready=new Promise<any>((resolve,reject)=>{
        child.on('message',(m:any)=>{messages.push(m);if(m.point==='ready')resolve(m);if(m.point==='error')reject(Error(m.message));});
        child.once('error',reject);
      });
      child.send({database,port:mysqlPort,domain:budget.domain,secret});
      try{
        const info=await ready;expect(info.sends).toBe(0);expect(info.handlers).toBe(0);expect(info.runId).toBe(result.run.id);
        baseURL=info.url;
        expect((await http(`/${id}`)).body.latestResult).toEqual(before.body.latestResult);
        expect(await rows('SELECT * FROM agent_runs WHERE id=?',[result.run.id])).toEqual(snapshot);
      }finally{child.send({stop:true});await exited;recoveryProcesses.push({messages,diagnostic});}
    }
    expect(recoveryProcesses[0].messages[0].pid).not.toBe(recoveryProcesses[1].messages[0].pid);
    await startAPI();
    expect(wires).toHaveLength(4);expect(executed).toHaveLength(36);
    const tables:Record<string,any>={};for(const table of ['investigation_requests','agent_runs','agent_canonical_facts','investigation_budget_domains','investigation_budget_ledger','investigation_evidence','investigation_results','workflow_jobs'])tables[table]=await rows(`SELECT * FROM ${table}`);
    save('joint-success',{scope:'synthetic responses/usage, actual JWT HTTP SDK Worker SQL; NOT autonomous model/live collectors',accepted,wires,responses,estimates,executed,fsAudit:audit,tables,published,before,recoveryProcesses,summaryRequests:0,restarts:2,newSendsOnRecovery:0});
  },60000);

  it.each(['hash','request','domain','configuration'])('rejects corrupted admission %s durably before SDK and handlers',async(kind)=>{
    const accepted=await admit();expect(accepted.status).toBe(202);
    const req=(await rows('SELECT request_snapshot FROM investigation_requests WHERE id=?',[accepted.body.requestId]))[0];
    const snapshot=decode(req.request_snapshot);
    if(kind==='hash')snapshot.executionAllocation.hash='0'.repeat(64);
    if(kind==='request')snapshot.executionAllocation.requestId=randomUUID();
    if(kind==='domain')snapshot.executionAllocation.domain='investigation-v1';
    if(kind==='configuration')snapshot.executionAllocation.configuration.maxToolCalls=37;
    await pool.query('UPDATE investigation_requests SET request_snapshot=? WHERE id=?',[JSON.stringify(snapshot),accepted.body.requestId]);
    let sends=0;const provider:LLMProvider={getDefaultModel:()=> 'fixture',chat:async()=>{sends++;throw Error('SHOULD_NOT_SEND');},chatStream:async()=>{sends++;throw Error('SHOULD_NOT_SEND');}};
    const {run}=await execute(provider,new ToolRegistry());expect(run.state).toBe('failed');expect(sends).toBe(0);
    expect(await rows('SELECT * FROM investigation_budget_ledger')).toHaveLength(0);
    save('rejected-'+kind,{run,sends,ledgerRows:0});
  });
  it('rejects 37 tools atomically, executing no prefix of the batch',async()=>{
    const accepted=await admit();expect(accepted.status).toBe(202);
    let sends=0,handlers=0;
    const provider:LLMProvider={getDefaultModel:()=> 'synthetic',getModelCapabilities:()=>({model:'synthetic',contextWindowTokens:1048576,maxOutputTokens:393216,source:'configuration',version:'synthetic/v1'}),
      chat:async()=>{sends++;return {content:null,finishReason:'tool_calls',hasToolCalls:true,shouldExecuteTools:true,
        toolCalls:Array.from({length:37},(_,i)=>({id:`synthetic-overflow-${i}`,name:'get_instance_summary',arguments:{instance_id:1}})),usage:{prompt_tokens:100,completion_tokens:100}};},
      chatStream:async()=>{throw Error('UNPLANNED_SUMMARY');}};
    const tools=new ToolRegistry();tools.register({name:'get_instance_summary',description:'Synthetic',parameters:{type:'object',properties:{}},readOnly:true,concurrencySafe:false,exclusive:true,execute:async()=>{handlers++;return {success:true};}});
    const {run}=await execute(provider,tools);
    expect(sends).toBe(1);expect(handlers).toBe(0);expect(Object.keys(run.result.investigationExecution.tools)).toHaveLength(0);
    expect(run.state).not.toBe('completed');save('overflow-37',{run,sends,handlers,canonical:await rows('SELECT * FROM agent_canonical_facts')});
  });
  it.each(['receipt','run'])('refuses changed %s identity before the first handler or next SDK',async(kind)=>{
    const accepted=await admit();expect(accepted.status).toBe(202);
    let sends=0,handlers=0;
    const provider:LLMProvider={getDefaultModel:()=> 'synthetic',getModelCapabilities:()=>({model:'synthetic',contextWindowTokens:1048576,maxOutputTokens:393216,source:'configuration',version:'synthetic/v1'}),
      chat:async()=>{sends++;
        if(kind==='receipt'){
          const row=(await rows('SELECT request_snapshot FROM investigation_requests WHERE id=?',[accepted.body.requestId]))[0],snapshot=decode(row.request_snapshot);
          snapshot.budgetReceipt.executionAllocationHash='0'.repeat(64);
          await pool.query('UPDATE investigation_requests SET request_snapshot=? WHERE id=?',[JSON.stringify(snapshot),accepted.body.requestId]);
        }else{
          const row=(await rows('SELECT id,result_json FROM agent_runs'))[0],state=decode(row.result_json);
          state.investigationExecution.allocationRunId=randomUUID();
          await pool.query('UPDATE agent_runs SET result_json=? WHERE id=?',[JSON.stringify(state),row.id]);
        }
        return {content:null,finishReason:'tool_calls',hasToolCalls:true,shouldExecuteTools:true,
          toolCalls:[{id:'synthetic-mismatch',name:'get_instance_summary',arguments:{instance_id:1}}],usage:{prompt_tokens:100,completion_tokens:100}};},chatStream:async()=>{throw Error('UNPLANNED_SUMMARY');}};
    const tools=new ToolRegistry();tools.register({name:'get_instance_summary',description:'Synthetic',parameters:{type:'object',properties:{}},readOnly:true,concurrencySafe:false,exclusive:true,execute:async()=>{handlers++;return {success:true};}});
    const {run}=await execute(provider,tools);expect(sends).toBe(1);expect(handlers).toBe(0);expect(run.state).not.toBe('completed');save('mismatch-'+kind,{run,sends,handlers});
  });
  it('rejects task/domain/limit injection through the public HTTP contract',async()=>{
    const response=await http('',{title:'forged',goal:'forged',profileId:'ops',resourceRefs:[{type:'instance',id:1,role:'primary'}],subject:{kind:'resource',resource:{type:'instance',id:1}},
      taskExecution:MAX222_OFFLINE_EXECUTION,domain:budget.domain});
    expect(response.status).toBe(400);expect(await rows('SELECT id FROM investigation_requests')).toHaveLength(0);
  });
  it('uses the same isolated daily policy for admission, unknown charge and recovery without erasing history',async()=>{
    const a=await admit(),requestId=a.body.requestId;
    const snapshot=decode((await rows('SELECT request_snapshot FROM investigation_requests WHERE id=?',[requestId]))[0].request_snapshot);
    const admission=await ledger().reserveExecution({requestId,domain:budget.domain,mode:'manual',profile:INVESTIGATION_PROFILES.ops,reserveTokens:1200000,reserveCostMicros:1000000,
      prices:budget.prices,executionAllocation:snapshot.executionAllocation});
    expect(admission.accepted).toBe(true);if(admission.accepted === false)throw Error(admission.reason);
    await ledger().markSent(admission.reservation.id);await ledger().settle(admission.reservation.id,null);
    const prior=await rows('SELECT * FROM investigation_budget_ledger');
    const b=await admit();const bs=decode((await rows('SELECT request_snapshot FROM investigation_requests WHERE id=?',[b.body.requestId]))[0].request_snapshot);
    const blocked=await ledger().reserveExecution({requestId:b.body.requestId,domain:budget.domain,mode:'manual',profile:INVESTIGATION_PROFILES.ops,reserveTokens:1200000,reserveCostMicros:1000000,
      prices:budget.prices,executionAllocation:bs.executionAllocation});
    expect(blocked).toEqual({accepted:false,reason:'TOTAL_DAILY_TOKENS'});
    expect(await rows('SELECT * FROM investigation_budget_ledger')).toEqual(prior);
    expect(prior[0].state).toBe('unknown');expect(Number(prior[0].charged_tokens)).toBe(1200000);
    save('daily-unknown',{admission,blocked,prior});
  });
});
