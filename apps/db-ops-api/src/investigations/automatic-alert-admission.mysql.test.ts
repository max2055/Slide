import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bridgeTestFixture } from './bridge-test-fixture.js';
import { DatabaseAlertBridge } from './alert-bridge.js';
import { INVESTIGATION_EFFECTIVE_BUDGET_KEY } from './effective-budget.js';
import { recoverAutomaticAlertAdmissions } from './automatic-alert-admission.js';
import { dbConnection } from '../db-connection.js';
import { alertDatabaseService } from '../alert-database-service.js';

// Real SQL, real authorization and admission/outbox; no worker/provider sends.
describe('MAX-225 automatic alert admission', () => {
  let f: Awaited<ReturnType<typeof bridgeTestFixture>>;
  const original = dbConnection.getPool;
  beforeAll(async () => { f = await bridgeTestFixture(); }, 120_000);
  afterAll(async () => { dbConnection.getPool = original; await f?.close(); }, 30_000);
  async function config(value: unknown) {
    await f.pool.query("REPLACE INTO system_config (config_key,config_value) VALUES ('auto_analysis_config',?)", [JSON.stringify(value)]);
  }
  it('master off suppresses at the bridge without creating an owner or legacy job', async () => {
    await config({enabled:false});
    expect(await f.alertBridge.dispatch(f.source(9001), 'auto', undefined, f.old)).toMatchObject({status:'suppressed',error:'AUTO_ANALYSIS_DISABLED'});
    expect(await f.count('investigation_alert_owners')).toBe(0);
    expect(await f.count('workflow_jobs')).toBe(0);
    expect(f.oldCalls()).toBe(0);
  });
  it('disabled ops lane never falls back to old automatic execution', async () => {
    await config({enabled:true}); f.flags.opsAuto = false;
    try {
      expect(await f.alertBridge.dispatch(f.source(9002), 'auto', f.owner, f.old)).toMatchObject({status:'suppressed',error:'AUTO_ANALYSIS_LANE_DISABLED'});
      expect(await f.count('workflow_jobs')).toBe(0); expect(f.oldCalls()).toBe(0);
    } finally { f.flags.opsAuto = true; }
  });
  it.each([
    [{severityLevels:['warning']}, 'AUTO_ANALYSIS_SEVERITY_EXCLUDED'],
    [{instanceWhitelist:[999]}, 'AUTO_ANALYSIS_RESOURCE_EXCLUDED'],
    [{timeWindowStart:'invalid'}, 'AUTO_ANALYSIS_CONFIG_INVALID'],
    [{enabled:'true'}, 'AUTO_ANALYSIS_CONFIG_INVALID'],
  ])('configuration suppression has a stable reason: %j', async (value, reason) => {
    await config(value);
    expect(await f.alertBridge.dispatch(f.source(9003), 'auto', undefined, f.old)).toMatchObject({status:'suppressed',error:reason});
    expect(await f.count('workflow_jobs')).toBe(0); expect(f.oldCalls()).toBe(0);
  });
  it('all three autocommit alert writes call the same admission after persistence', async () => {
    await config({enabled:false}); dbConnection.getPool = () => f.pool;
    await f.pool.query("INSERT INTO servers (id,host,port,os_type,credential_type,credential_encrypted) VALUES (101,'fixture.invalid',22,'linux','password','unused')");
    await f.pool.query("INSERT INTO network_devices (id,name,host,vendor) VALUES (101,'fixture','fixture.invalid','huawei')");
    for (const subject of [{instance_id:101}, {server_id:101}, {network_device_id:101}]) {
      const result = await alertDatabaseService.createAlert({...subject,alert_type:'performance',level:'critical',title:'CPU',message:'CPU critical'});
      expect(result.success).toBe(true);
      const [rows] = await f.pool.query<any[]>('SELECT tags FROM alerts WHERE id=?',[result.alertId]);
      const tags = typeof rows[0].tags === 'string' ? JSON.parse(rows[0].tags) : rows[0].tags;
      expect(tags?.auto_analysis).toMatchObject({status:'suppressed',reason:'AUTO_ANALYSIS_DISABLED'});
    }
    expect(await f.count('workflow_jobs')).toBe(0);
  });
  it('single critical survives a bridge restart with one durable job and no legacy send', async () => {
    await config({enabled:true});
    const alert = f.source(9004);
    const first = await f.alertBridge.dispatch(alert,'auto',undefined,f.old);
    expect(first.investigationId).toBeTruthy();
    const restarted = new DatabaseAlertBridge(() => f.pool, f.contexts, f.authorization, f.bridge, () => f.flags,
      () => ({configured:true,serviceUserId:f.serviceId,instanceIds:[101],policyId:'database-alert-pilot',policyVersion:1}));
    expect((await restarted.dispatch(alert,'auto',undefined,f.old)).investigationId).toBe(first.investigationId);
    expect(await f.count('workflow_jobs')).toBe(1); expect(f.oldCalls()).toBe(0);
  });
  it('automatic budget refusal records a reason without another job or legacy fallback', async () => {
    await config({enabled:true});
    const key = INVESTIGATION_EFFECTIVE_BUDGET_KEY;
    await f.pool.query("REPLACE INTO system_config (config_key,config_value) VALUES (?,?)",[key,JSON.stringify({schemaVersion:1,version:1,
      runtime:{contextWindowTokens:32768,outputTokens:4096,summaryOutputTokens:4096,maxExecutionTokens:32768},
      profileLimits:{deadlineMs:600000,maxToolCalls:36,maxProviderAttempts:8,maxRows:200,maxBytes:128000,maxWindowMs:3600000},
      admission:{revision:2,policy:{maxConcurrent:1,manualReserved:1,maxPerResourceConcurrent:1,maxAutomaticRequestsPerHour:1,
        maxAutomaticTokensPerDay:100000,maxTotalTokensPerDay:100000,maxCostMicrosPerDay:10000000}},updatedAt:'2026-10-25T00:00:00.000Z'})]);
    try {
      const before = await f.count('workflow_jobs');
      const result = await f.alertBridge.dispatch(f.source(9010,'budget_cpu',102),'auto',undefined,f.old);
      expect(result).toMatchObject({success:false,status:'suppressed',error:'MANUAL_CAPACITY_RESERVED'});
      expect(await f.count('workflow_jobs')).toBe(before); expect(f.oldCalls()).toBe(0);
    } finally { await f.pool.query('DELETE FROM system_config WHERE config_key=?',[key]); }
  });
  it('three supported resource sources create exactly one job each through createAlert', async () => {
    const isolated = await bridgeTestFixture();
    const keys = ['INVESTIGATION_OPS_AUTO_ENABLED','INVESTIGATION_OPS_SERVICE_USER_ID','INVESTIGATION_OPS_INSTANCE_IDS',
      'INVESTIGATION_OPS_SERVER_IDS','INVESTIGATION_OPS_NETWORK_DEVICE_IDS'];
    const saved = keys.map(key => process.env[key]);
    const before = await isolated.count('workflow_jobs');
    dbConnection.getPool = () => isolated.pool;
    await isolated.pool.query("INSERT INTO servers (id,host,port,os_type,credential_type,credential_encrypted) VALUES (101,'fixture.invalid',22,'linux','password','unused')");
    await isolated.pool.query("INSERT INTO network_devices (id,name,host,vendor) VALUES (101,'fixture','fixture.invalid','huawei')");
    await isolated.pool.query("INSERT INTO role_permissions (role_id,permission_id) SELECT 201,id FROM permissions WHERE code IN ('servers:view','network_devices:view')");
    keys.forEach((key,i) => process.env[key] = i === 0 ? 'true' : i === 1 ? String(isolated.serviceId) : '101');
    try {
      const ids: number[] = [];
      for (const subject of [{instance_id:101}, {server_id:101}, {network_device_id:101}]) {
        const result = await alertDatabaseService.createAlert({...subject,alert_type:'performance',level:'critical',title:'CPU',message:'CPU critical',metric_name:'separate_cpu'});
        expect(result.success).toBe(true); ids.push(result.alertId!);
        const [rows] = await isolated.pool.query<any[]>('SELECT tags FROM alerts WHERE id=?',[result.alertId]);
        expect(rows[0].tags.auto_analysis.investigationId, JSON.stringify(rows[0].tags.auto_analysis)).toBeTruthy();
      }
      expect(await isolated.count('workflow_jobs')).toBe(before + 3);
      await recoverAutomaticAlertAdmissions();
      expect(await isolated.count('workflow_jobs')).toBe(before + 3);
      const [owners] = await isolated.pool.query<any[]>('SELECT * FROM investigation_alert_owners WHERE alert_id IN (?,?,?)',ids);
      expect(owners).toHaveLength(3); expect(owners.every(row => row.lane === 'investigation' && row.investigation_id)).toBe(true);
      expect(isolated.oldCalls()).toBe(0);
    } finally { keys.forEach((key,i) => { if (saved[i] === undefined) delete process.env[key]; else process.env[key] = saved[i]; }); dbConnection.getPool = () => f.pool; await isolated.close(); }
  }, 120_000);
  it('transactional writes are not admitted before commit; recovery ignores rollback and unmarked history', async () => {
    await config({enabled:false}); dbConnection.getPool = () => f.pool;
    const c = await f.pool.getConnection();
    const data = {instance_id:101,alert_type:'performance',level:'critical',title:'transaction',message:'persist first'};
    try {
      await c.beginTransaction();
      const committed = await alertDatabaseService.createAlert(data,c);
      const [pending] = await c.query<any[]>('SELECT tags FROM alerts WHERE id=?',[committed.alertId]);
      expect(pending[0].tags.auto_analysis.status).toBe('pending');
      await c.commit();
      await c.beginTransaction();
      const rolledBack = await alertDatabaseService.createAlert(data,c); await c.rollback();
      await f.pool.query("INSERT INTO alerts (instance_id,alert_type,level,title,message) VALUES (101,'performance','critical','history','do not backfill')");
      await recoverAutomaticAlertAdmissions();
      await recoverAutomaticAlertAdmissions();
      const [rows] = await f.pool.query<any[]>('SELECT tags FROM alerts WHERE id=?',[committed.alertId]);
      expect(rows[0].tags.auto_analysis).toMatchObject({status:'suppressed',reason:'AUTO_ANALYSIS_DISABLED'});
      expect((await f.pool.query<any[]>('SELECT * FROM alerts WHERE id=?',[rolledBack.alertId]))[0]).toHaveLength(0);
      const [history] = await f.pool.query<any[]>("SELECT tags FROM alerts WHERE title='history'"); expect(history[0].tags).toBeNull();
    } finally { c.release(); }
  });

});
