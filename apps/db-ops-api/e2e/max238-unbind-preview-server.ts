/** Isolated read-only preview fixture. Binding is a seeded pending snapshot, not a collection or first binding. */
import Fastify from 'fastify';
import mysql from 'mysql2/promise';
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { dbConnection } from '../src/db-connection.js';
import { actorContextService, type ActorContext } from '../src/auth/actor-context.js';
import { MigrationRunner } from '../src/migrations/runner.js';
import type { MigrationPool } from '../src/migrations/types.js';
import { createOwnedDatabase } from '../src/testing/owned-fixture.js';
import { createConfigurationRegistry } from '../src/metrics/config/registry.js';
import { createAssetCollectorAccess } from '../src/metrics/config/access.js';
import { MetricConfigurationService } from '../src/metrics/config/service.js';
import { createTrialStore, registerMetricConfigurationRoutes } from '../src/metrics/config/routes.js';
import { configurationReader } from '../src/metrics/config/status-store.js';
import { trialAccess } from '../src/metrics/config/access.js';
import { policyService } from '../src/metrics/policy/service.js';
import { registerMetricPolicyRoutes } from '../src/metrics/policy/routes.js';
import { MySqlTemplateRepository } from '../src/metrics/templates/mysql-repository.js';
import { MetricTemplateService } from '../src/metrics/templates/service.js';
import { TemplateBindingService } from '../src/metrics/templates/binding-service.js';
import { registerMetricTemplateRoutes } from '../src/metrics/templates/routes.js';
import { encodeTemplatePendingPayload } from '../src/metrics/bindings/persistence-codec.js';

const port = Number(process.env.MAX238_TEST_MYSQL_PORT);
const apiPort = Number(process.env.MAX238_API_PORT);
const nonce = process.env.MAX238_E2E_NONCE;
if (!port || port === 3306 || !apiPort || !nonce) throw new Error('fixture requires its isolated port and recorded nonce');
const schemaNonce = createHash('sha256').update(nonce).digest('hex').slice(0, 24);
const root = mysql.createPool({ host: '127.0.0.1', port, user: 'root', password: '' });
const owned = await createOwnedDatabase(root, { nonce: schemaNonce, purpose: 'preview', handleDir: join(process.cwd(), '.max238-handles') });
const pool = mysql.createPool({ host: '127.0.0.1', port, user: 'root', password: '', database: owned.database, connectionLimit: 12, timezone: 'Z' });
await new MigrationRunner(pool as unknown as MigrationPool).run();
process.env.DB_HOST = '127.0.0.1'; process.env.DB_PORT = String(port); process.env.DB_USER = 'root';
process.env.DB_PASSWORD = ''; process.env.DB_NAME = owned.database; process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex');
if (!await dbConnection.initialize()) throw new Error('fixture platform database unavailable');
await pool.execute('UPDATE users SET session_version = 1 WHERE id = 1');
await pool.execute("INSERT IGNORE INTO roles (id, name) VALUES (1, 'admin')");
await pool.execute('INSERT IGNORE INTO user_roles (user_id, role_id) VALUES (1, 1)');
const now = new Date().toISOString();
await pool.execute('INSERT INTO metric_policy_groups (id, payload) VALUES (?, ?)',
  ['preview-group', JSON.stringify({ id: 'preview-group', revision: 1, policy_revision: 1, overrides: {} })]);
await pool.execute(`INSERT INTO database_instances
  (id, name, environment, db_type, db_version, host, port, username, password_encrypted, database_name, status,
   lifecycle_state, max_connections, connection_timeout_ms, created_by, created_at, updated_at)
  VALUES (1, 'preview-fixture', 'testing', 'mysql', '8.4', '127.0.0.1', ?, 'unused', 'unused', 'unused', 'active',
    'available', 10, 5000, 1, ?, ?)`, [port, now.replace('T', ' ').replace('Z', ''), now.replace('T', ' ').replace('Z', '')]);
const actor = await actorContextService.loadActiveActor(1, 1, 'preview-fixture');
const registry = createConfigurationRegistry();
const repository = new MySqlTemplateRepository(pool as never);
const templates = new MetricTemplateService(repository, registry);
const release = registry.list().map(entry => entry.package).find(pkg => pkg.id === 'mysql-representative' && pkg.version === '1.0.0')!;
const packagePin = { id: release.id, version: release.version, digest: release.digest };
const pins = [];
for (const name of ['preview-a', 'preview-b']) {
  const template = await templates.create(actor, { name });
  const selected = await templates.selectMetric(actor, template.template_id,
    { package: packagePin, metric: { id: 'mysql.processlist.count', semantic_version: '1.0.0' } });
  const draft = await repository.getDraft(template.template_id);
  const aggregate = structuredClone(draft!.aggregate);
  aggregate.items = [{ item_id: selected.item.item_id, version: selected.item.version }];
  aggregate.parameters = { schema: { sample_batch: { type: 'integer', min: 1, max: 1000 } }, defaults: { sample_batch: 10 } };
  await repository.updateDraft(template.template_id, draft!.revision, { aggregate, updated_by: 1, updated_at: new Date().toISOString() });
  const next = await repository.getDraft(template.template_id);
  const published = await templates.publish(actor, template.template_id,
    { expected_draft_revision: next!.revision, expected_revision: template.revision });
  const record = await repository.getTemplate(template.template_id);
  await repository.updateTemplate(template.template_id, record!.revision, { status: 'active', updated_at: new Date().toISOString() });
  const version = await repository.getVersion(template.template_id, published.version);
  pins.push({ template_id: template.template_id, version: published.version, content_hash: version!.content_hash });
}
pins.sort((a, b) => a.template_id.localeCompare(b.template_id));
const identity = `sha256:${'a'.repeat(64)}` as const;
const settings = { enabled: false, interval_ms: 60000, timeout_ms: 5000, stale_after_ms: 120000,
  max_counter_gap_ms: 300000, max_rows: 100, max_concurrency: 1, max_series_per_resource: 100 };
// This is explicitly a controlled snapshot: no target, probe, trial, samples or applied state.
const plan = { kind: 'template_collection_plan', internal: true, persisted: false, applied: false, executable: false,
  identity, revision: 0, resource: { type: 'instance', id: '1' }, settings, parameters: [], triggers: [], releases: [], excluded: [],
  budget: { estimate: true, request_unit: 'logical_reads', estimated_series_upper_bound: 0, max_series_per_resource: 100, requests_per_hour_estimate: 0 } };
const binding = { resource: { type: 'instance', id: 1 }, package: null, group_id: 'preview-group',
  overrides: { enabled: 'disable', metrics: { 'mysql.processlist.count@1.0.0': 'disable' },
    template_parameters: { [pins[0].template_id]: { sample_batch: 25 } } }, revision: 1, template_pins: pins };
const payload = encodeTemplatePendingPayload({ binding: binding as never, base_revision: 0, target_revision: 1,
  resolution_identity: identity, plan: plan as never, decided_at: now, operation_key: `instance:1#1@${identity}`,
  applied_revision: null, previous_resolution_identity: null, previous_effective: null, published_at: now });
await pool.execute('INSERT INTO metric_policy_bindings (resource_key, group_id, payload, capabilities) VALUES (?, ?, ?, ?)',
  ['instance:1', 'preview-group', payload, '[]']);
// Existing history is seeded only to detect accidental deletion, never claimed as a collected sample.
await pool.execute(`INSERT INTO metric_observations (id, series_hash, stage, observed_at, stored_at, valid_value, payload, payload_hash)
  VALUES (?, ?, 'normalized', NOW(3), NOW(3), 0, ?, ?)`,
[`sha256:${'b'.repeat(64)}`, 'b'.repeat(64), JSON.stringify({ fixture_only: true }), 'c'.repeat(64)]);
await pool.execute("INSERT INTO alert_events (event_id, title, status, severity, instance_id) VALUES ('preview-fixture-event', 'fixture history', 'open', 'warning', 1)");
const service = new TemplateBindingService({ pool: () => pool, registry, access: createAssetCollectorAccess(),
  reload: current => actorContextService.revalidateActor(current, current.requestId),
  reloadOn: (current, executor) => actorContextService.revalidateActorOn(executor, current, current.requestId),
  reloadOnLocked: (current, executor) => actorContextService.revalidateActorOn(executor, current, current.requestId, true) });
const app = Fastify();
const auth = async (request: unknown) => { (request as { user: ActorContext }).user = actor; };
app.get('/__health', async () => ({ ok: true }));
app.get('/__test/handle', async () => ({ container: process.env.MAX238_E2E_CONTAINER, nonce, pid: process.pid, cwd: process.cwd(), port: apiPort }));
app.get('/__test/snapshot', async () => {
  const tables = ['metric_policy_bindings', 'metric_policy_audit', 'workflow_jobs', 'metric_observations', 'alert_events', 'operational_events'];
  const result: Record<string, unknown> = {};
  for (const table of tables) result[table] = (await pool.query(`SELECT * FROM \`${table}\``))[0];
  return result;
});
let held: Awaited<ReturnType<typeof pool.getConnection>> | null = null;
let delay = false, delayed = false, resume: (() => void) | null = null;
app.get('/__test/pins', async () => ({ pins, identity }));
app.post('/__test/hold', async () => {
  if (held) throw new Error('already held');
  held = await pool.getConnection(); await held.beginTransaction();
  await held.query('SELECT id FROM metric_policy_lock WHERE id = 1 FOR UPDATE');
  return { held: true };
});
app.post('/__test/hold-version', async () => {
  if (held) throw new Error('already held');
  held = await pool.getConnection(); await held.beginTransaction();
  await held.execute('SELECT template_id FROM metric_template_versions WHERE template_id = ? AND version = ? FOR UPDATE',
    [pins[0].template_id, pins[0].version]);
  return { held: true };
});
app.get('/__test/waiters/:kind', async request => {
  const kind = (request.params as { kind: string }).kind;
  const table = kind === 'policy' ? 'metric_policy_lock' : kind === 'version' ? 'metric_template_versions' : kind === 'user' ? 'users' : '';
  if (!table) throw new Error('invalid wait kind');
  const [rows] = await pool.query<mysql.RowDataPacket[]>(`SELECT COUNT(*) AS count FROM performance_schema.data_lock_waits w
    JOIN performance_schema.data_locks l ON l.ENGINE_LOCK_ID = w.REQUESTING_ENGINE_LOCK_ID
    WHERE l.OBJECT_SCHEMA = ? AND l.OBJECT_NAME = ?`, [owned.database, table]);
  return { count: Number(rows[0].count) };
});
app.post('/__test/release', async () => {
  if (!held) throw new Error('no lock held');
  await held.commit(); held.release(); held = null; return { held: false };
});
app.post('/__test/session/:version', async request => {
  const value = Number((request.params as { version: string }).version);
  if (value !== 1 && value !== 2) throw new Error('invalid test version');
  await pool.execute('UPDATE users SET session_version = ? WHERE id = 1', [value]); return { version: value };
});
app.post('/__test/revision/:revision', async request => {
  const revision = Number((request.params as { revision: string }).revision);
  if (revision !== 1 && revision !== 2) throw new Error('invalid test revision');
  const snapshot = JSON.parse(payload);
  snapshot.binding.revision = revision;
  snapshot.template_resolution.pending.base_revision = revision - 1;
  snapshot.template_resolution.pending.target_revision = revision;
  snapshot.template_resolution.pending.plan.revision = revision - 1;
  await pool.execute('UPDATE metric_policy_bindings SET payload = ? WHERE resource_key = ?', [JSON.stringify(snapshot), 'instance:1']);
  return { revision };
});
app.post('/__test/version/:mode', async request => {
  const mode = (request.params as { mode: string }).mode;
  if (mode === 'retire') await pool.execute("UPDATE metric_template_versions SET status = 'retired', retired_at = ? WHERE template_id = ? AND version = ?", [new Date().toISOString(), pins[0].template_id, pins[0].version]);
  else if (mode === 'remove') await pool.execute('DELETE FROM metric_template_versions WHERE template_id = ? AND version = ?', [pins[0].template_id, pins[0].version]);
  else throw new Error('invalid version mode');
  return { mode };
});
app.post('/__test/delay', async () => { delay = true; delayed = false; return { delay }; });
app.get('/__test/delay', async () => ({ delayed }));
app.post('/__test/resume', async () => { if (!resume) throw new Error('no delayed response'); resume(); return { resumed: true }; });
app.addHook('onSend', async (request, _reply, response) => {
  if (delay && request.url.endsWith('/unbind-preview')) {
    delay = false; delayed = true;
    await new Promise<void>(resolve => { resume = resolve; });
    resume = null;
  }
  return response;
});
app.post('/__test/shutdown', async () => { setTimeout(() => { void shutdown(); }, 30); return { stopping: true }; });
const config = new MetricConfigurationService(policyService, registry, createTrialStore(() => pool, registry), trialAccess,
  configurationReader(() => pool), async seed => seed);
await registerMetricConfigurationRoutes(app, auth, config);
await registerMetricPolicyRoutes(app, auth, policyService, async seed => seed);
await registerMetricTemplateRoutes(app, auth, service);
await app.listen({ host: '127.0.0.1', port: apiPort });
async function shutdown() {
  try {
    if (held || resume) throw new Error('fixture control remains active');
    await app.close(); await dbConnection.close(); await pool.end(); await owned.drop(); await root.end();
    execFileSync('bash', [process.env.MAX238_HARNESS_PATH!, '--cleanup', process.env.MAX238_E2E_CONTAINER!, nonce!], { stdio: 'inherit', timeout: 60_000 });
  } catch (error) { console.error('Fixture cleanup failed; retain exact handles', error); process.exit(1); }
  process.exit(0);
}
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
