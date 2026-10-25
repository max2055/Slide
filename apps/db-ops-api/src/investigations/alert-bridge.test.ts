import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { bridgeTestFixture } from './bridge-test-fixture.js';
import { INVESTIGATION_EFFECTIVE_BUDGET_KEY } from './effective-budget.js';

describe('T08 database alert single owner / formal MySQL + JWT + HTTP', () => {
  let f: Awaited<ReturnType<typeof bridgeTestFixture>>;
  beforeAll(async () => { f = await bridgeTestFixture(); },120_000);
  afterAll(async () => { await f?.close(); },30_000);
  it('CPU event then 50 browser/manual entrants use one investigation/request/job/ledger and zero legacy chains', async () => {
    const alert=f.source(701); const initial=await f.alertBridge.dispatch(alert,'auto',undefined,f.old);
    expect(initial.success).toBe(true);
    const responses=await Promise.all(Array.from({length:50},()=>f.app.inject({method:'POST',url:'/api/alerts/701/investigation',headers:f.headers(),payload:{}})));
    expect(responses.map(r=>r.statusCode)).toEqual(Array(50).fill(202));
    expect(new Set(responses.map(r=>r.json().investigationId))).toEqual(new Set([initial.investigationId]));
    for(const table of ['investigations','investigation_requests','workflow_jobs','investigation_budget_ledger','operational_events']) expect(await f.count(table)).toBe(1);
    const detail=await f.app.inject({url:`/api/investigations/${initial.investigationId}`,headers:f.headers()});
    expect(detail.statusCode).toBe(200); expect(detail.json().id).toBe(initial.investigationId);
    expect(f.oldCalls()).toBe(0);
  });
  it('disable both flags while a new job is running: same id, no legacy takeover', async () => {
    const alert=f.source(702,'slow_queries',102); const initial=await f.alertBridge.dispatch(alert,'auto',undefined,f.old);
    await f.pool.query("UPDATE workflow_jobs SET state='running',lease_owner='t08-controlled',lease_expires_at=NOW()+INTERVAL 1 MINUTE WHERE BINARY id=(SELECT BINARY job_id FROM investigation_requests WHERE investigation_id=?)",[initial.investigationId]);
    f.flags.opsAuto=false; f.flags.manual=false;
    const again=await f.alertBridge.dispatch(alert,'manual',f.owner,f.old);
    expect(again.investigationId).toBe(initial.investigationId); expect(f.oldCalls()).toBe(0);
    const old=f.source(703); const legacy=await f.alertBridge.dispatch(old,'manual',f.owner,f.old);
    expect(legacy.analysisId).toBeGreaterThan(0); expect(f.oldCalls()).toBe(1);
    const [dispatch]=await f.pool.query<any[]>('SELECT job_id FROM analysis_dispatches WHERE analysis_id=?',[legacy.analysisId]);
    expect(dispatch).toHaveLength(1);
    f.flags.opsAuto=true; f.flags.manual=true;
  });
  it('existing old running/unknown analysis stays owned by old path', async () => {
    const alert=f.source(704); const id=await f.insertLegacy('alert_rca','running');
    await f.pool.query('UPDATE ai_analysis SET related_id=704 WHERE id=?',[id]);
    const initial=await f.alertBridge.dispatch(alert,'auto',undefined,f.old);
    expect(initial.analysisId).toBe(id); expect(initial.investigationId).toBeUndefined(); expect(f.oldCalls()).toBe(1);
    await f.pool.query("UPDATE ai_analysis SET status='unknown' WHERE id=?",[id]);
    const unknown=await f.alertBridge.dispatch(alert,'manual',f.owner,f.old);
    expect(unknown).toMatchObject({success:false,analysisId:id,status:'unknown'}); expect(f.oldCalls()).toBe(1);
  });
  it('SQL service grant revocation denies new source and existing link, never falls back to legacy', async () => {
    const existing=f.source(701); const before=await f.count('workflow_jobs');
    await f.pool.query('DELETE FROM instance_permissions WHERE user_id=? AND instance_id=101',[f.serviceId]);
    await expect(f.alertBridge.dispatch(existing,'auto',undefined,f.old)).rejects.toMatchObject({code:'INVESTIGATION_NOT_FOUND'});
    await expect(f.alertBridge.dispatch(f.source(705),'auto',undefined,f.old)).rejects.toMatchObject({code:'INVESTIGATION_NOT_FOUND'});
    expect(await f.count('workflow_jobs')).toBe(before); expect(f.oldCalls()).toBe(1);
    await f.pool.query("INSERT INTO instance_permissions (user_id,instance_id,access_level) VALUES (?,101,'read-only')",[f.serviceId]);
  });
  it('queue write failure preserves new lane across flag rollback; same key recovers exactly once', async () => {
    const alert=f.source(706,'cpu_usage',102);
    await f.pool.query("CREATE TRIGGER bridge_fail BEFORE INSERT ON workflow_jobs FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='controlled write failure'");
    await expect(f.alertBridge.dispatch(alert,'manual',f.owner,f.old)).rejects.toThrow();
    const [rows]=await f.pool.query<any[]>('SELECT lane,investigation_id FROM investigation_alert_owners WHERE alert_id=706');
    expect(rows[0]).toMatchObject({lane:'investigation',investigation_id:null});
    await f.pool.query('DROP TRIGGER bridge_fail'); f.flags.manual=false;
    const result=await f.alertBridge.dispatch(alert,'manual',f.owner,f.old);
    expect(result.investigationId).toBeTruthy(); expect(f.oldCalls()).toBe(1); f.flags.manual=true;
  });
  it('readonly source API rejects model authority and same-JWT revoked resource', async () => {
    expect((await f.app.inject({method:'POST',url:'/api/alerts/701/investigation',headers:f.headers(),payload:{actor:{userId:1}}})).statusCode).toBe(400);
    await f.pool.query('DELETE FROM instance_permissions WHERE user_id=101 AND instance_id=101');
    expect((await f.app.inject({method:'POST',url:'/api/alerts/701/investigation',headers:f.headers(),payload:{}})).statusCode).toBe(404);
    expect(f.oldCalls()).toBe(1);
  });
  it('unattributed manual unknown is never adopted or explicitly retried under another actor', async () => {
    const alert=f.source(708,'cpu_usage',102), id=await f.insertLegacy('alert_rca','unknown');
    await f.pool.query("UPDATE ai_analysis SET trigger_type='manual',related_id=708,instance_id=102 WHERE id=?",[id]);
    const before=await f.count('workflow_jobs');
    await expect(f.alertBridge.dispatch(alert,'manual',f.owner,f.old)).rejects.toMatchObject({code:'INVESTIGATION_NOT_FOUND'});
    await expect(f.alertBridge.dispatch(alert,'manual',f.owner,f.old,id)).rejects.toMatchObject({code:'INVESTIGATION_NOT_FOUND'});
    expect(await f.count('workflow_jobs')).toBe(before); expect(f.oldCalls()).toBe(1);
  });
  it('automatic admission follows the effective policy in its rotated ledger domain', async () => {
    const admissionPolicy = { maxConcurrent: 3, manualReserved: 0, maxPerResourceConcurrent: 3, maxAutomaticRequestsPerHour: 9,
      maxAutomaticTokensPerDay: 1_000_000, maxTotalTokensPerDay: 1_000_000, maxCostMicrosPerDay: 10_000_000 };
    await f.pool.query("REPLACE INTO system_config (config_key,config_value,value_type) VALUES (?,?,'json')",
      [INVESTIGATION_EFFECTIVE_BUDGET_KEY, JSON.stringify({ schemaVersion: 1, version: 1,
        runtime: { contextWindowTokens: 32768, outputTokens: 4096, summaryOutputTokens: 4096, maxExecutionTokens: 32768 },
        profileLimits: { deadlineMs: 600_000, maxToolCalls: 36, maxProviderAttempts: 8, maxRows: 200, maxBytes: 128_000, maxWindowMs: 3_600_000 },
        admission: { revision: 2, policy: admissionPolicy }, updatedAt: '2026-10-25T00:00:00.000Z' })]);
    try {
      const result = await f.alertBridge.dispatch(f.source(801),'auto',undefined,f.old);
      expect(result.success).toBe(true);
      const [ledger] = await f.pool.query<any[]>('SELECT CAST(domain_key AS CHAR) AS domain,state FROM investigation_budget_ledger WHERE request_id=?', [result.requestId]);
      expect(ledger[0]).toMatchObject({ domain: 'investigation-v1:v2', state: 'reserved' });
      const [domain] = await f.pool.query<any[]>('SELECT policy_snapshot FROM investigation_budget_domains WHERE domain_key=?', ['investigation-v1:v2']);
      expect(typeof domain[0].policy_snapshot === 'string' ? JSON.parse(domain[0].policy_snapshot) : domain[0].policy_snapshot)
        .toEqual({ currency: 'USD', ...admissionPolicy });
    } finally {
      await f.pool.query('DELETE FROM system_config WHERE config_key=?', [INVESTIGATION_EFFECTIVE_BUDGET_KEY]);
    }
  });
});
