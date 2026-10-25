import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bridgeTestFixture } from './bridge-test-fixture.js';
import { DatabaseAlertBridge } from './alert-bridge.js';
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
});
