/** Disposable integration child, never registered by production startup. */
import mysql from 'mysql2/promise';
import Fastify from 'fastify';
import { ActorContextService } from '../auth/actor-context.js';
import { createVerifyToken } from '../auth-middleware.js';
import { InvestigationAuthorization } from './authorization.js';
import { InvestigationSessionBridge, investigationBudgetConfiguration } from './session-bridge.js';
import { LegacyAnalysisBridge } from './legacy-analysis-bridge.js';
import { registerInvestigationRoutes } from './routes.js';
import { taskExecutionConfiguration } from './execution-allocation.js';
import { InvestigationExecutor } from './executor.js';
import { MysqlWorkflowStore, WorkerRuntime } from '../workflows/worker-runtime.js';
import { createInvestigationWorkflowHandler } from './workflow-handler.js';

process.once('message', async (input: any) => {
  let pool: mysql.Pool | undefined, app: ReturnType<typeof Fastify> | undefined, worker: WorkerRuntime | undefined;
  try {
    if (process.env.FROZEN_ALLOCATION_MYSQL !== '1' || !process.send
      || !/^inv_allocation_\d+_[a-f0-9]+$/.test(input.database)
      || !Number.isSafeInteger(input.port) || input.port < 1024 || input.port > 65535
      || !(/^(qualification[.]max222[.][a-f0-9-]+|task[.]max222[.][a-f0-9-]+[.][a-f0-9-]+)$/.test(input.domain))) throw Error('ISOLATED_CHILD_ONLY');
    pool = mysql.createPool({ host:'127.0.0.1',port:input.port,user:'root',password:'',database:input.database,timezone:'Z',connectionLimit:6 });
    const contexts = new ActorContextService(()=>pool as never), authorization = new InvestigationAuthorization(contexts);
    const budget={domain:input.domain,policy:{...investigationBudgetConfiguration().policy,maxAutomaticTokensPerDay:1200000,maxTotalTokensPerDay:1200000},
      reserveCostMicros:1000000,maxExecutionTokens:128000,taskExecution:input.taskExecution};
    if(input.taskExecution) taskExecutionConfiguration(input.taskExecution,input.domain,budget.policy);
    const bridge=new InvestigationSessionBridge(()=>pool!,authorization,budget);
    app=Fastify();
    await registerInvestigationRoutes(app,createVerifyToken(input.secret,contexts),bridge,bridge.observationServices(),new LegacyAnalysisBridge(()=>pool!,authorization,bridge));
    const url=await app.listen({host:'127.0.0.1',port:0});
    let sends=0,handlers=0;
    const executor=new InvestigationExecutor({pool:()=>pool!,authorization,budget,runtimeContext:{contextWindowTokens:16000,maxTokens:4096},
      providerForPurpose:async()=>{sends++;throw Error('FORBIDDEN_TERMINAL_SEND');},toolsForActor:()=>{handlers++;throw Error('FORBIDDEN_TERMINAL_TOOL');}});
    worker=new WorkerRuntime(new MysqlWorkflowStore(()=>pool as never),`frozen-child-${process.pid}`,120);
    const handler=createInvestigationWorkflowHandler(async()=>({executeInvestigation:(command:any)=>executor.execute(command)} as any));
    let runId:string|undefined,jobId:string|undefined,fence:number|undefined;
    await worker.runOnce(async(job,context)=>{
      const result:any=await handler(job.payload,job,context);runId=result.id;jobId=job.id;fence=context.fencingToken;
    });
    process.send({point:'ready',pid:process.pid,url,runId,jobId,fence,sends,handlers,cwd:process.cwd()});
    await new Promise<void>(resolve=>process.once('message',()=>resolve()));
    await worker.shutdown(5000);await app.close();await pool.end();
    process.send({point:'closed',pid:process.pid,sends,handlers});
    process.disconnect();
  } catch(error) {
    await worker?.shutdown(5000);await app?.close();await pool?.end();
    process.send?.({point:'error',message:String(error)});process.exitCode=1;process.disconnect?.();
  }
});
