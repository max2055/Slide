/** T12 qualification only: formal SQL/HTTP/Worker, synthetic readonly targets.
 * Never imported by production. A report records measured limits, not deployment. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { cpus, totalmem } from 'node:os';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { startInvestigationServer } from '../../frontend/e2e/fixtures/investigation-server.js';
import { INVESTIGATION_PROFILES } from '../../apps/db-ops-api/src/investigations/profiles.js';
import { validateOperationalEvent } from '../../apps/db-ops-api/src/investigations/contracts.js';

const root = resolve(import.meta.dirname, '../..');
const output = resolve(process.env.T12_OUTPUT_DIR ?? resolve(root, '.qualification/t12'));
const report: any = { schemaVersion: 1, scopeVersion: 'v1.2.31', startedAt: new Date().toISOString(),
  sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  environment: { node: process.version, cpus: cpus().length, memoryBytes: totalmem(), mysql: 'isolated 8.4',
    provider: 'controlled-fixture', targets: 'synthetic; no SSH/SNMP/production changes', externalProviderRequests: 0 },
  checks: [], proposedSlo: { listP95Ms: 500, admissionP95Ms: 1000, queueP95Ms: 5000, wsRecoveryP95Ms: 3000, cancelIntentP95Ms: 2000 } };
await mkdir(output, { recursive: true });
process.chdir(resolve(root, 'frontend')); // the existing Vite/SQL fixture owns its CWD
let env: Awaited<ReturnType<typeof startInvestigationServer>> | undefined;
const count = async (sql: string, values: unknown[] = []) => Number((await env!.pool.query(sql, values))[0][0].n);
const stats = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return { samples: values.length, minMs: sorted[0], p50Ms: sorted[Math.ceil(sorted.length * .5) - 1],
    p95Ms: sorted[Math.ceil(sorted.length * .95) - 1], maxMs: sorted.at(-1) };
};
async function check(name: string, work: () => Promise<unknown>) {
  const start = performance.now();
  try { const evidence = await work(); report.checks.push({ name, status: 'passed', durationMs: performance.now() - start, evidence }); }
  catch (error) { report.checks.push({ name, status: 'failed', durationMs: performance.now() - start,
    error: error instanceof Error ? error.message : String(error) }); throw error; }
  finally { await writeFile(resolve(output, 'rollout.json'), JSON.stringify(report, null, 2)); }
}
async function waitFor(work: () => Promise<boolean>, seconds = 30) {
  const deadline = Date.now() + seconds * 1000;
  while (!await work()) { assert(Date.now() < deadline, 'T12_DURABLE_COMPLETION_TIMEOUT'); await new Promise(r => setTimeout(r, 50)); }
}

try {
  env = await startInvestigationServer({ databaseAlertPilot: true, systemPilot: true });
  const [database] = await env.pool.query('SELECT DATABASE() AS name, VERSION() AS version');
  assert.match(database[0].name, /^t06_workspace_\d+_[a-f0-9]+$/);
  report.environment.mysqlVersion = database[0].version;
  await check('additive migration and readonly ceilings', async () => {
    // Fixture runs the full formal catalog twice before any business traffic.
    const [migrations] = await env!.pool.query('SELECT migration_id,checksum,status FROM app_schema_migrations ORDER BY migration_id');
    assert(migrations.every((m: any) => ['completed', 'baselined'].includes(m.status)));
    assert(migrations.filter((m: any) => /^11[2-9]_|^120_/.test(m.migration_id)).every((m: any) => m.status === 'completed'));
    for (const profile of Object.values(INVESTIGATION_PROFILES)) {
      assert.equal(profile.readonly, true);
      assert(!profile.toolAllowlist.some(name => /execute_sql|ssh|shell|write|repair|delete/.test(name)));
    }
    return { formalCatalogAppliedTwice: true, migrations, profiles: Object.values(INVESTIGATION_PROFILES).map(p => ({ id: p.id,
      version: p.version, prompt: p.prompt, toolAllowlist: p.toolAllowlist, hash: createHash('sha256').update(JSON.stringify(p)).digest('hex') })) };
  });

  await check('10000 concurrent duplicate events: single original, admission, Run and reservation', async () => {
    const failure = { component: 'api' as const, sourceEventId: randomUUID(), occurredAt: new Date().toISOString(),
      correlationId: randomUUID(), stableErrorCode: 'T12_STORM', callsite: 't12:storm', origin: 'user_operation' as const, httpStatus: 503 };
    const original = await env!.system!.bridge.record(failure);
    const receipt = await env!.system!.bridge.deliver(original.jobId);
    assert(receipt.investigationId);
    const timings: number[] = []; let duplicates = 0;
    // Bounded concurrency: same logical incident, ten thousand at-least-once deliveries.
    let next = 0;
    const deliveries = await Promise.allSettled(Array.from({ length: 8 }, async () => {
      while (next++ < 10000) {
        const start = performance.now();
        const recorded = await env!.system!.bridge.record(failure);
        assert.equal(recorded.jobId, original.jobId); assert(recorded.duplicate);
        const repeated = await env!.system!.bridge.deliver(recorded.jobId);
        assert.equal(repeated.investigationId, receipt.investigationId); assert.equal(repeated.eventId, receipt.eventId);
        assert(repeated.duplicate); duplicates++; timings.push(performance.now() - start);
      }
    }));
    const rejected = deliveries.find(result => result.status === 'rejected');
    if (rejected?.status === 'rejected') throw rejected.reason;
    assert.equal(duplicates, 10000);
    await waitFor(async () => await count('SELECT COUNT(*) AS n FROM investigation_results WHERE investigation_id=?', [receipt.investigationId]) === 1);
    const requests = await count('SELECT COUNT(*) AS n FROM investigation_requests WHERE investigation_id=?', [receipt.investigationId]);
    const runs = await count('SELECT COUNT(*) AS n FROM agent_runs WHERE session_id=(SELECT session_id FROM investigations WHERE id=?)', [receipt.investigationId]);
    const reservations = await count('SELECT COUNT(*) AS n FROM investigation_budget_ledger WHERE request_id=?', [receipt.requestId]);
    assert.equal(requests, 1); assert.equal(runs, 1); assert.equal(reservations, 1);
    return { original, receipt, duplicates, concurrency: 8, requests, runs, reservations, delivery: stats(timings) };
  });

  await check('cohort and old/new flags: accepted owner survives rollback, new alert suppressed', async () => {
    const ids: number[] = [];
    for (const metric of ['t12_cohort', 't12_outside']) {
      const [row] = await env!.pool.query("INSERT INTO alerts(instance_id,target_type,alert_type,level,title,message,metric_name) VALUES(101,'instance','performance','critical',?,'frozen readonly CPU',?)", [metric, metric]);
      ids.push(row.insertId);
    }
    const admitted: any = await env!.rca.analyzeAlert(ids[0], 'auto');
    assert(admitted.investigationId);
    env!.bridgeFlags.opsAuto = false; env!.bridgeFlags.manual = false;
    const repeated: any = await env!.rca.analyzeAlert(ids[0], 'auto');
    assert.equal(repeated.investigationId, admitted.investigationId);
    assert.equal(await count('SELECT COUNT(*) AS n FROM ai_analysis WHERE related_id=?', [ids[0]]), 0);
    await waitFor(async () => await count('SELECT COUNT(*) AS n FROM investigation_results WHERE investigation_id=?', [admitted.investigationId]) === 1);
    // Flag off is confirmed at the bridge port, without invoking the legacy model lane.
    const [outside] = await env!.pool.query('SELECT * FROM alerts WHERE id=?', [ids[1]]);
    const providerCallsBefore = env!.counts().providerCalls;
    let legacyAdmissions = 0;
    const bridgeResult = await env!.alertBridge.dispatch(outside[0], 'auto', undefined, async c => {
      legacyAdmissions++;
      const [row]: any = await c.query("INSERT INTO ai_analysis(analysis_type,target_type,instance_id,related_id,trigger_type,status) VALUES('alert_rca','instance',101,?,'auto','pending')", [ids[1]]);
      return { success: true, analysisId: row.insertId, status: 'pending' };
    });
    // Disabling automatic analysis suppresses the alert; it never falls back
    // to the legacy automatic lane. Both lanes and paid providers stay at 0.
    assert.equal(bridgeResult.success, false);
    assert.equal(bridgeResult.status, 'suppressed');
    assert.equal(bridgeResult.error, 'AUTO_ANALYSIS_LANE_DISABLED');
    assert.equal(bridgeResult.analysisId, undefined);
    assert.equal(legacyAdmissions, 0);
    assert.equal(await count('SELECT COUNT(*) AS n FROM ai_analysis WHERE related_id=?', [ids[1]]), 0);
    assert.equal(await count('SELECT COUNT(*) AS n FROM investigation_alert_owners WHERE alert_id=?', [ids[1]]), 0);
    const outsidePaidRequests = env!.counts().providerCalls - providerCallsBefore;
    assert.equal(outsidePaidRequests, 0);
    env!.bridgeFlags.opsAuto = true; env!.bridgeFlags.manual = true;
    const restored: any = await env!.rca.analyzeAlert(ids[0], 'auto');
    assert.equal(restored.investigationId, admitted.investigationId);
    await waitFor(async () => await count('SELECT COUNT(*) AS n FROM investigation_results WHERE investigation_id=?', [admitted.investigationId]) === 1);
    const paidOwnerCount = await count('SELECT COUNT(*) AS n FROM investigation_alert_owners WHERE alert_id=?', [ids[0]]);
    assert.equal(paidOwnerCount, 1);
    return { cohort: [101], flagHistory: ['true', 'false', 'true'], investigationId: admitted.investigationId,
      paidOwnerCount, legacyAdmissions, outsidePaidRequests, outsideLegacyAnalysis: 0,
      suppression: { status: bridgeResult.status, error: bridgeResult.error, analysisId: bridgeResult.analysisId } };
  });

  await check('bounded evidence retention preserves hashes and results', async () => {
    await waitFor(async () => await count("SELECT COUNT(*) AS n FROM workflow_jobs WHERE job_type='investigation.execute' AND state IN ('pending','running')") === 0);
    const [evidence] = await env!.pool.query('SELECT id,content_hash FROM investigation_evidence ORDER BY id');
    assert(evidence.length > 0);
    const resultCount = await count('SELECT COUNT(*) AS n FROM investigation_results');
    await env!.pool.query('UPDATE investigation_evidence SET expires_at=DATE_SUB(NOW(3),INTERVAL 8 DAY)');
    const store = env!.bridge.observationServices().evidence;
    const first = await store.purgeExpired(1); assert.equal(first, 1);
    const rest = await store.purgeExpired(200); assert.equal(first + rest, evidence.length);
    const [after] = await env!.pool.query('SELECT id,content_hash FROM investigation_evidence ORDER BY id');
    assert.deepEqual(after, evidence);
    assert.equal(await count('SELECT COUNT(*) AS n FROM investigation_evidence WHERE raw_json IS NOT NULL'), 0);
    assert.equal(await count('SELECT COUNT(*) AS n FROM investigation_results'), resultCount);
    return { firstBatch: first, remainingBatch: rest, resultCount, metadata: after, sensitiveBodiesRemoved: true };
  });

  await check('10000 investigations / 100000 events capacity and list latency', async () => {
    const created = await env!.bridge.create(env!.owner, { title: 'capacity template', goal: 'readonly capacity', profileId: 'ops', profileVersion: 1,
      resources: [{ type: 'instance', id: 101, role: 'primary' }], idempotencyKey: randomUUID() });
    // SQL fixture volume is explicitly synthetic; all measured reads use formal authorization.
    for (let batch = 0; batch < 10; batch++) {
      const pairs = Array.from({ length: 1000 }, () => ({ id: randomUUID(), session: `t12-capacity-${randomUUID()}` }));
      await env!.pool.query('INSERT INTO chat_sessions(session_id,user_id,title) VALUES ?', [pairs.map(p => [p.session, 101, 'capacity fixture'])]);
      const [template] = await env!.pool.query('SELECT * FROM investigations WHERE id=?', [created.investigation.id]);
      const t = template[0];
      await env!.pool.query('INSERT INTO investigations(id,title,goal,profile_id,profile_version,session_id,owner_kind,owner_id,scope_version) VALUES ?',
        [pairs.map(p => [p.id, 'capacity fixture', t.goal, t.profile_id, t.profile_version, p.session, 'user', 101, t.scope_version])]);
      await env!.pool.query("INSERT INTO investigation_resources(investigation_id,resource_type,resource_id,role) VALUES ?", [pairs.map(p => [p.id, 'instance', 101, 'primary'])]);
    }
    for (let batch = 0; batch < 100; batch++) {
      await env!.pool.query(`INSERT INTO operational_events(id,source,source_event_id,command_hash,envelope,classification,occurred_at,received_at,fingerprint,trigger_key)
        VALUES ?`, [Array.from({ length: 1000 }, () => {
          const id = randomUUID(), now = new Date().toISOString();
          const event = { schemaVersion: 1, id, source: 't12.capacity', sourceEventId: id, kind: 'failure',
            subject: { kind: 'resource', resource: { type: 'instance', id: 101 } }, occurredAt: now, receivedAt: now,
            severity: 'critical', summary: 'Synthetic frozen CPU observation; no diagnosis established', origin: 'collector' };
          assert(validateOperationalEvent(event).ok);
          return [id, event.source, id, createHash('sha256').update(JSON.stringify(event)).digest('hex'), JSON.stringify(event),
            JSON.stringify({ stableErrorCode: 'T12_CAPACITY', callsite: 't12:capacity' }), new Date(now), new Date(now), 'c'.repeat(64), 'd'.repeat(64)];
        })]);
    }
    const headers = { authorization: `Bearer ${env!.token()}` };
    const latency: number[] = []; let total = 0;
    for (let n = 0; n < 3; n++) {
      const start = performance.now();
      const response = await fetch(`${env!.apiUrl}/api/investigations?limit=20`, { headers });
      assert.equal(response.status, 200); const body: any = await response.json();
      assert.equal(body.items.length, 20); assert(body.authorizedCounts.total >= 10000); total = body.authorizedCounts.total;
      latency.push(performance.now() - start);
    }
    const measured = stats(latency);
    return { seededInvestigations: 10000, seededEvents: 100000, visibleTotal: total, list: measured,
      proposedListSloMet: measured.p95Ms < 500, sloQualification: 'three local samples; not production SLO proof',
      rawFixtureEventsAdmitted: false };
  });

  await check('trace and usage instrument inventory', async () => {
    const [runs] = await env!.pool.query(`SELECT i.id AS investigationId,r.id AS requestId,a.id AS runId,r.job_id AS jobId,
      r.actor_id AS actorId,i.scope_version AS scopeVersion,i.profile_version AS profileVersion,a.state,
      l.state AS billingState,l.usage_snapshot AS usageSnapshot FROM investigation_requests r JOIN investigations i ON i.id=r.investigation_id
      LEFT JOIN agent_runs a ON a.session_id=i.session_id AND a.message_id=r.message_id
      LEFT JOIN investigation_budget_ledger l ON l.request_id=r.id ORDER BY r.created_at`);
    const [events] = await env!.pool.query("SELECT disposition,suppression_reason,COUNT(*) AS n FROM operational_events WHERE source <> 't12.capacity' GROUP BY disposition,suppression_reason");
    assert(runs.every((r: any) => r.investigationId && r.requestId && r.jobId && r.scopeVersion && r.profileVersion));
    assert.deepEqual(env!.workerErrors, []); assert.deepEqual(env!.observationErrors, []);
    return { runs, events, fixtureCounters: env!.counts(), providerInvoice: 'unavailable',
      unknownUsageCount: runs.filter((r: any) => r.billingState === 'unknown' && !r.usageSnapshot).length };
  });
  report.status = 'passed';
} catch (error) { report.status = 'failed'; process.exitCode = 1; console.error(error instanceof Error ? error.message : error); }
finally {
  if (env) await env.close();
  report.finishedAt = new Date().toISOString();
  await writeFile(resolve(output, 'rollout.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ status: report.status, checks: report.checks.map((c: any) => ({ name: c.name, status: c.status })) }));
}
