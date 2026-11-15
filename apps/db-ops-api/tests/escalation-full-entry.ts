// Explicit acceptance command; no default test collection or private credential dependency.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import mysql from 'mysql2/promise';
import Fastify from 'fastify';
import ts from 'typescript';
import { dbConnection } from '../src/db-connection.js';
import { MigrationRunner } from '../src/migrations/runner.js';
import { alertEscalationService } from '../src/alert-escalation-service.js';
import { registerAlertEscalationRoute } from '../src/alert-escalation-routes.js';
import { createVerifyToken } from '../src/auth-middleware.js';
import { actorContextService, signAccessToken } from '../src/auth/actor-context.js';
import { requirePermission } from '../src/auth/require-permission.js';
import { requireUnrestrictedInstanceAccess } from '../src/auth/require-instance-access.js';
import { smtpRecipient } from '../src/workflows/delivery-test-recipients.js';
import { MysqlWorkflowStore, WorkerRuntime } from '../src/workflows/worker-runtime.js';
import { JobRegistry } from '../src/workflows/job-registry.js';
import { registerNotificationHandlers } from '../src/workflows/notification-handlers.js';
import { notificationDatabaseService } from '../src/notification-database-service.js';
import { notificationService } from '../src/notification-service.js';
import { reportDatabaseService } from '../src/report-database-service.js';

const options = JSON.parse(process.env.ESCALATION_MYSQL_CONFIG!);
assert.equal(options.port, 3308);
delete options.database;
process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex');
const schema = 'max564_full_' + Date.now();
const admin = await mysql.createConnection(options);
const app = Fastify();
const smtp = await smtpRecipient();
let worker: WorkerRuntime | undefined;
try {
  await admin.query('CREATE DATABASE ' + schema);
  assert(await dbConnection.initialize({ ...options, database: schema }));
  const pool = dbConnection.getPool()!;
  await new MigrationRunner(pool as any).run();
  console.log('full migration chain installed');
  // Reproduce the reported precision mismatch before applying service validation.
  await pool.execute("INSERT INTO escalation_rules(name,from_level,to_level,trigger_condition,trigger_value) VALUES('fraction','warning','error','timeout_minutes',?)", [0.1]);
  const [fraction] = await pool.query<any[]>("SELECT trigger_value FROM escalation_rules WHERE name='fraction'");
  assert.equal(fraction[0].trigger_value, 0);
  console.log('precision reproduction: 0.1 stored as 0');
  await pool.query('DELETE FROM escalation_rules');
  await pool.query("INSERT INTO database_instances(id,name,host,port,database_name,username,password_encrypted) VALUES(564,'fixture','fixture.invalid',3308,'fixture','fixture','unused')");
  await pool.query("INSERT INTO users(id,username,password_hash) VALUES(564,'max564','no-login')");
  await pool.query("INSERT INTO user_roles(user_id,role_id) SELECT 564,id FROM roles WHERE name='admin'");
  const actor = await actorContextService.loadActiveActor(564);
  const secret = randomBytes(32).toString('hex');
  const verifyToken = createVerifyToken(secret);
  // Execute the actual inline route registration source, without starting unrelated
  // application workers. This preserves handlers and authorization middleware.
  const server = await readFile(new URL('../server.ts', import.meta.url), 'utf8');
  const block = server.slice(server.indexOf("  fastify.get('/api/alerts/escalation/rules'"), server.indexOf('  await registerAlertEscalationRoute(fastify, verifyToken);'));
  assert(block.includes("/api/alerts/escalation/check"));
  const js = ts.transpileModule(block, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  new Function('fastify','verifyToken','requirePermission','requireUnrestrictedInstanceAccess','alertEscalationService',js)(app,verifyToken,requirePermission,requireUnrestrictedInstanceAccess,alertEscalationService);
  await registerAlertEscalationRoute(app,verifyToken);
  const url = await app.listen({ host:'127.0.0.1',port:0 });
  const headers = { authorization:'Bearer '+signAccessToken(actor,secret),'content-type':'application/json' };
  const api = async (path:string,body:any={}, method='POST', status=200) => {
    const response = await fetch(url+path,{method,headers,body:JSON.stringify(body)});
    assert.equal(response.status,status);
    return response.json() as Promise<any>;
  };
  const rule = {name:'wait',from_level:'warning',to_level:'error',trigger_condition:'timeout_minutes',trigger_value:30};
  assert.equal((await api('/api/alerts/escalation/rules',{...rule,trigger_condition:'unsupported'})).success,false);
  const created = await api('/api/alerts/escalation/rules',rule);assert(created.success);
  assert.equal((await api('/api/alerts/escalation/rules/'+created.ruleId,{trigger_condition:'unsupported'},'PUT')).success,false);
  for (const n of [0.1,0.5,1.1,2147483648]) {
    assert.equal((await api('/api/alerts/escalation/rules',{...rule,trigger_value:n})).success,false);
    assert.equal((await api('/api/alerts/escalation/rules/'+created.ruleId,{trigger_value:n},'PUT')).success,false);
  }
  // Production channel persistence, enqueue, worker, delivery gate and SMTP transport.
  await pool.execute("INSERT INTO notification_channels(id,name,type,config,enabled,delivery_start_at) VALUES(1,'controlled','email',?,1,DATE_SUB(NOW(),INTERVAL 2 DAY))",[JSON.stringify(smtp.channel.config)]);
  await pool.query("INSERT INTO alerts(id,instance_id,alert_type,level,title,message,status,created_at) VALUES(564,564,'performance','warning','fixture','fixture','unread',DATE_SUB(NOW(),INTERVAL 1 DAY))");
  await pool.query("CREATE TRIGGER max564_fail BEFORE INSERT ON alert_event_logs FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='injected'");
  assert.equal((await api('/api/alerts/564/escalate',{new_level:'error'},'POST',503)).error,'ESCALATION_STATE_UNKNOWN');
  assert.equal((await api('/api/alerts/escalation/check')).escalated,0);
  const count = async (table:string) => (await pool.query<any[]>('SELECT COUNT(*) n FROM '+table))[0][0].n;
  assert.equal((await pool.query<any[]>('SELECT level FROM alerts WHERE id=564'))[0][0].level,'warning');
  assert.equal(await count('alert_event_logs'),0);assert.equal(await count('workflow_jobs'),0);assert.equal(smtp.messages.length,0);
  await pool.query('DROP TRIGGER max564_fail');
  await Promise.all([api('/api/alerts/escalation/check'),api('/api/alerts/escalation/check'),
    fetch(url+'/api/alerts/564/escalate',{method:'POST',headers,body:JSON.stringify({new_level:'error'})}).then(async response => {
      // MAX-576: if the scanner wins, the same-level manual request is a conflict.
      assert([200,409].includes(response.status));
      const body = await response.json() as any;
      if(response.status===409) assert.equal(body.error,'ESCALATION_DIRECTION');
      else assert.equal(body.changed,true);
    })]);
  assert.equal(await count('alert_event_logs'),1);assert.equal(await count('workflow_jobs'),1);
  assert.equal(smtp.messages.length,0); // No send inside transaction.
  const registry = new JobRegistry();
  registerNotificationHandlers(registry,notificationDatabaseService,notificationService,reportDatabaseService);
  worker = new WorkerRuntime(new MysqlWorkflowStore(()=>pool as any),'max564',30);
  assert.equal(await worker.runOnce((job,context)=>registry.execute(job,context)),'completed');
  assert.equal(smtp.messages.length,1);
  assert.equal(await worker.runOnce((job,context)=>registry.execute(job,context)),'idle');
  assert.equal((await api('/api/alerts/escalation/check')).escalated,0);
  console.log('PASS HTTP CRUD + manual/automatic overlap + log failure rollback + production enqueue/worker/SMTP once');
} finally {
  await worker?.shutdown();
  await app.close();
  await smtp.close();
  await dbConnection.close();
  await admin.query('DROP DATABASE IF EXISTS '+schema);
  await admin.end();
  console.log('CLEANUP completed');
}
