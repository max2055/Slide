import assert from 'node:assert/strict';
import { dbConnection } from '../../apps/db-ops-api/src/db-connection.js';
import { EvidenceStore } from '../../apps/db-ops-api/src/evidence/evidence-store.js';
import { EvidenceService } from '../../apps/db-ops-api/src/evidence/evidence-service.js';
import { EvidenceEvaluationService } from '../../apps/db-ops-api/src/evidence/evidence-evaluation.js';
import type { ActorContext } from '../../apps/db-ops-api/src/auth/actor-context.js';
import type { ResourceRef } from '../../apps/db-ops-api/src/resources/types.js';

if (process.env.DB_HOST !== '127.0.0.1' || !/^slide_evidence_test_v[0-9]+$/.test(process.env.DB_NAME ?? '')) throw new Error('ISOLATED_EVIDENCE_DATABASE_REQUIRED');
const mode = process.argv[2];
if (!['seed', 'verify'].includes(mode)) throw new Error('Expected seed or verify');
assert(await dbConnection.initialize());
const pool = dbConnection.getPool()!;
const query = async (sql: string, values: unknown[] = []): Promise<any> => (await pool.execute(sql, values))[0];
try {
  if (mode === 'seed') {
    await query("INSERT INTO users (username, password_hash, status) VALUES ('evidence-qualification', 'login-disabled', 'active')");
    await query("INSERT INTO database_instances (name, db_type, host, port, username, password_encrypted, environment, status) VALUES ('evidence-qualification', 'mysql', '127.0.0.1', 1, 'fixture', 'unused', 'testing', 'inactive')");
    await query("INSERT INTO servers (host, label, os_type, credential_type, credential_encrypted, collection_enabled) VALUES ('evidence-qualification.invalid', 'evidence-qualification', 'linux', 'password', 'unused', 0)");
    await query("INSERT INTO network_devices (name, host, collection_enabled) VALUES ('evidence-qualification', 'evidence-qualification.invalid', 0)");
  }
  const user = (await query("SELECT id FROM users WHERE username = 'evidence-qualification'"))[0];
  const actor: ActorContext = { userId: user.id, username: 'evidence-qualification', roles: ['admin'], permissions: ['*'], instanceScopes: {}, sessionVersion: 1, requestId: 'evidence-qualification' };
  const instance = (await query("SELECT id FROM database_instances WHERE name = 'evidence-qualification'"))[0];
  const server = (await query("SELECT id FROM servers WHERE label = 'evidence-qualification'"))[0];
  const network = (await query("SELECT id FROM network_devices WHERE name = 'evidence-qualification'"))[0];
  const resources: ResourceRef[] = [{ type: 'instance', id: instance.id }, { type: 'server', id: server.id }, { type: 'network_device', id: network.id }];
  const service = new EvidenceService(); const evaluation = new EvidenceEvaluationService(); const store = new EvidenceStore();
  if (mode === 'seed') {
    await query('INSERT INTO metrics_history (instance_id, cpu_usage, memory_usage, disk_usage, connections, qps, tps, slow_queries) VALUES (?, 0, 20, 30, 4, 5, 6, 0)', [instance.id]);
    await query("INSERT INTO server_metrics (server_id, metric_name, metric_value, recorded_at) VALUES (?, 'cpu_usage', 0, NOW())", [server.id]);
    await query("INSERT INTO network_device_observations (device_id, metric_id, metric_value, observed_at, valid_until, quality, source, reason) VALUES (?, 'device_reachability', 0, DATE_SUB(NOW(), INTERVAL 60 SECOND), DATE_SUB(NOW(), INTERVAL 1 SECOND), 'invalid', 'qualification', 'expired_probe')", [network.id]);
    for (const ref of resources) {
      const bundle = await service.getBundle(actor, ref);
      assert(bundle.facts.length > 0, `No real-table evidence for ${ref.type}`);
      assert(bundle.facts.some(item => item.payload.value === 0), 'Zero must remain a real value');
      if (ref.type === 'network_device') {
        assert(bundle.gaps.includes('EVIDENCE_STALE'), 'Collector validity must not be extended');
        assert(bundle.facts.every(item => item.quality === 'invalid'));
      }
      const rule = { id: 'cpu-range', version: 1, metricId: ref.type === 'network_device' ? 'device_reachability' : 'cpu_usage', min: 0, max: 100 };
      await evaluation.updateRules(actor, ref, { expectedVersion: 0, rules: [rule] });
      const result = await evaluation.evaluate(actor, ref);
      assert.equal(result.invariants[0].status, ref.type === 'network_device' ? 'unknown' : 'pass');
      const item = bundle.facts[0];
      await evaluation.recordDecision(actor, ref, { statement: 'Qualification hypothesis, not a runtime fact', status: 'hypothesis', evidenceRefs: [item.id], from: item.observedAt, to: item.observedAt });
      assert.equal(await store.getById({ ...actor, userId: actor.userId + 100000 }, ref, item.id), null);
      await assert.rejects(store.getById({ ...actor, roles: [], permissions: [] }, ref, item.id), /RESOURCE_FORBIDDEN/);
    }
  } else {
    for (const ref of resources) {
      const bundle = await service.getBundle(actor, ref, { from: new Date(Date.now() - 86400_000).toISOString(), to: new Date().toISOString() });
      assert(bundle.facts.length > 0, 'Evidence must survive a fresh process');
      const decisions = await evaluation.decisions(actor, ref, 10);
      assert.equal(decisions.items.length, 1);
      assert.equal(decisions.items[0].status, 'hypothesis');
      assert.equal((await evaluation.rules(actor, ref)).version, 1);
    }
  }
  console.log(JSON.stringify({ mode, database: process.env.DB_NAME, resources: resources.map(ref => ref.type), status: 'passed' }));
} finally { await dbConnection.close(); }
