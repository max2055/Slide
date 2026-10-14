import { registerNetworkDeviceRoutes } from '../../../apps/db-ops-api/src/network-devices/network-device-routes.js';
import { serverDatabaseService } from '../../../apps/db-ops-api/src/server-database-service.js';
import { requirePermission } from '../../../apps/db-ops-api/src/auth/require-permission.js';
import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer } from 'vite';
import { evidenceHash } from '../../../apps/db-ops-api/src/analysis/analysis-evidence.js';
import { MigrationRunner } from '../../../apps/db-ops-api/src/migrations/runner.js';
import { ActorContextService, signAccessToken } from '../../../apps/db-ops-api/src/auth/actor-context.js';
import { createVerifyToken } from '../../../apps/db-ops-api/src/auth-middleware.js';
import { dbConnection } from '../../../apps/db-ops-api/src/db-connection.js';
import { chatDatabaseService } from '../../../apps/db-ops-api/src/chat-database-service.js';
import { registerChatRoutes } from '../../../apps/db-ops-api/src/chat-routes.js';
import { InvestigationAuthorization } from '../../../apps/db-ops-api/src/investigations/authorization.js';
import { InvestigationSessionBridge, investigationBudgetConfiguration } from '../../../apps/db-ops-api/src/investigations/session-bridge.js';
import { registerInvestigationFeedbackRoutes } from '../../../apps/db-ops-api/src/investigations/feedback-routes.js';
import { registerInvestigationRoutes } from '../../../apps/db-ops-api/src/investigations/routes.js';
import { registerInvestigationProfileRoutes } from '../../../apps/db-ops-api/src/investigations/profile-routes.js';
import { registerInvestigationGovernanceRoutes } from '../../../apps/db-ops-api/src/investigations/governance-routes.js';
import { InvestigationGovernanceStore } from '../../../apps/db-ops-api/src/investigations/governance-store.js';
import { InvestigationStreamStore, InvestigationWatchService } from '../../../apps/db-ops-api/src/investigations/stream.js';
import { InvestigationExecutor } from '../../../apps/db-ops-api/src/investigations/executor.js';
import { DirectAdapter } from '../../../apps/db-ops-api/src/adapter/direct-adapter.js';
import { AgentRunService } from '../../../apps/db-ops-api/src/adapter/agent-run-service.js';
import { MysqlWorkflowStore, WorkerRuntime } from '../../../apps/db-ops-api/src/workflows/worker-runtime.js';
import { JobRegistry } from '../../../apps/db-ops-api/src/workflows/job-registry.js';
import { createInvestigationWorkflowHandler } from '../../../apps/db-ops-api/src/investigations/workflow-handler.js';
import { ToolRegistry, type LLMProvider } from '../../../packages/agent-core/src/index.js';
import { DatabaseAlertBridge } from '../../../apps/db-ops-api/src/investigations/alert-bridge.js';
import { AlertRCAService } from '../../../apps/db-ops-api/src/alert-rca-service.js';
import { LegacyAnalysisBridge } from '../../../apps/db-ops-api/src/investigations/legacy-analysis-bridge.js';
import { registerAnalysisBridgeRoutes } from '../../../apps/db-ops-api/src/investigations/bridge-routes.js';
import { provisionInvestigationServiceIdentity } from '../../../apps/db-ops-api/src/investigations/authorization.js';
import { createSystemComposition, type SystemComposition } from '../../../apps/db-ops-api/src/investigations/system-composition.js';
import { registerSystemEventRoutes, SystemEventReader } from '../../../apps/db-ops-api/src/investigations/system-event-routes.js';
import { SYSTEM_EVENT_JOB } from '../../../apps/db-ops-api/src/investigations/system-event-bridge.js';
import { installPlatformObservation } from '../../../apps/db-ops-api/src/platform/platform-observation-service.js';
import { SourceSnapshotService } from '../../../apps/db-ops-api/src/platform/source-snapshot-service.js';
import { SourceManagementService } from '../../../apps/db-ops-api/src/platform/source-management-service.js';

/** Real SQL/JWT/HTTP/WS/runtime; only provider/target tool data are synthetic. */
export async function startInvestigationServer(optionsInput: { databaseAlertPilot?: boolean; systemPilot?: boolean; resourcePilot?: boolean; realProvider?: LLMProvider } = {}) {
  const port = Number(process.env.T06_TEST_MYSQL_PORT);
  if (!port) throw new Error('T06_TEST_MYSQL_PORT is required: use an isolated MySQL 8.4 fixture, never production');
  const require = createRequire(resolve('../apps/db-ops-api/package.json'));
  const mysql = require('mysql2/promise');
  const Fastify = require('fastify');
  const schema = `t06_workspace_${process.pid}_${randomUUID().replaceAll('-', '')}`;
  const secret = randomUUID();
  process.env.JWT_SECRET_KEY = secret; process.env.AGENT_WS_HOST = '127.0.0.1'; process.env.AGENT_WS_PORT = '0';
  process.env.SLIDE_MEMORY_PIPELINE_ENABLED = 'false';
  const options = { host: '127.0.0.1', port, user: 'root', password: process.env.T06_TEST_MYSQL_PASSWORD ?? '', timezone: 'Z' };
  const admin = mysql.createPool(options);
  await admin.query(`CREATE DATABASE ${schema}`);
  const pool = mysql.createPool({ ...options, database: schema, connectionLimit: 16 });
  const originalPool = dbConnection.getPool;
  const originalChatPool = (chatDatabaseService as any).pool;
  (dbConnection as any).getPool = () => pool; (chatDatabaseService as any).pool = pool;
  const app = Fastify();
  let adapter: DirectAdapter | undefined, vite: Awaited<ReturnType<typeof createServer>> | undefined;
  let worker: WorkerRuntime | undefined, timer: ReturnType<typeof setInterval> | undefined;
  let current: Promise<unknown> | undefined;
  let system: SystemComposition | undefined;
  const sourceEnvKeys = ['SLIDE_SOURCE_ROOT','SLIDE_SOURCE_SIGNING_KEY','SLIDE_RELEASE_ID','SLIDE_COMMIT_SHA','SLIDE_SOURCE_DIGEST','SLIDE_RELEASE_MANIFEST'];
  const previousSourceEnv = new Map(sourceEnvKeys.map(k => [k, process.env[k]]));
  let holdChat = false;
  let governanceAvailable = true;
  let holdTools = false, paused = false, toolCalls = 0, providerCalls = 0;
  const workerErrors: string[] = [];
  const observationErrors: unknown[] = [];
  const promptObservations: Array<{ bytes:number; messages:number; roles:string[]; fields:unknown }> = [];
  const systemConsumption: Array<{originalFact:boolean; exactSource:boolean}> = [];
  const workspace = resolve('.qualification/t06-workspace', schema);
  await mkdir(workspace, { recursive: true });
  const close = async () => {
    if (timer) clearInterval(timer);
    await system?.close();
    await worker?.shutdown(); await current;
    await vite?.close(); await adapter?.dispose(); await app.close();
    (dbConnection as any).getPool = originalPool; (chatDatabaseService as any).pool = originalChatPool;
    await pool.end();
    if (!/^t06_workspace_\d+_[a-f0-9]+$/.test(schema)) throw new Error('UNSAFE_SCHEMA');
    await admin.query(`DROP DATABASE ${schema}`); await admin.end();
    if (optionsInput.systemPilot) for (const [key,value] of previousSourceEnv) { if (value === undefined) delete process.env[key]; else process.env[key]=value; }
  };
  try {
    await new MigrationRunner(pool).run();
    await new MigrationRunner(pool).run();
    // The historical migration catalog does not seed the existing ai:view code.
    await pool.query("INSERT IGNORE INTO permissions (code,name,resource,action) VALUES ('ai:view','AI settings read','ai','view')");
    await pool.query("INSERT INTO users (id, username, password_hash) VALUES (101,'t06-owner','no-login'),(102,'t06-viewer','no-login')");
    await pool.query("INSERT INTO roles (id,name) VALUES (101,'t06-readonly')");
    await pool.query("INSERT INTO role_permissions (role_id,permission_id) SELECT 101,id FROM permissions WHERE code IN ('chat:view','chat:send','instance:view','metric:view','alert:view','config:view')");
    await pool.query('INSERT INTO user_roles (user_id,role_id) VALUES (101,101),(102,101)');
    await pool.query("INSERT INTO database_instances (id,name,host,port,username,password_encrypted) VALUES (101,'合成资源','fixture.invalid',3306,'fixture','unused')");
    await pool.query("INSERT INTO instance_permissions (user_id,instance_id,access_level) VALUES (101,101,'read-only'),(102,101,'read-only')");
    if (optionsInput.resourcePilot) {
      await pool.query("INSERT INTO role_permissions (role_id,permission_id) SELECT 101,id FROM permissions WHERE code IN ('servers:view','network_devices:view')");
      await pool.query("INSERT INTO servers (id,host,label,port,os_type,credential_type,credential_encrypted,status) VALUES (101,'server.fixture.invalid','服务器受控夹具',22,'linux','password','unused','online')");
      await pool.query("INSERT INTO network_devices (id,name,host,vendor,status) VALUES (101,'网络无数据夹具','network.fixture.invalid','huawei','unknown')");
    }
    const contexts = new ActorContextService(() => pool);
    const owner = await contexts.loadActiveActor(101), viewer = await contexts.loadActiveActor(102);
    const authorization = new InvestigationAuthorization(contexts);
    const bridge = new InvestigationSessionBridge(() => pool, authorization);
    let systemServiceId = 0;
    if (optionsInput.systemPilot) {
      systemServiceId = await provisionInvestigationServiceIdentity(pool as never, 't09-browser');
      await pool.query('INSERT INTO roles (id,name) VALUES (109,\'t09-system\')');
      await pool.query("INSERT INTO role_permissions (role_id,permission_id) SELECT 109,id FROM permissions WHERE code IN ('chat:view','config:view')");
      await pool.query('INSERT INTO user_roles (user_id,role_id) VALUES (?,109)',[systemServiceId]);
      const commitSha = 'a'.repeat(40), signingKey = randomUUID()+randomUUID(), root = resolve(workspace,'source');
      const repository = { origin:'https://github.com',provider:'github' as const,ref:commitSha,allowedPaths:['src/'] };
      const manifest = await new SourceSnapshotService(root,signingKey).publish({ releaseId:'t09-snapshot',commitSha,
        projectId:'fixture/system',repository },[{ path:'src/system-fixture.ts',content:'export function observedFailure() { return "fixture-failure"; }\n' }]);
      const key = 'source.snapshot.'+createHash('sha256').update(JSON.stringify({...repository,projectId:'fixture/system'})).digest('hex');
      await pool.query('REPLACE INTO system_config (config_key,config_value) VALUES (?,?),(?,?)',[
        'source.gitlab',JSON.stringify({baseUrl:repository.origin,provider:repository.provider,ref:commitSha,allowedPaths:repository.allowedPaths,repositoryPath:'fixture/system',allowModelContent:true}),
        key,JSON.stringify({releaseId:manifest.releaseId,commitSha,treeDigest:manifest.treeDigest})]);
      Object.assign(process.env,{SLIDE_SOURCE_ROOT:root,SLIDE_SOURCE_SIGNING_KEY:signingKey,SLIDE_RELEASE_ID:'t09-deployment',
        SLIDE_COMMIT_SHA:commitSha,SLIDE_SOURCE_DIGEST:manifest.treeDigest,SLIDE_RELEASE_MANIFEST:''});
      system = await createSystemComposition(() => pool,{contexts,configuration:{enabled:true,automatic:true,serviceUserId:systemServiceId},
        source:new SourceManagementService(() => pool),budget:{...investigationBudgetConfiguration(),domain:'t06-synthetic',prices:{input:100,cachedInput:50,output:200}}});
    }
    const bridgeFlags = { manual: !!optionsInput.databaseAlertPilot, opsAuto: !!optionsInput.databaseAlertPilot, legacy: !!optionsInput.databaseAlertPilot };
    let pilotServiceId = 0;
    if (optionsInput.databaseAlertPilot) {
      await pool.query("INSERT IGNORE INTO permissions (code,name,resource,action) VALUES ('ai:manage','AI manage','ai','manage')");
      await pool.query("INSERT INTO roles (id,name) VALUES (102,'t08-human-ai')");
      await pool.query("INSERT INTO role_permissions (role_id,permission_id) SELECT 102,id FROM permissions WHERE code IN ('ai:manage','ai:view')");
      await pool.query('INSERT INTO user_roles (user_id,role_id) VALUES (101,102),(102,102)');
      const c = await pool.getConnection();
      try { pilotServiceId = await provisionInvestigationServiceIdentity(c as never, 't08-browser'); } finally { c.release(); }
      await pool.query('INSERT INTO user_roles (user_id,role_id) VALUES (?,101)',[pilotServiceId]);
      await pool.query("INSERT INTO instance_permissions (user_id,instance_id,access_level) VALUES (?,101,'read-only')",[pilotServiceId]);
    }
    const pilotBridge = new DatabaseAlertBridge(() => pool, contexts, authorization, bridge, () => bridgeFlags,
      () => ({ configured: !!pilotServiceId, serviceUserId: pilotServiceId, instanceIds: [101], serverIds: optionsInput.resourcePilot ? [101] : [], networkDeviceIds: optionsInput.resourcePilot ? [101] : [], policyId: 'database-alert-pilot', policyVersion: 1 }),
      () => ({ ...investigationBudgetConfiguration(), domain: 't06-synthetic' }));
    const rca = new AlertRCAService(pilotBridge);
    const legacy = new LegacyAnalysisBridge(() => pool, authorization, bridge);
    const tools = new ToolRegistry();
    if (!optionsInput.resourcePilot) tools.register({ name: 'get_instance_summary', description: 'Synthetic readonly resource', parameters: { type: 'object', properties: { instance_id: { type: 'number' } } },
      readOnly: true, concurrencySafe: true, exclusive: false,
      execute: async (_args: unknown, context: any) => {
        toolCalls++;
        if (holdTools) await new Promise<void>((done, reject) => {
          if (context.signal?.aborted) reject(context.signal.reason);
          else context.signal?.addEventListener('abort', () => reject(context.signal.reason), { once: true });
        });
        return { success: true, qps: 7, summary: '合成只读指标' };
      } });
    if (optionsInput.resourcePilot) tools.register({ name: 'get_resource_observations', description: 'Read frozen synthetic observations for the investigation resource. Missing value is unknown, never normal or down.',
      parameters: { type:'object', properties:{ resourceType:{type:'string',enum:['instance','server','network_device']},resourceId:{type:'number'} },required:['resourceType','resourceId'],additionalProperties:false },
      readOnly:true,concurrencySafe:true,exclusive:false,
      execute:async (args:any) => { toolCalls++;
        const [events]=await pool.query('SELECT tags,metric_name,metric_value FROM alerts WHERE target_type=? ORDER BY id DESC LIMIT 1',[args.resourceType]);
        const row=events[0],tags=typeof row.tags==='string'?JSON.parse(row.tags):row.tags;
        return {success:true,resource:{type:args.resourceType,id:args.resourceId},observedFrom:tags.observed_from,observedTo:tags.observed_to,
          collectedAt:tags.observed_at,metrics:[{metricId:row.metric_name,value:row.metric_value==null?null:Number(row.metric_value),quality:tags.quality}],
          summary:args.resourceType==='network_device'?'缺指标，不足以判断正常或设备宕机':'冻结 CPU 91%，根因待验证'};
      }});
    const final = { content: '合成调查摘要：证据已保存，根因待验证。', finishReason: 'stop', toolCalls: [], hasToolCalls: false, shouldExecuteTools: false,
      usage: { prompt_tokens: 20, completion_tokens: 10, cached_tokens: 5 } };
    const provider = () => {
      if (optionsInput.realProvider) return optionsInput.realProvider;
      let call = 0;
      return { getDefaultModel: () => 'controlled-fixture', getModelCapabilities: () => ({ model: 'controlled-fixture', contextWindowTokens: 32768, preferredOutputTokens: 2048, source: 'configuration', version: 'fixture/v1' }),
        countPromptTokens: optionsInput.systemPilot ? (messages:any[]) => {promptObservations.push({bytes:Buffer.byteLength(JSON.stringify(messages.map(({messageParts:_parts,...m})=>m))),messages:messages.length,roles:messages.map(m=>m.role),fields:messages.map(m=>Object.fromEntries(Object.entries(m).filter(([k])=>k!=='messageParts').map(([k,v])=>[k,Buffer.byteLength(JSON.stringify(v)??'')])))});return undefined;} : undefined,
        chat: async (messages:any[]) => { providerCalls++;
          if (optionsInput.systemPilot && call > 0) {
            const values = messages.filter(m=>m.role==='tool').map(m=>{try{return {name:m.name,value:JSON.parse(m.content)};}catch{return null;}});
            systemConsumption.push({originalFact:values.some(v=>v?.name==='get_platform_observations'&&v.value.data?.facts?.some((f:any)=>f.event.stableErrorCode==='HTTP_503')),
              exactSource:values.some(v=>v?.name==='read_source_region'&&v.value.data?.quality==='good'&&v.value.data?.content?.includes('fixture-failure')&&v.value.data?.rootCauseVerified===false)});
          }
          return ++call === 1 ? { ...final, content: null, finishReason: 'tool_calls',
          toolCalls: optionsInput.systemPilot ? [
            {id:randomUUID(),name:'get_platform_observations',arguments:{}},
            {id:randomUUID(),name:'get_deployment_manifest',arguments:{}},
            {id:randomUUID(),name:'read_source_region',arguments:{path:'src/system-fixture.ts',startLine:1,endLine:1}},
          ] : optionsInput.resourcePilot ? [{id:randomUUID(),name:'get_resource_observations',arguments:{resourceType: JSON.stringify(messages).includes('network_device') ? 'network_device' : JSON.stringify(messages).includes('server:') || JSON.stringify(messages).includes('服务器') ? 'server' : 'instance',resourceId:101}}] : [{ id: randomUUID(), name: 'get_instance_summary', arguments: { instance_id: 101 } }], hasToolCalls: true, shouldExecuteTools: true } : final; },
        chatStream: async (_messages: unknown, _tools: unknown, callbacks: any, options: any) => { providerCalls++;
          if (holdChat) await new Promise<void>((done, reject) => { const signal = options?.signal; if (signal?.aborted) reject(signal.reason); else signal?.addEventListener('abort', () => reject(signal.reason), { once: true }); }); await callbacks.onContentDelta('普通对话合成回答'); return { ...final, content: '普通对话合成回答' }; },
      } as any;
    };
    const executor = new InvestigationExecutor({ pool: () => pool, authorization, toolsForActor: () => tools, providerForPurpose: async () => provider(),
      ...(system ? {systemToolsForInvestigation:system.toolsForInvestigation} : {}),
      budget: { domain: 't06-synthetic', policy: investigationBudgetConfiguration().policy, reserveCostMicros: 1000000, prices: { input: 100, cachedInput: 50, output: 200 } } });
    const stream = new InvestigationStreamStore(() => pool, authorization);
    const snapshot = stream.snapshot.bind(stream);
    let snapshotGate: { id: string; arrived: () => void; wait: Promise<void> } | undefined;
    stream.snapshot = async (...args) => {
      const gate = snapshotGate?.id === args[1] ? snapshotGate : undefined;
      if (gate) snapshotGate = undefined;
      try {
        const value = await snapshot(...args);
        if (gate) { gate.arrived(); await gate.wait; }
        return value;
      } catch (e: any) {
        if (e.code !== 'INVESTIGATION_NOT_FOUND') observationErrors.push({ phase: 'snapshot', code: e.code, stack: e.stack });
        throw e;
      }
    };
    const replay = stream.replay.bind(stream);
    stream.replay = async (...args) => { try { return await replay(...args); } catch (e: any) {
      if (e.code === 'IDEMPOTENCY_PAYLOAD_MISMATCH') {
        const [events] = await pool.query('SELECT source_key,event_json FROM investigation_stream_events WHERE investigation_id=? ORDER BY sequence', [args[1]]);
        const diagnostic = { code: e.code, stack: e.stack, events: events.filter((row: any) => String(row.source_key).startsWith('parts:')).map((row: any) => {
          const event = typeof row.event_json === 'string' ? JSON.parse(row.event_json) : row.event_json;
          const { schemaVersion: _schemaVersion, investigationId: _investigationId, sequence, ...input } = event;
          const source = String(row.source_key), expectedHash = source.split(':').at(-1);
          return { source, sequence, payloadSequence: input.payload.sequence,
            hashWithStoredPayloadSequence: evidenceHash(input), hashWithOriginalPayloadSequence: evidenceHash({ ...input, payload: { ...input.payload, sequence: 0 } }), expectedHash };
        }) };
        observationErrors.push(diagnostic);
        await writeFile(resolve('test-results/t06-observation-error.json'), JSON.stringify(diagnostic, null, 2));
        console.error('T06 replay failure', JSON.stringify(diagnostic));
      } else if (e.code !== 'INVESTIGATION_NOT_FOUND') observationErrors.push({ phase: 'replay', code: e.code, stack: e.stack });
      throw e;
    } };
    const watch = new InvestigationWatchService(stream, 50);
    adapter = new DirectAdapter({ tools, toolsForActor: () => tools, llmProvider: provider(), providerForPurpose: async () => provider(),
      investigationExecutor: executor, actorContextService: contexts, investigationWatchService: watch, workspace });
    await adapter.start();
    const wsServer = (adapter as any).wsServer;
    if (!wsServer.address()) await new Promise<void>(r => wsServer.once('listening', r));
    const verify = createVerifyToken(secret, contexts);
    if (system) {
      await installPlatformObservation(app,verify);
      await registerSystemEventRoutes(app,verify,new SystemEventReader(() => pool,authorization));
      app.get('/fixture/system-failure',async (_r:any,reply:any) => reply.code(503).send({error:'controlled failure'}));
      app.get('/fixture/system-400',async (_r:any,reply:any) => reply.code(400).send({}));
      app.get('/fixture/system-403',async (_r:any,reply:any) => reply.code(403).send({}));
    }
    await registerInvestigationRoutes(app, verify, bridge, bridge.observationServices(), legacy);
    await registerInvestigationFeedbackRoutes(app, verify);
    await registerAnalysisBridgeRoutes(app, verify, legacy, () => bridgeFlags, rca);
    if (optionsInput.databaseAlertPilot) {
      app.get('/api/alerts', { preHandler: verify }, async (request: any) => {
        // Synthetic source rows, real SQL/HTTP. Tests never fake admission.
        const [items] = await pool.query('SELECT *, level AS severity FROM alerts WHERE instance_id=101 OR server_id=101 OR network_device_id=101 ORDER BY id');
        return { items, total: items.length, critical: items.length, unread: items.length };
      });
      app.get('/api/ai/analysis', { preHandler: verify }, async () => []);
    }
    if (optionsInput.resourcePilot) {
      // Formal network routes/storage/permission handlers. No SSH/SNMP target calls.
      await registerNetworkDeviceRoutes(app,verify);
      app.get('/api/servers/:id',{preHandler:[verify,requirePermission('servers:view')]},async(request:any,reply:any)=> {
        const row=await serverDatabaseService.getServerById(Number(request.params.id));
        if(!row)return reply.code(404).send({error:'NOT_FOUND'});
        const {credential_encrypted:_credential,...publicRow}=row;return publicRow;
      });
      app.get('/api/servers/:id/instances',{preHandler:[verify,requirePermission('servers:view')]},async()=>({instances:[]}));
      app.get('/api/database/instances/:id',{preHandler:verify},async(request:any,reply:any)=> {
        if(!request.user.instanceScopes[Number(request.params.id)])return reply.code(404).send({error:'NOT_FOUND'});
        const [rows]=await pool.query('SELECT id,name,host,port,db_type,status,environment FROM database_instances WHERE id=?',[request.params.id]);
        return rows[0]??reply.code(404).send({error:'NOT_FOUND'});
      });
    }
    await registerInvestigationProfileRoutes(app, verify);
    await registerInvestigationGovernanceRoutes(app, verify, new InvestigationGovernanceStore(() => governanceAvailable ? pool : null, investigationBudgetConfiguration, contexts));
    await registerChatRoutes(app, { verifyToken: verify, service: chatDatabaseService, handleChatSend: async () => { throw new Error('USE_REAL_WS_CHAT'); } });
    app.get('/api/auth/permissions', { preHandler: verify }, async (request: any) => request.user.permissions);
    app.get('/api/agents', { preHandler: verify }, async () => ({ defaultId: 'main', agents: [{ id: 'main', name: 'Fixture' }] }));
    app.get('/api/models', { preHandler: verify }, async () => ({ models: [] }));
    app.get('/api/chat/greeting', { preHandler: verify }, async () => ({ greeting: '合成测试对话' }));
    const apiUrl = await app.listen({ host: '127.0.0.1', port: 0 });
    const registry = new JobRegistry(); registry.register('investigation.execute', createInvestigationWorkflowHandler(async () => adapter!));
    if (system) {registry.register(SYSTEM_EVENT_JOB,system.bridge.handler());system.install();}
    worker = new WorkerRuntime(new MysqlWorkflowStore(() => pool), 't06-ui-worker', 60);
    timer = setInterval(() => {
      if (current || paused) return;
      current = worker!.runOnce((job, context) => registry.execute(job, context)).catch(e => workerErrors.push(String(e))).finally(() => current = undefined);
    }, 50);
    vite = await createServer({ root: resolve('.'), configFile: resolve('vite.config.js'),
      define: { 'import.meta.env.VITE_AGENT_WS_URL': '""' }, server: { host: '127.0.0.1', port: 0, strictPort: false,
        proxy: { '/api': { target: apiUrl, changeOrigin: true },
          '/__slide': { target: `http://127.0.0.1:${wsServer.address().port}`, changeOrigin: true },
          '/agent-ws': { target: `http://127.0.0.1:${wsServer.address().port}`, ws: true, changeOrigin: true } } } });
    await vite.listen();
    const address = vite.httpServer!.address() as { port: number };
    const currentOwner = optionsInput.databaseAlertPilot ? await contexts.loadActiveActor(101) : owner;
    const currentViewer = optionsInput.databaseAlertPilot ? await contexts.loadActiveActor(102) : viewer;
    return { url: `http://127.0.0.1:${address.port}`, pool, bridge, stream, contexts, owner: currentOwner, viewer: currentViewer, adapter, workerErrors, observationErrors, close,
      bridgeFlags, rca,
      system,systemServiceId,apiUrl,promptObservations,systemConsumption,
      token: (actor = currentOwner) => signAccessToken(actor, secret), counts: () => ({ toolCalls, providerCalls }),
      governanceStorage: (available: boolean) => governanceAvailable = available,
      disconnectObservers: () => { for (const peer of wsServer.clients) peer.close(1012, 'fixture reconnect'); },
      delaySnapshot: (id: string) => {
        let arrived!: () => void, release!: () => void;
        const started = new Promise<void>(resolve => arrived = resolve);
        snapshotGate = { id, arrived, wait: new Promise<void>(resolve => release = resolve) };
        return { started, release };
      },
      holdChat: (value: boolean) => holdChat = value,
      hold: (value: boolean) => holdTools = value,
      unknown: async () => {
        paused = true; await current;
        try {
          const { investigation, acceptance } = await bridge.create(owner, { title: '未知结果', goal: '不重发未知请求', profileId: 'ops', profileVersion: 1,
            resources: [{ type: 'instance', id: 101, role: 'primary' }], context: { subject: { kind: 'resource', resource: { type: 'instance', id: 101 } } }, idempotencyKey: randomUUID() }, { message: '不重发未知请求', idempotencyKey: randomUUID() });
          const store = new MysqlWorkflowStore(() => pool), job = await store.claim('t06-unknown', 60);
          const [requests] = await pool.query('SELECT message_id FROM investigation_requests WHERE id=?', [acceptance!.requestId]);
          const runService = new AgentRunService(() => pool, authorization);
          const { run } = await runService.claim(101, investigation.sessionId, requests[0].message_id, `investigation:${acceptance!.requestId}`);
          const c = await pool.getConnection();
          try { await c.beginTransaction(); await runService.terminateInvestigation(c, owner, { investigationId: investigation.id, requestId: acceptance!.requestId, runId: run.id,
            jobId: job!.id, workerId: 't06-unknown', fencingToken: job!.fencingToken }, 'partial', 'INVESTIGATION_PROVIDER_UNKNOWN'); await c.commit(); }
          catch (e) { await c.rollback(); throw e; } finally { c.release(); }
          await store.complete(job!.id, 't06-unknown', job!.fencingToken);
          return investigation.id;
        } finally { paused = false; }
      },
    };
  } catch (error) { await close(); throw error; }
}
