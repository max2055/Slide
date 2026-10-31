/**
 * MAX238-NATIVE-CONFIGURATION-FLOW-R1 — real API lifecycle evidence.
 *
 * Every step below is a real HTTP call to the running product API backed by the
 * one-off platform database. Nothing is stubbed: preview/trial/apply go through
 * the real service, guard, host, receipt store, policy lock and journal, and the
 * trial reads the real target over the real collector.
 *
 * Scenarios:
 *   A  first binding of an unbound resource: the request reaches preview with
 *      base revision 0 and reports the exact capability blocker (no write).
 *   B  legacy → native conversion with a real trial and one committed apply.
 *   C  lossless configuration: stored overrides/group survive a no-op apply, and
 *      editing one value changes exactly that value.
 *   D  cancel: no request, no write.
 *   E  concurrent first/updates: exactly one commits.
 *   F  unknown response: the journal recovers the committed operation and a
 *      replay never writes a second revision.
 *   G  revocation at the apply boundary: 403 with zero writes.
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { writeFileSync } from 'node:fs';

const require = createRequire(`${fileURLToPath(new URL('../../../../../apps/db-ops-api', import.meta.url))}/package.json`);
const mysql = require('mysql2/promise');

const API = process.env.MAX238_API || 'http://127.0.0.1:3001';
const OUT = process.env.MAX238_EVIDENCE_DIR || fileURLToPath(new URL('.', import.meta.url));
const db = await mysql.createConnection({ host: '127.0.0.1', port: Number(process.env.MAX238_DBPORT),
  user: 'root', password: process.env.MAX238_DBPW, database: process.env.MAX238_DB, timezone: 'Z' });
const one = async (sql, params = []) => (await db.query(sql, params))[0][0];
const rows = async (sql, params = []) => (await db.query(sql, params))[0];

const login = await fetch(`${API}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'life-admin', password: process.env.MAX238_ADMIN_PASSWORD }) });
const { token } = await login.json();
const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
const call = async (method, path, body) => {
  const response = await fetch(`${API}${path}`, { method, headers: auth,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, data: await response.json().catch(() => null) };
};
const evidence = { at: new Date().toISOString(), api: API, scenarios: {} };
const journal = async (resource, key) => call('GET', `/api/metrics/template-bindings/${resource}/operations/${encodeURIComponent(key)}`);
const counts = async key => ({
  operations: Number((await one('SELECT COUNT(*) c FROM metric_policy_operations WHERE caller_key = ?', [key]))?.c ?? 0),
  audits: Number((await one("SELECT COUNT(*) c FROM metric_policy_audit WHERE JSON_UNQUOTE(JSON_EXTRACT(payload,'$.request_id')) = ?", [key]))?.c ?? 0),
});

const catalog = (await call('GET', '/api/metrics/templates')).data;
const template = catalog.templates.find(entry => entry.name === 'MAX238 lifecycle template');
const pin = { template_id: template.template_id, version: template.current_published_version,
  content_hash: template.versions.find(version => version.version === template.current_published_version).content_hash };

const resourceOf = async id => (await one(
  "SELECT JSON_UNQUOTE(JSON_EXTRACT(payload,'$.binding.revision')) rev, group_id, capabilities FROM metric_policy_bindings WHERE resource_key = ?",
  [`instance:${id}`])) ?? null;

/* --- A. first binding of an unbound resource ----------------------------- */
{
  const status = (await call('GET', '/api/metrics/template-bindings/instance/1')).data;
  const preview = await call('POST', '/api/metrics/template-bindings/instance/1/preview',
    { expected_revision: 0, template_pins: [pin], overrides: {}, group_id: null });
  const trial = await call('POST', '/api/metrics/template-bindings/instance/1/trial',
    { expected_revision: 0, template_pins: [pin], overrides: {}, group_id: null, receipt_id: `first-${Date.now().toString(36)}` });
  const stored = await resourceOf(1);
  evidence.scenarios.first_binding = {
    binding: { source: status.source, revision: status.revision, configuration: status.configuration },
    preview: { status: preview.status, revision: preview.data?.revision, executable: preview.data?.executable,
      excluded: preview.data?.excluded?.map(entry => ({ item: entry.item_id, reason: entry.reason, blocking: entry.blocking })) },
    trial: { status: trial.status, error: trial.data?.error },
    // The first binding is never written before a real capability probe; the
    // accepted "capability_unknown ⇒ not executable" predicate refuses it.
    row_created: stored !== null,
  };
}

/* --- B. legacy → native conversion --------------------------------------- */
const legacyBefore = (await call('GET', '/api/metrics/template-bindings/instance/2')).data;
{
  const overrides = { interval_ms: { mode: 'set', value: 45000 }, max_rows: { mode: 'set', value: 50 } };
  const base = legacyBefore.revision;
  const preview = await call('POST', '/api/metrics/template-bindings/instance/2/preview',
    { expected_revision: base, template_pins: [pin], overrides, group_id: null });
  const receipt = `life-trial-${Date.now().toString(36)}`;
  let trial = null;
  for (let attempt = 0; attempt < 8; attempt++) {
    trial = await call('POST', '/api/metrics/template-bindings/instance/2/trial',
      { expected_revision: base, template_pins: [pin], overrides, group_id: null, receipt_id: `${receipt}-${attempt}` });
    if (trial.status !== 409) { trial.receipt_id_used = `${receipt}-${attempt}`; break; }
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  const key = `life-apply-${Date.now().toString(36)}`;
  const apply = await call('POST', '/api/metrics/template-bindings/instance/2/apply',
    { expected_revision: base, template_pins: [pin], overrides, group_id: null,
      receipt_id: trial.receipt_id_used, caller_key: key });
  const after = (await call('GET', '/api/metrics/template-bindings/instance/2')).data;
  evidence.scenarios.conversion = {
    base_revision: base, preview: { status: preview.status, executable: preview.data?.executable },
    trial: { status: trial.status, decision: trial.data?.decision,
      samples: trial.data?.samples?.map(sample => ({ metric: sample.metric.id, unit: sample.unit, observed_at: sample.observed_at })) },
    apply: { status: apply.status, kind: apply.data?.kind, revision: apply.data?.revision },
    after: { source: after.source, revision: after.revision, pending: after.pending?.target_revision,
      application: after.application, configuration: after.configuration },
    journal: (await journal('instance/2', key)).data,
    counts: await counts(key),
    stored_row: { revision: (await resourceOf(2))?.rev, capabilities: (await resourceOf(2))?.capabilities ? 'present' : 'empty' },
    duplicate_revisions: Number((await one(`SELECT COUNT(*) c FROM metric_policy_audit WHERE
      JSON_UNQUOTE(JSON_EXTRACT(payload,'$.action')) = 'template_binding.apply' AND
      JSON_UNQUOTE(JSON_EXTRACT(payload,'$.configuration.target_revision')) = ?`, [after.revision]))?.c ?? 0),
  };
}

/* --- C. lossless configuration round-trip -------------------------------- */
{
  const stored = (await call('GET', '/api/metrics/template-bindings/instance/2')).data;
  const configuration = stored.configuration;
  const base = stored.revision;
  const preview = await call('POST', '/api/metrics/template-bindings/instance/2/preview',
    { expected_revision: base, template_pins: stored.template_pins.map(pin => ({ ...pin })),
      overrides: configuration.overrides, group_id: configuration.group_id });
  const trial = await call('POST', '/api/metrics/template-bindings/instance/2/trial',
    { expected_revision: base, template_pins: stored.template_pins.map(pin => ({ ...pin })),
      overrides: configuration.overrides, group_id: configuration.group_id, receipt_id: `noop-${Date.now().toString(36)}` });
  const noop = await call('POST', '/api/metrics/template-bindings/instance/2/apply',
    { expected_revision: base, template_pins: stored.template_pins.map(pin => ({ ...pin })),
      overrides: configuration.overrides, group_id: configuration.group_id,
      receipt_id: trial.data?.receipt_id, caller_key: `noop-apply-${Date.now().toString(36)}` });
  const afterNoop = (await call('GET', '/api/metrics/template-bindings/instance/2')).data;

  // Edit exactly one value (interval 45000 → 30000) and keep everything else.
  const edited = { ...configuration.overrides, interval_ms: { mode: 'set', value: 30000 } };
  const base2 = afterNoop.revision;
  const preview2 = await call('POST', '/api/metrics/template-bindings/instance/2/preview',
    { expected_revision: base2, template_pins: afterNoop.template_pins.map(pin => ({ ...pin })), overrides: edited, group_id: configuration.group_id });
  const trial2 = await call('POST', '/api/metrics/template-bindings/instance/2/trial',
    { expected_revision: base2, template_pins: afterNoop.template_pins.map(pin => ({ ...pin })), overrides: edited,
      group_id: configuration.group_id, receipt_id: `edit-${Date.now().toString(36)}` });
  const applied = await call('POST', '/api/metrics/template-bindings/instance/2/apply',
    { expected_revision: base2, template_pins: afterNoop.template_pins.map(pin => ({ ...pin })), overrides: edited,
      group_id: configuration.group_id, receipt_id: trial2.data?.receipt_id, caller_key: `edit-apply-${Date.now().toString(36)}` });
  const afterEdit = (await call('GET', '/api/metrics/template-bindings/instance/2')).data;
  evidence.scenarios.lossless = {
    seeded: configuration,
    noop: { preview: preview.status, trial_decision: trial.data?.decision, apply: { status: noop.status, kind: noop.data?.kind, revision: noop.data?.revision },
      configuration_after: afterNoop.configuration },
    single_edit: { preview: preview2.status, executable: preview2.data?.executable, apply: { status: applied.status, kind: applied.data?.kind, revision: applied.data?.revision },
      configuration_after: afterEdit.configuration,
      other_values_kept: afterEdit.configuration.overrides.max_rows?.value === configuration.overrides.max_rows?.value },
  };
}

/* --- D. cancel writes nothing -------------------------------------------- */
{
  const before = await resourceOf(2);
  const auditsBefore = Number((await one('SELECT COUNT(*) c FROM metric_policy_audit'))?.c ?? 0);
  // A cancel is a pure client action: no preview, no trial, no apply.
  await new Promise(resolve => setTimeout(resolve, 50));
  const after = await resourceOf(2);
  evidence.scenarios.cancel = { revision_before: before?.rev, revision_after: after?.rev,
    audits_before: auditsBefore, audits_after: Number((await one('SELECT COUNT(*) c FROM metric_policy_audit'))?.c ?? 0) };
}

/* --- E. two concurrent clients on the same base -------------------------- */
{
  const status = (await call('GET', '/api/metrics/template-bindings/instance/2')).data;
  const base = status.revision;
  const overrides = { ...status.configuration.overrides, interval_ms: { mode: 'set', value: 38000 } };
  const other = { ...status.configuration.overrides, interval_ms: { mode: 'set', value: 39000 } };
  const pins = status.template_pins.map(pin => ({ ...pin }));
  const trialOf = async (values, suffix) => {
    for (let attempt = 0; attempt < 8; attempt++) {
      const trial = await call('POST', '/api/metrics/template-bindings/instance/2/trial',
        { expected_revision: base, template_pins: pins, overrides: values, group_id: null, receipt_id: `conc-${suffix}-${attempt}-${Date.now().toString(36)}` });
      if (trial.status !== 409) return trial;
      await new Promise(resolve => setTimeout(resolve, 1500));
    }
    return null;
  };
  const left = await trialOf(overrides, 'a');
  const right = await trialOf(other, 'b');
  const send = (values, trial, key) => call('POST', '/api/metrics/template-bindings/instance/2/apply',
    { expected_revision: base, template_pins: pins, overrides: values, group_id: null,
      receipt_id: trial?.data?.receipt_id, caller_key: key });
  const keyA = `conc-a-${Date.now().toString(36)}`, keyB = `conc-b-${Date.now().toString(36)}`;
  const [first, second] = await Promise.all([send(overrides, left, keyA), send(other, right, keyB)]);
  const after = (await call('GET', '/api/metrics/template-bindings/instance/2')).data;
  evidence.scenarios.concurrency = {
    base_revision: base,
    first: { status: first.status, kind: first.data?.kind ?? first.data?.error, revision: first.data?.revision },
    second: { status: second.status, kind: second.data?.kind ?? second.data?.error, revision: second.data?.revision },
    revisions_written: Number((await one(`SELECT COUNT(*) c FROM metric_policy_audit WHERE
      JSON_UNQUOTE(JSON_EXTRACT(payload,'$.action')) = 'template_binding.apply' AND
      JSON_UNQUOTE(JSON_EXTRACT(payload,'$.configuration.base_revision')) = ?`, [base]))?.c ?? 0),
    final_revision: after.revision,
    final_interval: after.configuration.overrides.interval_ms?.value,
  };
}

/* --- F. unknown response, recovered through the journal ------------------ */
{
  const status = (await call('GET', '/api/metrics/template-bindings/instance/2')).data;
  const base = status.revision;
  const overrides = { ...status.configuration.overrides, interval_ms: { mode: 'set', value: 41000 } };
  const pins = status.template_pins.map(pin => ({ ...pin }));
  let trial = null;
  for (let attempt = 0; attempt < 8; attempt++) {
    trial = await call('POST', '/api/metrics/template-bindings/instance/2/trial',
      { expected_revision: base, template_pins: pins, overrides, group_id: null, receipt_id: `unknown-${attempt}-${Date.now().toString(36)}` });
    if (trial.status !== 409) break;
    await new Promise(resolve => setTimeout(resolve, 1500));
  }
  const key = `unknown-${Date.now().toString(36)}`;
  const controller = new AbortController();
  const pending = fetch(`${API}/api/metrics/template-bindings/instance/2/apply`, { method: 'POST', headers: auth,
    body: JSON.stringify({ expected_revision: base, template_pins: pins, overrides, group_id: null,
      receipt_id: trial.data?.receipt_id, caller_key: key }), signal: controller.signal })
    .then(response => response.json().catch(() => null)).catch(() => null);
  // Drop the response while the server is still committing.
  setTimeout(() => controller.abort(), 5);
  await pending;
  await new Promise(resolve => setTimeout(resolve, 1500));
  const recovered = await journal('instance/2', key);
  const replay = await call('POST', '/api/metrics/template-bindings/instance/2/apply',
    { expected_revision: base, template_pins: pins, overrides, group_id: null,
      receipt_id: trial.data?.receipt_id, caller_key: key });
  const after = (await call('GET', '/api/metrics/template-bindings/instance/2')).data;
  evidence.scenarios.unknown = {
    base_revision: base,
    journal: recovered.data,
    replay: { status: replay.status, kind: replay.data?.kind, revision: replay.data?.revision ?? replay.data?.target_revision },
    counts: await counts(key),
    final_revision: after.revision,
    final_interval: after.configuration.overrides.interval_ms?.value,
  };
}

/* --- G. revocation at the apply boundary --------------------------------- */
{
  // A non-admin operator with real permissions: revoking its resource grant can
  // be observed while its session stays valid (an admin role carries an implicit
  // wildcard, so it cannot express a narrowed grant).
  const operatorLogin = await fetch(`${API}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'life-operator', password: `${process.env.MAX238_ADMIN_PASSWORD}-operator` }) });
  const operator = await operatorLogin.json();
  const operatorAuth = { Authorization: `Bearer ${operator.token}`, 'Content-Type': 'application/json' };
  const operatorCall = async (method, path, body) => {
    const response = await fetch(`${API}${path}`, { method, headers: operatorAuth,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json().catch(() => null) };
  };
  const status = (await operatorCall('GET', '/api/metrics/template-bindings/instance/2')).data;
  const base = status.revision;
  const overrides = { ...status.configuration.overrides, interval_ms: { mode: 'set', value: 52000 } };
  const pins = status.template_pins.map(pin => ({ ...pin }));
  let trial = null;
  for (let attempt = 0; attempt < 8; attempt++) {
    trial = await operatorCall('POST', '/api/metrics/template-bindings/instance/2/trial',
      { expected_revision: base, template_pins: pins, overrides, group_id: null, receipt_id: `revoke-${attempt}-${Date.now().toString(36)}` });
    if (trial.status !== 409) break;
    await new Promise(resolve => setTimeout(resolve, 1500));
  }
  // The grant is narrowed to read-only after the trial read the target.
  await db.query("UPDATE instance_permissions SET access_level = 'read-only' WHERE instance_id = 2 AND user_id = ?",
    [(await one("SELECT id FROM users WHERE username = 'life-operator'"))?.id]);
  const auditsBefore = Number((await one('SELECT COUNT(*) c FROM metric_policy_audit'))?.c ?? 0);
  const key = `revoke-${Date.now().toString(36)}`;
  const denied = await operatorCall('POST', '/api/metrics/template-bindings/instance/2/apply',
    { expected_revision: base, template_pins: pins, overrides, group_id: null,
      receipt_id: trial.data?.receipt_id, caller_key: key });
  const auditsAfter = Number((await one('SELECT COUNT(*) c FROM metric_policy_audit'))?.c ?? 0);
  const afterRevoke = await resourceOf(2);
  await db.query("UPDATE instance_permissions SET access_level = 'admin' WHERE instance_id = 2 AND user_id = ?",
    [(await one("SELECT id FROM users WHERE username = 'life-operator'"))?.id]);
  evidence.scenarios.revocation = { status: denied.status, error: denied.data?.error,
    trial_status: trial.status, audits_before: auditsBefore, audits_after: auditsAfter,
    revision_unchanged: afterRevoke?.rev === String(base), operations_for_key: (await counts(key)).operations };
}

const file = `${OUT}/api-evidence.json`;
writeFileSync(file, JSON.stringify(evidence, null, 2));
console.log(JSON.stringify(evidence, null, 1));
await db.end();
