import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
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
import { registerInvestigationRoutes } from '../../../apps/db-ops-api/src/investigations/routes.js';
import { registerInvestigationProfileRoutes } from '../../../apps/db-ops-api/src/investigations/profile-routes.js';
import { InvestigationStreamStore, InvestigationWatchService } from '../../../apps/db-ops-api/src/investigations/stream.js';
import { InvestigationExecutor } from '../../../apps/db-ops-api/src/investigations/executor.js';
import { DirectAdapter } from '../../../apps/db-ops-api/src/adapter/direct-adapter.js';
import { AgentRunService } from '../../../apps/db-ops-api/src/adapter/agent-run-service.js';
import { MysqlWorkflowStore, WorkerRuntime } from '../../../apps/db-ops-api/src/workflows/worker-runtime.js';
import { JobRegistry } from '../../../apps/db-ops-api/src/workflows/job-registry.js';
import { createInvestigationWorkflowHandler } from '../../../apps/db-ops-api/src/investigations/workflow-handler.js';
import { ToolRegistry } from '../../../packages/agent-core/src/index.js';

/** Real SQL/JWT/HTTP/WS/runtime; only provider/target tool data are synthetic. */
export async function startInvestigationServer() {
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
  let holdChat = false;
  let holdTools = false, paused = false, toolCalls = 0, providerCalls = 0;
  const workerErrors: string[] = [];
  const observationErrors: unknown[] = [];
  const workspace = resolve('.qualification/t06-workspace', schema);
  await mkdir(workspace, { recursive: true });
  const close = async () => {
    if (timer) clearInterval(timer);
    await worker?.shutdown(); await current;
    await vite?.close(); await adapter?.dispose(); await app.close();
    (dbConnection as any).getPool = originalPool; (chatDatabaseService as any).pool = originalChatPool;
    await pool.end();
    if (!/^t06_workspace_\d+_[a-f0-9]+$/.test(schema)) throw new Error('UNSAFE_SCHEMA');
    await admin.query(`DROP DATABASE ${schema}`); await admin.end();
  };
  try {
    await new MigrationRunner(pool).run();
    await pool.query("INSERT INTO users (id, username, password_hash) VALUES (101,'t06-owner','no-login'),(102,'t06-viewer','no-login')");
    await pool.query("INSERT INTO roles (id,name) VALUES (101,'t06-readonly')");
    await pool.query("INSERT INTO role_permissions (role_id,permission_id) SELECT 101,id FROM permissions WHERE code IN ('chat:view','chat:send','instance:view','metric:view','alert:view','config:view')");
    await pool.query('INSERT INTO user_roles (user_id,role_id) VALUES (101,101),(102,101)');
    await pool.query("INSERT INTO database_instances (id,name,host,port,username,password_encrypted) VALUES (101,'合成资源','fixture.invalid',3306,'fixture','unused')");
    await pool.query("INSERT INTO instance_permissions (user_id,instance_id,access_level) VALUES (101,101,'read-only'),(102,101,'read-only')");
    const contexts = new ActorContextService(() => pool);
    const owner = await contexts.loadActiveActor(101), viewer = await contexts.loadActiveActor(102);
    const authorization = new InvestigationAuthorization(contexts);
    const bridge = new InvestigationSessionBridge(() => pool, authorization);
    const tools = new ToolRegistry();
    tools.register({ name: 'get_instance_summary', description: 'Synthetic readonly resource', parameters: { type: 'object', properties: { instance_id: { type: 'number' } } },
      readOnly: true, concurrencySafe: true, exclusive: false,
      execute: async (_args: unknown, context: any) => {
        toolCalls++;
        if (holdTools) await new Promise<void>((done, reject) => {
          if (context.signal?.aborted) reject(context.signal.reason);
          else context.signal?.addEventListener('abort', () => reject(context.signal.reason), { once: true });
        });
        return { success: true, qps: 7, summary: '合成只读指标' };
      } });
    const final = { content: '合成调查摘要：证据已保存，根因待验证。', finishReason: 'stop', toolCalls: [], hasToolCalls: false, shouldExecuteTools: false,
      usage: { prompt_tokens: 20, completion_tokens: 10, cached_tokens: 5 } };
    const provider = () => {
      let call = 0;
      return { getDefaultModel: () => 'controlled-fixture', getModelCapabilities: () => ({ model: 'controlled-fixture', contextWindowTokens: 32768, preferredOutputTokens: 2048, source: 'configuration', version: 'fixture/v1' }),
        chat: async () => { providerCalls++; return ++call === 1 ? { ...final, content: null, finishReason: 'tool_calls', toolCalls: [{ id: randomUUID(), name: 'get_instance_summary', arguments: { instance_id: 101 } }], hasToolCalls: true, shouldExecuteTools: true } : final; },
        chatStream: async (_messages: unknown, _tools: unknown, callbacks: any, options: any) => { providerCalls++;
          if (holdChat) await new Promise<void>((done, reject) => { const signal = options?.signal; if (signal?.aborted) reject(signal.reason); else signal?.addEventListener('abort', () => reject(signal.reason), { once: true }); }); await callbacks.onContentDelta('普通对话合成回答'); return { ...final, content: '普通对话合成回答' }; },
      } as any;
    };
    const executor = new InvestigationExecutor({ pool: () => pool, authorization, toolsForActor: () => tools, providerForPurpose: async () => provider(),
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
    await registerInvestigationRoutes(app, verify, bridge);
    await registerInvestigationProfileRoutes(app, verify);
    await registerChatRoutes(app, { verifyToken: verify, service: chatDatabaseService, handleChatSend: async () => { throw new Error('USE_REAL_WS_CHAT'); } });
    app.get('/api/auth/permissions', { preHandler: verify }, async (request: any) => request.user.permissions);
    app.get('/api/agents', { preHandler: verify }, async () => ({ defaultId: 'main', agents: [{ id: 'main', name: 'Fixture' }] }));
    app.get('/api/models', { preHandler: verify }, async () => ({ models: [] }));
    app.get('/api/chat/greeting', { preHandler: verify }, async () => ({ greeting: '合成测试对话' }));
    const apiUrl = await app.listen({ host: '127.0.0.1', port: 0 });
    const registry = new JobRegistry(); registry.register('investigation.execute', createInvestigationWorkflowHandler(async () => adapter!));
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
    return { url: `http://127.0.0.1:${address.port}`, pool, bridge, stream, contexts, owner, viewer, adapter, workerErrors, observationErrors, close,
      token: (actor = owner) => signAccessToken(actor, secret), counts: () => ({ toolCalls, providerCalls }),
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
