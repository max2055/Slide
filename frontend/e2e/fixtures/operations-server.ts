/** Isolated synthetic source facts; real migrations/MySQL/JWT/HTTP/domain
 * services and product Lit routes. No Provider, SSH, action dispatch or shared DB. */
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
import { ActionPlanService } from '../../../apps/db-ops-api/src/operations/actions/plan-service.ts';
import { PlanStore, PlanSources } from '../../../apps/db-ops-api/src/operations/actions/plan-store.ts';
import { registerActionPlanRoutes } from '../../../apps/db-ops-api/src/operations/actions/routes.ts';
import { OperationsError } from '../../../apps/db-ops-api/src/operations/contracts.ts';
import { AgentToolApprovalService } from '../../../apps/db-ops-api/src/security/agent-tool-approval-service.ts';

export async function startOperationsServer() {
  const port=Number(process.env.MAX202_MYSQL_PORT);
  if(!port)throw new Error('MAX202_MYSQL_PORT must point to this task’s isolated MySQL 8.4 container');
  const f=await startFeedbackFixture(port);
  let vite: Awaited<ReturnType<typeof createServer>> | undefined;
  try {
    const codes=['operations:cases:view','operations:cases:manage','operations:cases:review','instance:manage','servers:view','servers:manage','operations:context:view','operations:context:manage','operations:actions:view','operations:actions:propose','operations:actions:approve','approval:view'];
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
    const actionSource=await f.seed();
    const [actionAllocation]=await f.rows('SELECT id FROM investigation_budget_ledger WHERE request_id=?',[actionSource.binding.requestId]);
    if(actionAllocation)await new MysqlInvestigationBudgetLedger(()=>f.pool,config.policy).cancelUnsent(actionAllocation.id);
    await f.rows("INSERT INTO servers(id,host,label,os_type,credential_type,credential_encrypted) VALUES(501,'synthetic.invalid','SYNTHETIC isolated server','Other','key','unused synthetic; never sent')");
    await f.rows("INSERT INTO investigation_resources(investigation_id,resource_type,resource_id,role) VALUES(?,'server',501,'related')",[actionSource.inv.id]);
    // Explicit synthetic environment validator. This proves UI/domain approval,
    // never SSH/environment qualification or dispatch authorization.
    const plans=new ActionPlanService(new PlanStore({getConnection:async()=>f.pool.getConnection() as never}),new PlanSources({validate:async(_c,content)=>{
      if(content.target.id!==501 || content.tool.hash!=='a'.repeat(64) || content.parameters.unit!=='slide-action-demo.service')throw new OperationsError('OPERATIONS_PRECONDITION_FAILED');
    }}),new OperationsAuthorization(),()=>({...operationsFlags({}),plans:true}));
    await registerActionPlanRoutes(f.app,verify as any,plans);
    const plan=await plans.create(author,{schemaVersion:1,investigationId:actionSource.inv.id,resultVersion:1,target:{type:'server',id:501},
      tool:{name:'restart_demo_service',version:'synthetic-1',hash:'a'.repeat(64)},parameters:{unit:'slide-action-demo.service'},
      evidence:[{id:actionSource.proof.id,version:1,hash:actionSource.proof.contentHash,validUntil:new Date(Date.now()+600000).toISOString()}],relations:[],baselines:[],
      preconditions:[{kind:'synthetic_environment',expected:'No real target action permitted'}],risk:'medium',impact:'SYNTHETIC 独立审批测试；不会发送资源动作',policyVersion:'synthetic-1',
      verifier:{id:'synthetic-verifier',version:'1',definitionHash:'d'.repeat(64),beforeSeconds:120,readinessSeconds:60,observationSeconds:300,intervalSeconds:10,maxExtraRestarts:0,requireAllHealthy:true},
      rollback:{capability:'none',description:'不可恢复进程内存；合成测试没有执行动作'}});
    const approvalFeed=new AgentToolApprovalService(()=>f.pool as never,randomUUID());
    f.app.get('/api/approval/unified',{preHandler:verify},async(req:any,reply)=>{
      if(!req.user.permissions.includes('approval:view'))return reply.code(403).send({reasonCode:'PERMISSION_DENIED'});
      const status=(req.query as {status?:string}).status ?? 'pending';
      if(status!=='pending'&&status!=='processed')return reply.code(400).send({reasonCode:'APPROVAL_STATUS_INVALID'});
      return {items:(await approvalFeed.list(status)).map(row=>({...row as object,kind:'agent'}))};
    });
    const apiUrl=await f.app.listen({host:'127.0.0.1',port:0});
    vite=await createServer({root:resolve('.'),configFile:resolve('vite.config.js'),define:{'import.meta.env.VITE_AGENT_WS_URL':'""'},server:{host:'127.0.0.1',port:0,strictPort:false,proxy:{'/api':{target:apiUrl,changeOrigin:true},'/__slide':{target:apiUrl,changeOrigin:true},'/agent-ws':{target:apiUrl,ws:true,changeOrigin:true}}}});
    await vite.listen();
    const url=`http://127.0.0.1:${(vite.httpServer!.address() as {port:number}).port}`;
    return {...f,author,reviewer,source,knowledge,plan,plans,url,apiUrl,token:(actor=author)=>signAccessToken(actor,f.secret),close:async()=>{await vite?.close();await f.close();}};
  } catch(error) {await vite?.close();await f.close();throw error;}
}
