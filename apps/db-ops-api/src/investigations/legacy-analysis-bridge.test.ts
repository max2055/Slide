import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { bridgeTestFixture } from './bridge-test-fixture.js';

describe('T08 legacy read-only bridge / formal MySQL + JWT + HTTP', () => {
  let f: Awaited<ReturnType<typeof bridgeTestFixture>>;
  beforeAll(async () => { f = await bridgeTestFixture(); }, 120_000);
  afterAll(async () => { await f?.close(); }, 30_000);
  it('50 simultaneous first views create one archived link, no request/job/message/Run/ledger', async () => {
    const id = await f.insertLegacy('topsql_analysis');
    const links = await Promise.all(Array.from({ length: 50 }, () => f.app.inject({ method:'POST',url:`/api/ai/analysis/${id}/investigation`,headers:f.headers() })));
    expect(links.map(r => r.statusCode)).toEqual(Array(50).fill(200));
    const link = links[0].json();
    expect(new Set(links.map(r => r.json().id)).size).toBe(1);
    const view = await f.app.inject({ url:`/api/investigations/${link.id}`, headers:f.headers() });
    expect(view.statusCode).toBe(200); expect(view.json().lifecycle).toBe('archived');
    expect(view.json().legacyAnalysis).toMatchObject({analysisId:id,legacy:true,readOnly:true,view:{kind:'legacy',summary:'原历史结果，未验证根因',rootCauseVerification:{status:'unverified'}}});
    for (const table of ['investigation_requests','workflow_jobs','chat_messages','agent_runs','investigation_budget_ledger','investigation_results']) expect(await f.count(table)).toBe(0);
    expect(await f.count('investigation_legacy_analysis_links')).toBe(1);
    const append = await f.app.inject({ method:'POST',url:`/api/investigations/${link.id}/runs`,headers:{...f.headers(),'idempotency-key':'never-run'},payload:{expectedVersion:1,message:'补跑'} });
    expect(append.statusCode).toBe(403);
    const patch = await f.app.inject({ method:'PATCH',url:`/api/investigations/${link.id}`,headers:f.headers(),payload:{expectedVersion:1,lifecycle:'open'} });
    expect(patch.statusCode).toBe(403); expect(f.oldCalls()).toBe(0);
  });
  it('automatic historical results have a unique source link, second viewer cannot append', async () => {
    const id = await f.insertLegacy(); const a = await f.legacy.link(f.owner,id), b = await f.legacy.link(f.other,id);
    expect(a.id).toBe(b.id); expect((await f.legacy.read(f.other,b.id))?.view.rootCauseVerification.status).toBe('unverified');
    await expect(f.bridge.admit(f.other,{investigationId:b.id,expectedVersion:1,message:'try',idempotencyKey:'viewer'})).rejects.toMatchObject({code:'INVESTIGATION_OPERATION_FORBIDDEN'});
  });
  it('unknown remains unknown; old view never schedules a retry', async () => {
    const id = await f.insertLegacy('fault_diagnosis','unknown'); const link = await f.legacy.link(f.owner,id);
    expect((await f.legacy.read(f.owner,link.id))?.status).toBe('unknown'); expect(await f.count('workflow_jobs')).toBe(0);
  });
  it('unattributed manual legacy cannot be adopted by another principal', async () => {
    const id = await f.insertLegacy(); await f.pool.query("UPDATE ai_analysis SET trigger_type='manual' WHERE id=?",[id]);
    await expect(f.legacy.link(f.owner,id)).rejects.toMatchObject({code:'INVESTIGATION_NOT_FOUND'});
  });
  it('running historical analysis is not linked or replayed', async () => {
    const id = await f.insertLegacy('fault_diagnosis','running');
    await expect(f.legacy.link(f.owner,id)).rejects.toMatchObject({code:'INVESTIGATION_ACTIVE_REQUEST'});
  });
  it('same JWT SQL resource revocation denies source and Workspace, no new link', async () => {
    const id = await f.insertLegacy('sql_audit'); const link = await f.legacy.link(f.owner,id);
    const before = await f.count('investigation_legacy_analysis_links');
    await f.pool.query('DELETE FROM instance_permissions WHERE user_id=101 AND instance_id=101');
    for (const [method,url] of [['POST',`/api/ai/analysis/${id}/investigation`],['GET',`/api/investigations/${link.id}`]] as const) {
      const r = await f.app.inject({method,url,headers:f.headers()}); expect(r.statusCode).toBe(404);
    }
    expect(await f.count('investigation_legacy_analysis_links')).toBe(before);
    await f.pool.query("INSERT INTO instance_permissions (user_id,instance_id,access_level) VALUES (101,101,'read-only')");
  });
  it('live ai:view revocation blocks cached source reads, default flag disables linking', async () => {
    const id = await f.insertLegacy();
    await f.pool.query("DELETE rp FROM role_permissions rp JOIN permissions p ON p.id=rp.permission_id WHERE rp.role_id=101 AND p.code='ai:view'");
    expect((await f.app.inject({method:'POST',url:`/api/ai/analysis/${id}/investigation`,headers:f.headers()})).statusCode).toBe(404);
    await f.pool.query("INSERT INTO role_permissions (role_id,permission_id) SELECT 101,id FROM permissions WHERE code='ai:view'");
    f.flags.legacy=false;
    expect((await f.app.inject({method:'POST',url:`/api/ai/analysis/${id}/investigation`,headers:f.headers()})).statusCode).toBe(503);
  });
});
