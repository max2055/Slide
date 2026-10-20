import { createOperationsComposition } from '../../../apps/db-ops-api/src/operations/composition.ts';
import { createActionWorker } from '../../../apps/db-ops-api/src/operations/actions/worker.ts';
import { MysqlWorkflowStore } from '../../../apps/db-ops-api/src/workflows/worker-runtime.ts';
import { startHelperSshFixture } from '../../../apps/db-ops-api/src/operations/actions/helper-ssh.fixture.ts';
import { registerContextFixture } from './operations-context.ts';
import { createRequire } from 'node:module';
import { registerInvestigationRoutes } from '../../../apps/db-ops-api/src/investigations/routes.ts';
import { LegacyAnalysisBridge } from '../../../apps/db-ops-api/src/investigations/legacy-analysis-bridge.ts';
import { AgentRunService } from '../../../apps/db-ops-api/src/adapter/agent-run-service.ts';
/** Isolated synthetic source facts; real migrations/MySQL/JWT/HTTP/domain
 * services and product Lit routes. Synthetic target adapter only; no Provider, SSH, external resource action or shared DB. */
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'vite';
import { resolve } from 'node:path';
import { startFeedbackFixture } from '../../../apps/db-ops-api/src/investigations/feedback-test-fixture.ts';
import { createVerifyToken } from '../../../apps/db-ops-api/src/auth-middleware.ts';
import { signAccessToken } from '../../../apps/db-ops-api/src/auth/actor-context.ts';
import { CaseCursorCodec } from '../../../apps/db-ops-api/src/operations/knowledge/search.ts';
import { KnowledgeStore } from '../../../apps/db-ops-api/src/operations/knowledge/store.ts';
import { KnowledgeService } from '../../../apps/db-ops-api/src/operations/knowledge/service.ts';
import { registerKnowledgeRoutes } from '../../../apps/db-ops-api/src/operations/knowledge/routes.ts';
import { operationsFlags } from '../../../apps/db-ops-api/src/operations/feature-flags.ts';
import { registerRelationRoutes } from '../../../apps/db-ops-api/src/operations/relations/routes.ts';
import { RelationService } from '../../../apps/db-ops-api/src/operations/relations/service.ts';
import { MysqlRelationStore } from '../../../apps/db-ops-api/src/operations/relations/store.ts';
import { OperationsAuthorization } from '../../../apps/db-ops-api/src/operations/authorization.ts';
import { MysqlInvestigationBudgetLedger } from '../../../apps/db-ops-api/src/investigations/budget-ledger.ts';
import { investigationBudgetConfiguration } from '../../../apps/db-ops-api/src/investigations/session-bridge.ts';
import { ActionEvidenceAdapter } from '../../../apps/db-ops-api/src/operations/actions/evidence-adapter.ts';
import { OperationsError } from '../../../apps/db-ops-api/src/operations/contracts.ts';
import { AgentToolApprovalService } from '../../../apps/db-ops-api/src/security/agent-tool-approval-service.ts';

export async function startOperationsServer() {
  const port=Number(process.env.MAX202_MYSQL_PORT);
  if(!port)throw new Error('MAX202_MYSQL_PORT must point to this task’s isolated MySQL container');
  const f=await startFeedbackFixture(port);
  const realNow=Date.now;
  const ssh=await startHelperSshFixture(501);
  let vite: Awaited<ReturnType<typeof createServer>> | undefined;
  try {
    const codes=['operations:cases:view','operations:cases:manage','operations:cases:review','instance:manage','network_devices:view','network_devices:manage','servers:view','servers:manage','operations:context:view','operations:context:manage','operations:actions:view','operations:actions:propose','operations:actions:approve','operations:actions:execute','approval:view'];
    for(const code of codes)await f.rows('INSERT IGNORE INTO permissions(code,description) VALUES(?,?)',[code,'MAX202 synthetic UI identity']);
    await f.rows(`INSERT IGNORE INTO role_permissions(role_id,permission_id) SELECT 101,id FROM permissions WHERE code IN (${codes.map(()=>'?').join(',')})`,codes);
    // Both sources are explicitly synthetic identities with complete source ACL.
    await f.rows("UPDATE instance_permissions SET access_level='admin' WHERE user_id IN (101,102)");
    const author=await f.contexts.loadActiveActor(101),reviewer=await f.contexts.loadActiveActor(102);
    const verify=createVerifyToken(f.secret,f.contexts);
    const knowledge=new KnowledgeService(new KnowledgeStore(()=>f.pool,new CaseCursorCodec(randomBytes(32))),()=>({...operationsFlags({}),cases:true}));
    await registerKnowledgeRoutes(f.app,verify,knowledge);
    await registerRelationRoutes(f.app,verify,new RelationService(new MysqlRelationStore(()=>f.pool),new OperationsAuthorization(),undefined,()=>({...operationsFlags({}),context:true})));
    f.app.get('/api/auth/permissions',{preHandler:verify},async(req:any)=>req.user.permissions);
    f.app.get('/api/agents',{preHandler:verify},async()=>({defaultId:'main',agents:[{id:'main',name:'Synthetic UI test'}]}));
    f.app.get('/api/models',{preHandler:verify},async()=>({models:[]}));
    f.app.get('/api/chat/greeting',{preHandler:verify},async()=>({greeting:'Synthetic UI test; no model called'}));
    const source=await f.seed();
    const config=investigationBudgetConfiguration();
    const [allocation]=await f.rows('SELECT id FROM investigation_budget_ledger WHERE request_id=?',[source.binding.requestId]);
    if(allocation)await new MysqlInvestigationBudgetLedger(()=>f.pool,config.policy).cancelUnsent(allocation.id);
    await f.rows("UPDATE investigation_results SET result_json=JSON_SET(result_json,'$.provenance.modelVersion','synthetic-not-a-model-call','$.provenance.toolVersions',JSON_OBJECT('readonly_fixture','1')) WHERE id=?",[source.result.id]);
    await f.feedback.add(author,source.inv.id,randomUUID(),{...source.base,kind:'close',lifecycle:'closed',problemStatus:'resolved',verification:source.verification});
    await f.rows("INSERT INTO servers(id,host,label,os_type,credential_type,credential_encrypted) VALUES(501,'synthetic.invalid','SYNTHETIC isolated server','Other','key','unused synthetic; never sent')");
    const actionCreated=await f.bridge.create(author,{idempotencyKey:randomUUID(),title:'SYNTHETIC isolated action source',goal:'Bounded browser action flow',profileId:'ops',profileVersion:1,resources:[{type:'server',id:501,role:'primary'}],context:{subject:{kind:'resource',resource:{type:'server',id:501}}}},{message:'Synthetic read-only observation; no model',idempotencyKey:randomUUID()});
    const actionInv=actionCreated.investigation,actionRequest=actionCreated.acceptance!.requestId;
    await f.rows("INSERT INTO investigation_members(investigation_id,user_id,role,granted_by) VALUES(?,102,'viewer',101)",[actionInv.id]);
    const [actionReq]=await f.rows('SELECT message_id FROM investigation_requests WHERE id=?',[actionRequest]);
    const {run:actionRun}=await new AgentRunService(()=>f.pool as never).claim(author.userId,actionInv.sessionId,actionReq.message_id,`investigation:${actionRequest}`);
    const actionBinding={investigationId:actionInv.id,requestId:actionRequest,runId:actionRun.id};
    const actionProof=await f.evidence.put(author,actionBinding,randomUUID(),{source:'SYNTHETIC isolated pre-action',summary:'Synthetic service unhealthy',resources:[{type:'server',id:501}],observedFrom:new Date(Date.now()-120000).toISOString(),observedTo:new Date().toISOString(),collectedAt:new Date().toISOString(),raw:{httpStatus:503,partial:false,truncated:false,hasMore:false,limit:13,offset:0}});
    const actionValue={schemaVersion:2 as const,subject:{kind:'resource' as const,resource:{type:'server' as const,id:501}},summary:'SYNTHETIC no model/target called',facts:[{statement:'Synthetic unhealthy service',evidenceIds:[actionProof.id]}],hypotheses:[],claims:[],rootCauseVerification:{status:'unverified' as const},unresolvedQuestions:[],recommendations:[],problemStatus:'unconfirmed' as const,provenance:{modelVersion:'synthetic-not-called',promptVersion:'fixture',toolVersions:{synthetic_readonly:'1'},runtimeRunId:actionRun.id,usageStatus:'unavailable' as const},createdAt:new Date().toISOString()};
    const actionResult=await f.results.put(author,actionBinding,randomUUID(),0,actionValue);
    await f.rows("UPDATE agent_runs SET state='completed',finished_at=NOW() WHERE id=?",[actionRun.id]);
    await f.rows('UPDATE investigations SET active_request_id=NULL WHERE id=?',[actionInv.id]);
    const actionSource={inv:actionInv,binding:actionBinding,proof:actionProof,result:actionResult};
    const [actionAllocation]=await f.rows('SELECT id FROM investigation_budget_ledger WHERE request_id=?',[actionRequest]);
    if(actionAllocation)await new MysqlInvestigationBudgetLedger(()=>f.pool,config.policy).cancelUnsent(actionAllocation.id);
    // Explicit synthetic environment validator. This proves UI/domain approval,
    // isolated SSH/helper proves protocol, never production qualification.
    const definition={id:'synthetic-verifier',version:'1',serverId:501,configHash:ssh.configHash,helperHash:'a'.repeat(64),unitHash:'e'.repeat(64),hostFingerprint:ssh.target.hostFingerprint,beforeSeconds:120 as const,readinessSeconds:60 as const,observationSeconds:300 as const,intervalSeconds:10 as const,maxExtraRestarts:0 as const,requireAllHealthy:true as const};
    let clock=Date.now(),sends=0,loseReceipt=false;
    const sample=(at:number,before=false)=>({at:new Date(at).toISOString(),serverId:501,configHash:definition.configHash,helperHash:definition.helperHash,unitHash:definition.unitHash,hostFingerprint:definition.hostFingerprint,invocationId:(before?'1':'2').padStart(32,'0'),active:true,running:true,mainPid:123,httpStatus:before?503:200,restarts:0});
    const adapter=new ActionEvidenceAdapter(definition,{history:async(from)=>Array.from({length:13},(_,i)=>sample(Date.parse(from)+i*10000,true)),sample:async()=>sample(clock)});
    let trusted: any;
    const composition=createOperationsComposition(()=>f.pool,{jwtSecret:f.secret,
      env:{OPERATIONS_ACTION_PLANS_ENABLED:'true',OPERATIONS_ACTION_DISPATCH_ENABLED:'true',OPERATIONS_CASES_ENABLED:'true'},
      actionEnvironment:{validate:async(_c,content)=>{
        if(content.target.id!==501 || content.tool.hash!=='a'.repeat(64) || content.parameters.unit!=='slide-action-demo.service')throw new OperationsError('OPERATIONS_PRECONDITION_FAILED');
      },proposal:async targetId=>{if(targetId!==501)throw new OperationsError('OPERATIONS_PRECONDITION_FAILED');return {...trusted,validUntil:new Date(Date.now()+1800000).toISOString()};}},
      actionPorts:{adapter:{preflight:p=>ssh.adapter.preflight(p),execute:async i=>{sends++;ssh.loseReceipt(loseReceipt);return ssh.adapter.execute(i);},receipt:(p,id)=>ssh.adapter.receipt(p,id)},evidence:adapter,
        clock:{now:()=>clock,until:async at=>{clock=Math.max(clock,at);}}},
    });
    const {plans,ui,executions,reports,verification}=composition;
    await composition.registerActions(f.app);
    const worker=createActionWorker(composition,new MysqlWorkflowStore(()=>f.pool as never),'max204-browser');
    const plan=await plans.create(author,{schemaVersion:1,investigationId:actionSource.inv.id,resultVersion:1,target:{type:'server',id:501},
      tool:{name:'restart_demo_service',version:'1',hash:'a'.repeat(64)},parameters:{unit:'slide-action-demo.service'},
      evidence:[{id:actionSource.proof.id,version:1,hash:actionSource.proof.contentHash,validUntil:new Date(Date.now()+600000).toISOString()}],relations:[],baselines:[],
      preconditions:[{kind:'target_config_hash',expected:definition.configHash}],risk:'medium',impact:'SYNTHETIC 独立审批测试；不会发送资源动作',policyVersion:'synthetic-1',
      verifier:{id:'synthetic-verifier',version:'1',definitionHash:adapter.definitionHash,beforeSeconds:120,readinessSeconds:60,observationSeconds:300,intervalSeconds:10,maxExtraRestarts:0,requireAllHealthy:true},
      rollback:{capability:'none',description:'不可恢复进程内存；合成测试没有执行动作'}});
    const {author:_a,requester:_r,validFrom:_from,validUntil:_until,investigationId:_i,resultVersion:_v,target:_t,impact:_impact,evidence:_e,relations:_rel,baselines:_b,schemaVersion:_s,...trustedFields}=plan.content;
    trusted=trustedFields;
    await registerInvestigationRoutes(f.app,verify,f.bridge,f.bridge.observationServices(),new LegacyAnalysisBridge(()=>f.pool,undefined,f.bridge));
    await registerContextFixture(f,verify,author);
    const approvalFeed=new AgentToolApprovalService(()=>f.pool as never,randomUUID());
    f.app.get('/api/approval/unified',{preHandler:verify},async(req:any,reply)=>{
      if(!req.user.permissions.includes('approval:view'))return reply.code(403).send({reasonCode:'PERMISSION_DENIED'});
      const status=(req.query as {status?:string}).status ?? 'pending';
      if(status!=='pending'&&status!=='processed')return reply.code(400).send({reasonCode:'APPROVAL_STATUS_INVALID'});
      return {items:(await approvalFeed.list(status)).map(row=>({...row as object,kind:'agent'}))};
    });
    // Only the explicitly intercepted special-state test uses this inert stream.
    // It carries no source facts and is not counted as live invalidation proof.
    f.app.get('/api/operations/knowledge/controlled/watch',{preHandler:verify},async(_r,p)=>{p.hijack();p.raw.writeHead(200,{'Content-Type':'application/x-ndjson'});p.raw.write(' ');return p;});
    // Controlled transport harness; real authentication and live SQL snapshot
    // domain. This is not formal DirectAdapter/server-worker composition.
    const {WebSocketServer}=createRequire(new URL('../../../apps/db-ops-api/package.json',import.meta.url))('ws');
    const wss=new WebSocketServer({noServer:true});
    f.app.server.on('upgrade',(req,socket,head)=>{if(req.url?.startsWith('/agent-ws'))wss.handleUpgrade(req,socket,head,(ws:any)=>wss.emit('connection',ws,req));else socket.destroy();});
    wss.on('connection',(ws:any)=>{let actor:any;let id='';let timer:ReturnType<typeof setTimeout>|undefined;let closed=false;
      const refresh=async()=>{if(closed||!actor||!id)return;try{const snapshot=await f.bridge.observationServices().stream.snapshot(actor,id);if(!closed)ws.send(JSON.stringify({...snapshot,type:'investigation.snapshot'}));}catch{if(!closed)ws.send(JSON.stringify({type:'investigation.error',investigationId:id,code:'INVESTIGATION_NOT_FOUND'}));}if(!closed)timer=setTimeout(()=>void refresh(),1000);};
      ws.on('message',async(raw:Buffer)=>{try{const msg=JSON.parse(raw.toString());if(msg.type==='auth'){actor=await f.contexts.authenticateAccessToken(msg.token,f.secret);ws.send(JSON.stringify({type:'auth_ok',capabilities:[]}));}else if(msg.type==='investigation.watch'&&actor){if(timer)clearTimeout(timer);id=msg.id;await refresh();}else if(msg.type==='investigation.unwatch'){id='';if(timer)clearTimeout(timer);}}catch{ws.close(4001,'Authentication failed');}});
      ws.on('close',()=>{closed=true;if(timer)clearTimeout(timer);});
    });
    f.app.addHook('onClose',async()=>{for(const client of wss.clients)client.close();await new Promise<void>(r=>wss.close(()=>r()));});
    const apiUrl=await f.app.listen({host:'127.0.0.1',port:0});
    vite=await createServer({root:resolve('.'),configFile:resolve('vite.config.js'),define:{'import.meta.env.VITE_AGENT_WS_URL':'""'},server:{host:'127.0.0.1',port:0,strictPort:false,proxy:{'/api':{target:apiUrl,changeOrigin:true},'/__slide':{target:apiUrl,changeOrigin:true},'/agent-ws':{target:apiUrl,ws:true,changeOrigin:true}}}});
    await vite.listen();
    const url=`http://127.0.0.1:${(vite.httpServer!.address() as {port:number}).port}`;
    return {...f,author,reviewer,source,actionSource,knowledge,plan,plans,ui,executions,reports,verification,sends:()=>sends,helperRestarts:()=>ssh.restartCount(),dispatchUnknown:async(id:string)=>{await ssh.reset();await f.rows("UPDATE workflow_jobs SET available_at=TIMESTAMPADD(SECOND,-1,UTC_TIMESTAMP(3)) WHERE job_type='operations.action.execute'");loseReceipt=true;try{await verification.prepare(author,id);for(let i=0;i<5;i++){await worker.runOnce();if((await executions.get(author,id)).state==='outcome_unknown')break;}}finally{loseReceipt=false;}},resetClock:()=>{Date.now=realNow;},runAction:async(id:string)=>{await ssh.reset();await f.rows("UPDATE workflow_jobs SET available_at=TIMESTAMPADD(SECOND,-1,UTC_TIMESTAMP(3)) WHERE job_type='operations.action.execute'");for(let i=0;i<5;i++){await worker.runOnce();if((await executions.get(author,id)).state==='succeeded')break;}const report=await reports.get(author,id);Date.now=()=>Math.max(realNow(),clock);return report;},url,apiUrl,token:(actor=author)=>signAccessToken(actor,f.secret),close:async()=>{Date.now=realNow;await vite?.close();await worker.shutdown();await ssh.close();await f.close();}};
  } catch(error) {Date.now=realNow;await vite?.close();await ssh.close();await f.close();throw error;}
}
