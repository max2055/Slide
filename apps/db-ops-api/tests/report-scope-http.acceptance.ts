/** MAX-618 / #546 and #631: full production server, TCP HTTP, real MySQL and live JWT/RBAC.
 * Explicit MAX618_MYSQL_HOST/PORT/USER/PASSWORD and MAX618_OUTPUT_DIR required.
 * Run from slide-api: pnpm exec tsx tests/report-scope-http.acceptance.ts
 * Never loads credentials from a private file. Only the generated schema is changed.
 */
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import mysql from 'mysql2/promise';
import { createOwnedDatabase } from '../src/testing/owned-fixture.js';
import { dbConnection } from '../src/db-connection.js';
import { reportConfigService } from '../src/report-config-database-service.js';
import { reportDatabaseService } from '../src/report-database-service.js';
import { MysqlReportOccurrenceStore } from '../src/report-scheduler.js';
import { MysqlWorkflowStore, WorkerRuntime } from '../src/workflows/worker-runtime.js';
import { JobRegistry } from '../src/workflows/job-registry.js';
import { registerReportScheduleHandler } from '../src/workflows/report-schedule-handler.js';
import { serverReportService } from '../src/server-report-service.js';
import { internalMetricConsumerService } from '../src/metrics/consumers/runtime.js';
import { MigrationRunner } from '../src/migrations/runner.js';

for (const key of ['MAX618_MYSQL_HOST', 'MAX618_MYSQL_PORT', 'MAX618_MYSQL_USER', 'MAX618_MYSQL_PASSWORD', 'MAX618_OUTPUT_DIR']) {
  assert(process.env[key] !== undefined, `${key} required`);
}
const config = { host: process.env.MAX618_MYSQL_HOST!, port: Number(process.env.MAX618_MYSQL_PORT),
  user: process.env.MAX618_MYSQL_USER!, password: process.env.MAX618_MYSQL_PASSWORD! };
assert(Number.isInteger(config.port) && config.port > 0);
const output = resolve(process.env.MAX618_OUTPUT_DIR!);
mkdirSync(output, { recursive: true });
let schema: string;
let owned: Awaited<ReturnType<typeof createOwnedDatabase>> | undefined;
const admin = mysql.createPool(config);
let pool: mysql.Pool;
const username = 'max618_operator';
const password = randomBytes(24).toString('hex');
const jwtSecret = randomBytes(32).toString('hex');
const encryptionKey = randomBytes(32).toString('hex');
const observations: unknown[] = [];
let active: ReturnType<typeof spawn> | undefined;
let closed: Promise<unknown> | undefined;
let logs = '';

let failure: unknown;
let round = 0;
const delay = (ms: number) => new Promise(done => setTimeout(done, ms));
async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
  return port;
}
async function stop() {
  if (!active) return;
  // Only signal the exact server child started here, never a name or port owner.
  const daemon = JSON.parse(execFileSync(process.env.MULTICA_CLI_PATH!, ['daemon', 'status', '--output', 'json'], { encoding: 'utf8' }));
  assert.notEqual(active.pid, daemon.pid, 'child must not be the workspace daemon');
  if (active.exitCode === null && active.signalCode === null) active.kill('SIGTERM');
  const timer = setTimeout(() => { if (active?.exitCode === null && active.signalCode === null) active.kill('SIGKILL'); }, 15000);
  try { await closed; } finally { clearTimeout(timer); }
  for (const secret of [password, jwtSecret, encryptionKey, config.password].filter(Boolean)) assert(!logs.includes(secret), 'process log secret scan');
  writeFileSync(resolve(output, `server-${round}.log`), logs, { mode: 0o600 });
  active = undefined;
}
async function start() {
  round++;
  logs = '';
  const port = await freePort(), wsPort = await freePort();
  active = spawn(process.execPath, ['--import', 'tsx', 'server.ts'], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'], env: {
    ...process.env, NODE_ENV: 'production', DB_HOST: config.host, DB_PORT: String(config.port), DB_USER: config.user,
    DB_PASSWORD: config.password, DB_NAME: schema, INITIAL_ADMIN_USERNAME: username, INITIAL_ADMIN_PASSWORD: password,
    JWT_SECRET_KEY: jwtSecret, ENCRYPTION_KEY: encryptionKey, PORT: String(port), AGENT_WS_PORT: String(wsPort),
    METRICS_COLLECTION_ENABLED: 'false', PROMPT_HOT_RELOAD: 'false', CORS_ORIGINS: `http://127.0.0.1:${port}`,
  } });
  closed = once(active, 'close');
  active.stdout!.on('data', chunk => { logs += chunk; });
  active.stderr!.on('data', chunk => { logs += chunk; });
  console.log(JSON.stringify({ pid: active.pid, port, wsPort, cwd: process.cwd(), command: 'node --import tsx server.ts',
    head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), log: `server-${round}.log`, schema, mysql: `${config.host}:${config.port}`, nodeEnv: 'production' }));
  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 600; attempt++) {
    assert(active.exitCode === null && active.signalCode === null, 'server exited during startup');
    try { if ((await fetch(`${base}/api/health/ready`)).ok) return base; } catch {}
    await delay(100);
  }
  throw new Error('server readiness deadline 60s exceeded');
}
async function request(base: string, path: string, body: unknown, status: number, token?: string, method = 'POST', json = true) {
  const response = await fetch(`${base}${path}`, { method, headers: { ...(json ? { 'content-type': 'application/json' } : {}),
    ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const result = await response.json() as any;
  observations.push({ round, path, method, input: body === undefined ? (json ? 'empty-json-body' : 'absent-body') :
    body === null ? 'null' : Array.isArray(body) ? 'array' : typeof body, expected: status, actual: response.status,
    ...(response.status === 400 ? { error: result.error, message: result.message } : {}) });
  assert.equal(response.status, status, `${method} ${path} input ${body === null ? 'null' : typeof body}`);
  return result;
}
try {
  assert.notEqual(config.port, 3306, 'shared platform database forbidden');
  owned = await createOwnedDatabase(admin as any, { nonce: randomBytes(8).toString('hex'), purpose: 'reportbounds', handleDir: output });
  schema = owned.database;
  pool = mysql.createPool({ ...config, database: schema, timezone: 'Z' });
  await new MigrationRunner(pool as any).run();
  await pool.execute('UPDATE llm_providers SET enabled=FALSE,is_default=FALSE');
  const base = await start();
  const login = await request(base, '/api/auth/login', { username, password }, 200);
  const token = login.token;
  await pool.query("INSERT INTO database_instances(id,name,host,port,username,password_encrypted) VALUES (701,'allowed','fixture.invalid',3307,'fixture','unused'),(702,'excluded','excluded.invalid',3307,'fixture','unused')");
  await pool.query("INSERT INTO servers(id,host,port,os_type,collection_enabled,credential_type,credential_encrypted) VALUES (701,'allowed.invalid',22,'Other',0,'password','unused'),(702,'excluded.invalid',22,'Other',0,'password','unused')");
  for (const status of ['pending','completed','failed']) {
    for (const id of [701,702]) {
      await pool.execute("INSERT INTO reports(name,type,instance_id,status) VALUES ('instance','health',?,?)", [id,status]);
      await pool.execute("INSERT INTO reports(name,type,server_id,status) VALUES ('server','server_health',?,?)", [id,status]);
    }
  }
  const stats = async (actor: string | undefined, expected: unknown, status = 200) => {
    const actual = await request(base, '/api/reports/stats', undefined, status, actor, 'GET', false);
    if (status === 200) assert.deepEqual(actual, expected);
    observations.push({ check: 'stats', status, actual });
  };
  const counts = (n: number) => ({total:n*3, completed:n, running:n, failed:n});
  await stats(undefined, null, 401);
  await stats(token, counts(4));
  await request(base, '/api/users', { username: 'max618_reader', password: 'synthetic-password' }, 201, token);
  const reader = (await request(base, '/api/auth/login', { username: 'max618_reader', password: 'synthetic-password' }, 200)).token;
  const [users] = await pool.query<any[]>("SELECT id FROM users WHERE username='max618_reader'");
  const uid = users[0].id;
  await pool.execute('DELETE FROM user_roles WHERE user_id=?', [uid]);
  const [role] = await pool.execute<any>("INSERT INTO roles(name) VALUES ('max618_scoped')");
  await pool.execute('INSERT INTO user_roles(user_id,role_id) VALUES (?,?)', [uid,role.insertId]);
  await pool.execute("INSERT INTO role_permissions(role_id,permission_id) SELECT ?,id FROM permissions WHERE code IN ('report:view','report:create')", [role.insertId]);
  await stats(reader, counts(0));
  const [legacy] = await pool.query<any[]>('SELECT COUNT(*) AS total FROM reports WHERE instance_id IS NULL');
  assert.equal(legacy[0].total,6);
  observations.push({check:'baseline #546 predicate reproduction',legacyUnscopedServerCount:legacy[0].total,currentNoResourceCount:0});
  await pool.execute("INSERT INTO instance_permissions(user_id,instance_id,access_level) VALUES (?,701,'read-only')", [uid]);
  await stats(reader, counts(1));
  const value = { name: 'target', cron:'@daily', type:'server_health', server_id:701, enabled:false };
  for (const payload of [
    {...value, server_id:undefined}, {...value, server_id:undefined, instance_id:701},
    {...value, instance_id:701}, {...value,type:'health'}, {...value,server_id:0}, {...value,server_id:'701'},
  ]) await request(base, '/api/reports/configs', payload, 400, token);
  await request(base, '/api/reports/configs', value, 403, reader);
  await pool.execute("INSERT INTO role_permissions(role_id,permission_id) SELECT ?,id FROM permissions WHERE code='servers:view'", [role.insertId]);
  await stats(reader, counts(3));
  const good = await request(base, '/api/reports/configs', value, 200, reader);
  await request(base, `/api/reports/configs/${good.id}`, {type:'health'}, 400, reader, 'PUT');
  await request(base, `/api/reports/configs/${good.id}`, {name:'renamed'}, 200, reader, 'PUT');
  await pool.execute("DELETE rp FROM role_permissions rp JOIN permissions p ON p.id=rp.permission_id WHERE rp.role_id=? AND p.code='servers:view'", [role.insertId]);
  await stats(reader, counts(1));
  await request(base, `/api/reports/configs/${good.id}`, {name:'denied'}, 404, reader, 'PUT');
  await pool.execute('DELETE FROM instance_permissions WHERE user_id=?', [uid]);
  await stats(reader, counts(0));
  await stats(token, counts(4));
  await stop();

  // Formal durable occurrence/worker/persistence chain. Only the metric query
  // source is a deterministic empty sample; no SSH, collectors or LLM calls.
  await dbConnection.initialize({ ...config, database: schema });
  const queried: number[] = [];
  const originalQuery = internalMetricConsumerService.query;
  internalMetricConsumerService.query = async (_actor, input) => {
    queried.push(input.resource.id);
    return { metrics: [] } as any;
  };
  try {
    // Server-owned boundary is not client-settable in JWT. Validate the same
    // production SQL with an explicit partial set, including every status.
    assert.deepEqual(await reportDatabaseService.getReportStats([701], [701]), counts(2));
    assert.deepEqual(await reportDatabaseService.getReportStats([], [702]), counts(1));
    assert.deepEqual(await reportDatabaseService.getReportStats([], []), counts(0));
    observations.push({check:'partial instance/server SQL scope', passed:true});
    const store = new MysqlReportOccurrenceStore(() => pool);
    const workflows = new MysqlWorkflowStore(() => pool as any);
    const registry = new JobRegistry();
    registerReportScheduleHandler(registry, {
      reportConfigService, serverReportService,
      reportService: {generateReport: async () => { throw Error('unexpected database generation'); }},
      enqueueReportSchedule: async () => {}, createOccurrenceStore: () => store,
    });
    const current = (await reportConfigService.getConfigById(good.id))!;
    let index = 0;
    for (const target of [
      {type:'server_health',server_id:null,instance_id:null},
      {type:'server_health',server_id:null,instance_id:701},
      {type:'health',server_id:701,instance_id:null},
      {type:'server_health',server_id:701,instance_id:701},
      {type:'server_health',server_id:701,instance_id:null},
      {type:'server_health',server_id:999999,instance_id:null},
    ]) {
      await pool.query("UPDATE workflow_jobs SET available_at=DATE_ADD(NOW(),INTERVAL 1 DAY) WHERE state IN ('queued','retry')");
      const before = queried.length;
      const occurrenceAt = new Date(Date.UTC(2026,0,1,0,index++));
      await store.schedule({configId:good.id,occurrenceAt}, {...current,...target} as any);
      // Align eligibility to the SQL clock, which claim() uses at second precision.
      await pool.execute("UPDATE workflow_jobs j JOIN report_schedule_occurrences o ON o.workflow_job_id=j.id SET j.available_at=DATE_SUB(NOW(),INTERVAL 1 SECOND) WHERE o.config_id=? AND o.occurrence_at=?", [good.id,occurrenceAt]);
      const worker = new WorkerRuntime(workflows, 'max618-formal');
      let result;
      try { result = await worker.runOnce((job,context) => registry.execute(job,context)); }
      finally { await worker.shutdown(); }
      const [rows] = await pool.execute<any[]>('SELECT o.state,o.last_error,o.report_id,j.last_error AS job_error FROM report_schedule_occurrences o JOIN workflow_jobs j ON j.id=o.workflow_job_id WHERE o.config_id=? AND o.occurrence_at=?', [good.id,occurrenceAt]);
      const saved = rows[0];
      if (target.server_id === 701 && target.instance_id === null && target.type === 'server_health') {
        assert.equal(result,'completed'); assert.equal(saved.state,'completed');
        assert.deepEqual(queried.slice(before),[701]);
        const report = (await reportDatabaseService.getReportById(saved.report_id))!;
        assert.equal(report.server_id,701); assert.equal(report.data.server_count,1);
        assert.equal(report.data.servers[0].host,'allowed.invalid');
        assert(!report.content!.includes('excluded.invalid'));
      } else {
        assert.equal(result,'retry'); assert.equal(saved.state,'failed');
        const reason = target.server_id === 999999 ? 'REPORT_SERVER_NOT_FOUND:999999' : 'REPORT_CONFIG_';
        assert(saved.last_error.includes(reason)); assert(saved.job_error.includes(reason));
        assert.equal(queried.length,before);
      }
      observations.push({check:'formal occurrence',target,result,record:saved,queried:queried.slice(before)});
    }
  } finally { internalMetricConsumerService.query = originalQuery; }
  console.log('PASS full TCP HTTP/JWT/live grants, target rejection, formal worker target isolation and real failure persistence; LLM requests=0');
} catch (error) { failure = error; }
finally {
  const cleanup: unknown[] = [];
  for (const step of [stop, () => dbConnection.close(), () => pool?.end(), async () => { await owned?.drop(); }, () => admin.end()]) {
    try { await step(); } catch (error) { cleanup.push(error); }
  }
  writeFileSync(resolve(output,'http-results.json'), JSON.stringify({schema,observations,cleanupErrors:cleanup.map(String),failure:failure?String(failure):null,passed:!failure&&!cleanup.length},null,2));
  if (failure || cleanup.length) throw new AggregateError([...(failure?[failure]:[]),...cleanup], 'MAX-618 acceptance failed; business and cleanup errors retained');
  console.log('PASS child stopped; owned schema dropped');
}
