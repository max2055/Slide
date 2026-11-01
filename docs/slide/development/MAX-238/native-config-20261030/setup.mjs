/**
 * MAX238-NATIVE-CONFIGURATION-FLOW — API setup (real HTTP, no UI yet).
 *
 * Repins the MySQL template to an installed release that applies to the live
 * target, proves preview → real trial → apply, and prints only non-secret facts.
 * It is idempotent on the template version: an already compatible current
 * version is used as-is.
 */
const API = process.env.MAX238_API || 'http://127.0.0.1:3001';
const TEMPLATE = process.env.MAX238_TEMPLATE || 'e19c120027e04da69b130e0f6cea29fc';
const login = await fetch(`${API}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: process.env.MAX238_ADMIN_USER || 'e2e-admin', password: process.env.MAX238_ADMIN_PASSWORD || '' }) });
const session = await login.json();
if (!session.token) throw new Error(`login failed: ${login.status}`);
const headers = { Authorization: `Bearer ${session.token}`, 'Content-Type': 'application/json' };
const call = async (method, path, body) => {
  const response = await fetch(`${API}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, data: await response.json().catch(() => null) };
};
const timeout = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const binding = await call('GET', '/api/metrics/template-bindings/instance/1');
if (binding.data?.source !== 'template') {
  const repin = await call('POST', `/api/metrics/templates/${TEMPLATE}/repin`, { resource: { type: 'instance', id: 1 } });
  if (repin.status !== 200) throw new Error(`repin ${repin.status} ${JSON.stringify(repin.data)}`);
  console.log(JSON.stringify({ step: 'repin', from: repin.data.from_version, to: repin.data.to_version, changes: repin.data.changes?.map(change => change.item_id) }));
}
const templates = await call('GET', '/api/metrics/templates');
const template = templates.data.templates.find(entry => entry.template_id === TEMPLATE);
const pin = { template_id: TEMPLATE, version: template.current_published_version,
  content_hash: template.versions.find(version => version.version === template.current_published_version).content_hash };
const base = (await call('GET', '/api/metrics/template-bindings/instance/1')).data.revision;
const preview = await call('POST', '/api/metrics/template-bindings/instance/1/preview',
  { expected_revision: base, template_pins: [pin], overrides: {}, group_id: null });
if (preview.status !== 200 || !preview.data.executable) throw new Error(`preview ${preview.status}`);
console.log(JSON.stringify({ step: 'preview', executable: preview.data.executable, items: preview.data.items.map(item => item.canonical_metric.id) }));
// The schedule may be busy; the trial reservation is exclusive per resource.
let trial = null, receipt = null;
for (let attempt = 0; attempt < 10; attempt++) {
  receipt = `max238-native-setup-${Date.now().toString(36)}-${attempt}`;
  trial = await call('POST', '/api/metrics/template-bindings/instance/1/trial',
    { expected_revision: base, template_pins: [pin], overrides: {}, receipt_id: receipt });
  if (trial.status !== 409) break;
  await timeout(3000);
}
if (trial.status !== 200) throw new Error(`trial ${trial.status}`);
console.log(JSON.stringify({ step: 'trial', decision: trial.data.decision,
  samples: trial.data.samples.map(sample => ({ metric: sample.metric.id, unit: sample.unit, observed_at: sample.observed_at })) }));
const apply = await call('POST', '/api/metrics/template-bindings/instance/1/apply',
  { expected_revision: base, template_pins: [pin], overrides: {}, receipt_id: receipt, caller_key: `apply-setup-${Date.now().toString(36)}` });
if (apply.status !== 200 || !['committed', 'replay'].includes(apply.data.kind)) throw new Error(`apply ${apply.status} ${JSON.stringify(apply.data)}`);
const after = await call('GET', '/api/metrics/template-bindings/instance/1');
console.log(JSON.stringify({ step: 'apply', kind: apply.data.kind, revision: apply.data.revision ?? apply.data.target_revision,
  binding_source: after.data.source, binding_revision: after.data.revision, application: after.data.application.status,
  applied_revision: after.data.application.applied_revision }));
