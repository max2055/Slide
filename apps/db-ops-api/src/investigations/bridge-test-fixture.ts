import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import mysql, { type Pool, type RowDataPacket } from 'mysql2/promise';
import Fastify from 'fastify';
import { MigrationRunner } from '../migrations/runner.js';
import { ActorContextService, signAccessToken } from '../auth/actor-context.js';
import { createVerifyToken } from '../auth-middleware.js';
import { InvestigationAuthorization, provisionInvestigationServiceIdentity } from './authorization.js';
import { InvestigationSessionBridge } from './session-bridge.js';
import { LegacyAnalysisBridge } from './legacy-analysis-bridge.js';
import { DatabaseAlertBridge, type DatabaseAlertSource } from './alert-bridge.js';
import { registerInvestigationRoutes } from './routes.js';
import { registerAnalysisBridgeRoutes } from './bridge-routes.js';
import type { TransactionConnection } from '../workflows/outbox-service.js';
import { AnalysisDispatchStore } from '../analysis/analysis-dispatch-store.js';

/** Explicit fixture port or a new disposable container. Never fall back to
 * platform DB configuration. All suites apply the formal migrations. */
export async function bridgeTestFixture() {
  let port = Number(process.env.T08_TEST_MYSQL_PORT), container: string | undefined;
  if (!port) {
    container=`slide-t08-${process.pid}-${randomUUID()}`;
    execFileSync('docker',['run','--detach','--rm','--name',container,'--env','MYSQL_ALLOW_EMPTY_PASSWORD=yes','--publish','127.0.0.1::3306','mysql:8.4'],{stdio:'pipe'});
    port=Number(execFileSync('docker',['port',container,'3306/tcp'],{encoding:'utf8'}).trim().split(':').at(-1));
  }
  const database = `t08_${process.pid}_${randomUUID().replaceAll('-', '')}`;
  const options = { host: '127.0.0.1', port, user: 'root', password: process.env.T08_TEST_MYSQL_PASSWORD ?? '', timezone: 'Z' };
  const admin = mysql.createPool(options);
  const deadline=Date.now()+45_000;
  for (;;) { try { await admin.query('SELECT 1'); break; } catch(error) {
    if(Date.now()>deadline) { await admin.end(); if(container)execFileSync('docker',['stop','--time','10',container],{stdio:'pipe'}); throw error; }
    await new Promise(resolve=>setTimeout(resolve,500));
  } }
  await admin.query(`CREATE DATABASE ${database}`);
  const pool: Pool = mysql.createPool({ ...options, database, connectionLimit: 12 });
  await new MigrationRunner(pool).run();
  await new MigrationRunner(pool).run();
  await pool.query("INSERT IGNORE INTO permissions (code,name,resource,action) VALUES ('ai:view','AI read','ai','view'),('ai:manage','AI manage','ai','manage')");
  await pool.query("INSERT INTO users (id,username,password_hash) VALUES (101,'t08-owner','no-login'),(102,'t08-other','no-login')");
  await pool.query("INSERT INTO roles (id,name) VALUES (101,'t08-readonly')");
  await pool.query("INSERT INTO role_permissions (role_id,permission_id) SELECT 101,id FROM permissions WHERE code IN ('chat:view','instance:view','metric:view','alert:view','ai:view','ai:manage')");
  await pool.query('INSERT INTO user_roles (user_id,role_id) VALUES (101,101),(102,101)');
  await pool.query("INSERT INTO database_instances (id,name,host,port,username,password_encrypted) VALUES (101,'CPU fixture','fixture.invalid',3306,'fixture','unused'),(102,'SQL fixture','fixture.invalid',3306,'fixture','unused')");
  await pool.query("INSERT INTO instance_permissions (user_id,instance_id,access_level) VALUES (101,101,'read-only'),(101,102,'read-only'),(102,101,'read-only'),(102,102,'read-only')");
  const c = await pool.getConnection();
  let serviceId: number;
  try { serviceId = await provisionInvestigationServiceIdentity(c as unknown as TransactionConnection, 't08-pilot'); }
  finally { c.release(); }
  await pool.query("INSERT INTO roles (id,name) VALUES (201,'t08-service-readonly')");
  await pool.query("INSERT INTO role_permissions (role_id,permission_id) SELECT 201,id FROM permissions WHERE code IN ('chat:view','instance:view','metric:view','alert:view')");
  await pool.query('INSERT INTO user_roles (user_id,role_id) VALUES (?,201)', [serviceId]);
  await pool.query("INSERT INTO instance_permissions (user_id,instance_id,access_level) VALUES (?,101,'read-only'),(?,102,'read-only')", [serviceId, serviceId]);
  const contexts = new ActorContextService(() => pool as never);
  const authorization = new InvestigationAuthorization(contexts);
  const bridge = new InvestigationSessionBridge(() => pool, authorization);
  const legacy = new LegacyAnalysisBridge(() => pool, authorization, bridge);
  const owner = await contexts.loadActiveActor(101), other = await contexts.loadActiveActor(102);
  const flags = { manual: true, opsAuto: true, legacy: true };
  const alertBridge = new DatabaseAlertBridge(() => pool, contexts, authorization, bridge, () => flags,
    () => ({ configured: true, serviceUserId: serviceId, instanceIds: [101,102], policyId: 'database-alert-pilot', policyVersion: 1 }));
  let oldCalls = 0;
  const alerts = new Map<number, DatabaseAlertSource>();
  const old = async () => {
    oldCalls++;
    const alert=[...alerts.values()].at(-1)!;
    return new AnalysisDispatchStore(()=>pool).enqueue({analysisType:'alert_rca',cacheKey:`alert:${alert.id}:instance:${alert.instance_id}`,
      triggerType:'manual',relatedId:alert.id,request:{purpose:'alert_rca',subject:{type:'instance',id:alert.instance_id!},actor:owner,
        message:'Synthetic persisted legacy input',systemPrompt:'Read only',evidenceVersion:'fixture',configVersion:'fixture',authorizationVersion:'fixture'}});
  };
  const source = (id: number, metric = 'cpu_usage', instance = 101): DatabaseAlertSource => {
    const value = { id, instance_id: instance, title: `CPU/慢SQL ${metric}`, message: '受控只读事实', level: 'critical',
      created_at: new Date('2026-10-13T10:00:00Z'), metric_name: metric };
    alerts.set(id, value); return value;
  };
  const app = Fastify();
  const secret = randomUUID(), verify = createVerifyToken(secret, contexts);
  await registerInvestigationRoutes(app, verify, bridge, bridge.observationServices(), legacy);
  await registerAnalysisBridgeRoutes(app, verify, legacy, () => flags, { analyzeAlert: async (id, trigger, actor) => {
    const alert = alerts.get(id); if (!alert) return { success: false, error: 'INVESTIGATION_NOT_FOUND' };
    return alertBridge.dispatch(alert, trigger, actor, old);
  } });
  const headers = (actor = owner) => ({ authorization: `Bearer ${signAccessToken(actor, secret)}` });
  const count = async (table: string) => Number((await pool.query<RowDataPacket[]>(`SELECT COUNT(*) AS n FROM ${table}`))[0][0].n);
  const insertLegacy = async (type = 'fault_diagnosis', status = 'completed', result: unknown = '原历史结果，未验证根因') => {
    const [insert] = await pool.execute<mysql.ResultSetHeader>(`INSERT INTO ai_analysis
      (analysis_type,target_type,instance_id,trigger_type,status,result) VALUES (?,'instance',101,'auto',?,?)`, [type,status,JSON.stringify(result)]);
    return Number(insert.insertId);
  };
  return { pool, admin, app, contexts, authorization, bridge, legacy, alertBridge, owner, other, serviceId, flags,
    source, headers, count, insertLegacy, old, oldCalls: () => oldCalls,
    close: async () => { try { await app.close(); await pool.end(); await admin.query(`DROP DATABASE ${database}`); await admin.end(); }
      finally { if(container)execFileSync('docker',['stop','--time','10',container],{stdio:'pipe'}); } } };
}
