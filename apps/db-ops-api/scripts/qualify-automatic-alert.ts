/** Explicit MAX-225 qualification. Shared configuration is SELECT-only; all
 * alert/policy/admission writes use a disposable formal MySQL schema. */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import mysql from 'mysql2/promise';
import { parse } from 'dotenv';
import { bridgeTestFixture } from '../src/investigations/bridge-test-fixture.js';
import { dbConnection } from '../src/db-connection.js';
import { createAssetCollectorAccess } from '../src/metrics/config/access.js';
import { createConfigurationRegistry } from '../src/metrics/config/registry.js';
import { runPackage } from '../src/metrics/packages/runner.js';
import { policyService } from '../src/metrics/policy/service.js';
import { admin } from '../src/metrics/policy/test-support.js';
import { RolloutControl } from '../src/metrics/rollout/control.js';
import { serverAlertEvaluator } from '../src/server-alert-evaluator.js';
import sshSessionPool from '../src/ssh-session-pool.js';

assert(process.env.MAX225_CONFIG_ENV && process.env.MAX225_EVIDENCE, 'EXPLICIT_QUALIFICATION_PATHS_REQUIRED');
const env = parse(readFileSync(process.env.MAX225_CONFIG_ENV));
process.env.ENCRYPTION_KEY = env.ENCRYPTION_KEY;
const shared = mysql.createPool({host:env.DB_HOST,port:Number(env.DB_PORT??3306),user:env.DB_USER,password:env.DB_PASSWORD,database:env.DB_NAME});
const evidence: any = {schemaVersion:1, qualification:'MAX-225', startedAt:new Date().toISOString(), sharedWrites:0, modelRequests:0, samples:[]};
const originalPool = dbConnection.getPool;
let f: Awaited<ReturnType<typeof bridgeTestFixture>> | undefined;
try {
  evidence.stage='read_bound_resource';
  const [servers] = await shared.query<any[]>('SELECT id,host,port,label,os_type,credential_type,credential_encrypted,host_key_fingerprint,status,collection_enabled FROM servers WHERE id=?',[Number(process.env.MAX225_SERVER_ID ?? 3)]);
  assert(servers.length===1 && servers[0].credential_encrypted, 'BOUND_VM_CREDENTIAL_REQUIRED');
  const server = servers[0];
  evidence.stage='isolated_schema';
  f = await bridgeTestFixture(); dbConnection.getPool = () => f!.pool;
  const columns = Object.keys(server);
  await f.pool.query(`INSERT INTO servers (${columns.join(',')}) VALUES (${columns.map(()=>'?').join(',')})`,columns.map(key=>server[key]));
  await f.pool.query("INSERT INTO role_permissions (role_id,permission_id) SELECT 201,id FROM permissions WHERE code='servers:view'");
  process.env.INVESTIGATION_OPS_AUTO_ENABLED='true';
  process.env.INVESTIGATION_OPS_SERVICE_USER_ID=String(f.serviceId);
  process.env.INVESTIGATION_OPS_SERVER_IDS=String(server.id);
  const registry = createConfigurationRegistry();
  const pin = registry.list().find(r=>r.package.id==='linux-host')!.package;
  const definition = registry.catalog(pin).find(d=>d.id==='linux.cpu.user_system_percent')!;
  const collector = pin.collectors.find(c=>c.mappings.some(m=>m.metric.id===definition.id))!;
  const ref = {type:'server' as const,id:server.id};
  await policyService.changeBinding(admin,ref,{expected_revision:0,package:{id:pin.id,version:pin.version,digest:pin.digest}},true);
  await f.pool.query('UPDATE alert_rules SET enabled=0');
  evidence.stage='resolve_bound_collector';
  const access = await createAssetCollectorAccess().resolve(ref);
  const control = new RolloutControl(f.pool);
  let initialized = false, alertId: number | undefined;
  evidence.resource={type:'server',id:server.id};
  for (let index=0;index<8;index++) {
    evidence.stage='collect_vm';
    const result = await runPackage(registry,{package:{id:pin.id,version:pin.version,digest:pin.digest},credential_ref:access.credential_ref},
      {...access,binding_id:`server:${server.id}`,attempt_id:`MAX225:${randomUUID()}`,config_revision:1,observed_at:new Date().toISOString(),
        signal:AbortSignal.timeout(30_000),collector_ids:[collector.id],metric_keys:[`${definition.id}@${definition.semantic_version}`]});
    const observation = result.observations.find(o=>o.observation.metric.id===definition.id)?.observation;
    evidence.samples.push({attempts:result.attempts.map(a=>({status:a.status,error:a.error})),observation});
    assert(observation?.quality.status==='good' && observation.value?.encoding==='float64','REAL_CPU_OBSERVATION_REQUIRED');
    if (!initialized) {
      assert(observation.value.value>0,'NONZERO_CPU_REQUIRED_FOR_NATURAL_RECOVERY');
      evidence.threshold=observation.value.value*0.95;
      await f.pool.query(`INSERT INTO alert_rules (id,name,target_type,server_id,metric_name,operator,threshold,duration_seconds,severity,enabled)
        VALUES (9001,'MAX225 real VM CPU','server',?,'cpu_usage','>',?,0,'critical',1)`,[server.id,evidence.threshold]);
      await control.initialize(observation,{source:'semantic',read:'semantic',revision:1,package:{id:pin.id,version:pin.version,digest:pin.digest}});
      await control.applied(observation,{source:'semantic',generation:1,revision:1});
      initialized=true;
    }
    // Preserve actual collection timestamps/values; no fabricated observations.
    await control.publish(observation,definition,{source:'semantic',generation:1,revision:1});
    evidence.stage='evaluate_and_admit';
    await serverAlertEvaluator.evaluateServerRules();
    const [alerts] = await f.pool.query<any[]>('SELECT id,status,metric_value,tags,resolved_at FROM alerts WHERE server_id=? ORDER BY id',[server.id]);
    evidence.alerts=alerts;
    alertId ??= alerts[0]?.id;
    if (alertId && alerts.find(a=>a.id===alertId)?.status==='resolved') { evidence.recovered=true; break; }
  }
  assert(alertId,'REAL_ALERT_REQUIRED');
  const [owners] = await f.pool.query<any[]>('SELECT alert_id,lane,investigation_id,analysis_id FROM investigation_alert_owners WHERE alert_id=?',[alertId]);
  evidence.owners=owners;
  assert(owners.length===1 && owners[0].investigation_id && owners[0].lane==='investigation','AUTOMATIC_ADMISSION_REQUIRED');
  evidence.admissionVerified=true;
  assert(evidence.recovered,'NATURAL_CPU_RECOVERY_NOT_OBSERVED');
} catch (error) {
  evidence.failure = error instanceof assert.AssertionError ? error.message : (error as {code?:string}).code ?? 'QUALIFICATION_FAILED';
  process.exitCode=1;
} finally {
  evidence.finishedAt=new Date().toISOString();
  writeFileSync(process.env.MAX225_EVIDENCE!,JSON.stringify(evidence,null,2));
  console.log(JSON.stringify({admissionVerified:evidence.admissionVerified??false,recovered:evidence.recovered??false,failure:evidence.failure??null,samples:evidence.samples.length,modelRequests:0}));
  dbConnection.getPool=originalPool;
  sshSessionPool.closeAll();
  await f?.close(); await shared.end();
}
