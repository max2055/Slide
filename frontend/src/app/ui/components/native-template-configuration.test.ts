import { afterEach, expect, it, vi } from 'vitest';
const { authFetch } = vi.hoisted(() => ({ authFetch: vi.fn() }));
vi.mock('../../../api/index.js', () => ({ authFetch }));
import './native-template-configuration.js';
import { nativeTrialPassed } from './native-template-configuration.js';
import { collectionStatus } from './metric-test-fixtures.js';

const settle = () => new Promise(resolve => setTimeout(resolve, 15));
afterEach(() => { document.body.replaceChildren(); authFetch.mockReset(); sessionStorage.clear(); localStorage.clear(); vi.useRealTimers(); });

const hash = (character: string) => `sha256:${character.repeat(64)}`;
const binding = (overrides: Record<string, unknown> = {}) => ({
  source: 'template', revision: 5, template_pins: [{ template_id: 'tpl-mysql', version: 2, content_hash: hash('b') }],
  application: { status: 'pending', applied_revision: 4, reported_at: null, error_code: null },
  pending: { base_revision: 4, target_revision: 5, resolution_identity: hash('a'), decided_at: '2026-10-29T12:00:00.000Z',
    operation_key: 'op-5', plan: { settings: { enabled: true, interval_ms: 60000, timeout_ms: 5000, stale_after_ms: 120000,
      max_counter_gap_ms: 300000, max_rows: 100, max_concurrency: 1, max_series_per_resource: 100 }, parameters: [], releases: [], excluded: [] } },
  effective: { revision: 4, resolution_identity: hash('c') }, published_at: '2026-10-29T12:00:00.000Z', ...overrides,
});
const catalog = (next: string | null = null) => ({ next_cursor: next, templates: [
  { template_id: 'tpl-mysql', name: 'MySQL 基础监控', status: 'active', current_published_version: 2,
    versions: [{ version: 1, content_hash: hash('a'), status: 'published' }, { version: 2, content_hash: hash('b'), status: 'published' }] },
  { template_id: 'tpl-draft', name: '草稿模板', status: 'draft', current_published_version: null, versions: [] },
] });
const detail = (templateId = 'tpl-mysql', version = 2) => ({ template_id: templateId, version, status: 'published',
  content_hash: hash('b'), items: [{ item_id: 'uptime', version: 1, display_name: 'Uptime',
    canonical_metric: { id: 'db.uptime_seconds', semantic_version: '1.0.0' }, unit: 's', dimensions: {},
    collector_ref: { package_release: 'mysql-basic@2.0.0#sha256:' + 'c'.repeat(64), implementation_id: 'builtin:mysql.status.v2' } }],
  parameters: { schema: { timeout: { type: 'number', min: 1, max: 30 } }, defaults: { timeout: 5 } },
  source_chain: {}, published_at: '2026-10-29T12:00:00.000Z' });
const preview = () => ({ template: true, resource: { type: 'instance', id: 1 }, revision: 5, resolution_identity: hash('a'),
  executable: true, settings: { enabled: true, interval_ms: 60000, timeout_ms: 5000, stale_after_ms: 120000,
    max_counter_gap_ms: 300000, max_rows: 100, max_concurrency: 1, max_series_per_resource: 100 },
  parameters: [{ pin: { template_id: 'tpl-mysql', version: 2, content_hash: hash('b') },
    parameters: [{ name: 'timeout', type: 'number', default: 5, override: null, effective: 5, source: 'default' }] }],
  releases: [{ release: { id: 'mysql-basic', version: '2.0.0', digest: hash('c') }, release_ref: 'mysql-basic@2.0.0#' + hash('c'),
    interval_ms: 60000, timeout_ms: 5000, collector_ids: ['mysql-status'], metric_keys: ['db.uptime_seconds@1.0.0'],
    requests_per_hour_estimate: 60, applicability: [{ attribute: 'db.version', value: '9.6', supported_values: ['9.6'], status: 'supported' }] }],
  items: [{ template_id: 'tpl-mysql', item_id: 'uptime', item_version: 1,
    canonical_metric: { id: 'db.uptime_seconds', semantic_version: '1.0.0' }, unit: 's', dimensions: {},
    release: { id: 'mysql-basic', version: '2.0.0', digest: hash('c') }, release_ref: 'mysql-basic@2.0.0#' + hash('c'),
    collector_id: 'mysql-status', implementation_id: 'builtin:mysql.status.v2', enabled: true, decision: 'collect', capability: 'supported' }],
  excluded: [], budget: { estimated_series_upper_bound: 1, max_series_per_resource: 100, requests_per_hour_estimate: 60 },
  plan: {} });
const trial = () => ({ trial: true, persisted: false, decision: 'attempted', receipt_id: 'trial-1', expires_at: '2026-10-29T12:10:00.000Z',
  resolution_identity: hash('a'), items: [{ template_id: 'tpl-mysql', item_id: 'uptime', item_version: 1,
    phases: { read: true, transform: true, unit: true } }], optional_exclusions: [],
  samples: [{ template_id: 'tpl-mysql', item_id: 'uptime', item_version: 1, metric: { id: 'db.uptime_seconds', semantic_version: '1.0.0' },
    value: 78602, unit: 's', observed_at: '2026-10-29T12:00:01.000Z', quality: { status: 'good' },
    read: { collector_id: 'mysql-status', attempt_ids: ['a'], status: 'succeeded' }, transform: { version: '2' },
    unit_check: { input_unit: 's', output_unit: 's' } }], attempts: [{ collector_id: 'mysql-status', status: 'succeeded' }],
  releases: [{ release_ref: 'mysql-basic@2.0.0#' + hash('c'), decision: 'attempted' }] });

const routes = (overrides: Record<string, (url: string, init?: RequestInit) => unknown> = {}) => async (url: string, init?: RequestInit) => {
  const method = init?.method ?? 'GET';
  for (const [suffix, handler] of Object.entries(overrides)) {
    const matches = suffix === '/operations/' ? url.includes(suffix) : suffix.endsWith('?') ? url.includes(suffix) : url.endsWith(suffix);
    if (matches) return handler(url, init);
  }
  if (/\/template-bindings\/instance\/\d+\/operations\//.test(url)) return { ok: true, json: async () => ({ state: 'absent', operation: null }) };
  if (/\/template-bindings\/instance\/\d+$/.test(url) && method === 'GET') return { ok: true, json: async () => binding() };
  if (/\/config\/resources\/instance\/\d+\/status$/.test(url)) return { ok: true, json: async () => collectionStatus('unbound') };
  if (/\/config\/resources\/instance\/\d+\/recommendations$/.test(url)) return { ok: true,
    json: async () => ({ resource: { type: 'instance', id: 1 }, evaluated_at: '2026-10-29T12:00:00.000Z', packages: [] }) };
  if (url.includes('/policy/groups')) return { ok: true, json: async () => ({ groups: [] }) };
  const versionMatch = url.match(/\/templates\/([^/]+)\/versions\/(\d+)$/);
  if (versionMatch) return { ok: true, json: async () => detail(versionMatch[1], Number(versionMatch[2])) };
  if (url.includes('/templates')) return { ok: true, json: async () => catalog() };
  if (url.endsWith('/template-bindings/instance/1/preview')) return { ok: true, json: async () => preview() };
  if (url.endsWith('/template-bindings/instance/1/trial')) return { ok: true, json: async () => trial() };
  if (url.endsWith('/template-bindings/instance/1/apply')) return { ok: true, json: async () => ({ kind: 'committed', status: 'committed',
    persisted: true, committed: true, revision: 6, resolution_identity: hash('d'),
    operation: { key: 'k', caller_key: 'client-1', receipt_id: 'trial-1', status: 'committed' } }) };
  return { ok: false, status: 404, json: async () => ({ error: 'NOT_FOUND' }) };
};
const mount = async () => {
  const element = document.createElement('native-template-configuration') as any;
  element.resourceId = 1;
  document.body.append(element);
  for (let i = 0; i < 40 && !element.loaded; i++) await settle();
  return element;
};
const jsonOf = (suffix: string) => {
  const call = authFetch.mock.calls.find((entry: unknown[]) => String(entry[0]).endsWith(suffix));
  return call ? JSON.parse(String((call[1] as RequestInit).body)) : null;
};

it('does not preselect a template or a first-row default version', async () => {
  authFetch.mockImplementation(routes());
  const element = await mount();
  expect(element.selected).toEqual([{ template_id: 'tpl-mysql', version: 2, content_hash: hash('b') }]);
  // The binding's own pin is prefilled; with no binding the picker stays empty.
  const fresh = document.createElement('native-template-configuration') as any;
  authFetch.mockImplementation(routes({ '/template-bindings/instance/2': () => ({ ok: true, json: async () => binding({
    source: 'unbound', revision: 0, template_pins: [], pending: null, application: null, effective: null, published_at: null }) }) }));
  fresh.resourceId = 2; document.body.append(fresh);
  for (let i = 0; i < 40 && !fresh.loaded; i++) await settle();
  expect(fresh.selected).toEqual([]);
  expect(authFetch.mock.calls.some((entry: unknown[]) => String(entry[0]).includes('/template-bindings/instance/2/preview'))).toBe(false);
  expect(element.shadowRoot.textContent).toContain('草稿模板');
});

it('searches and pages the whole catalog instead of truncating to one page', async () => {
  let page = 0;
  authFetch.mockImplementation(routes({ '/templates?': (url: string) => {
    page += 1;
    return { ok: true, json: async () => page === 1 ? catalog('tpl-mysql') : catalog(null) };
  } }));
  const element = await mount();
  expect(element.nextCursor).toBe('tpl-mysql');
  await element.loadCatalog(false);
  expect(element.templates.map((entry: { template_id: string }) => entry.template_id)).toEqual(['tpl-mysql', 'tpl-draft']);
  expect(element.nextCursor).toBeNull();
  // Search is server-side and starts from the first page.
  element.searchCatalog('MySQL');
  await new Promise(resolve => setTimeout(resolve, 350));
  const call = authFetch.mock.calls.filter((entry: unknown[]) => String(entry[0]).includes('/templates?')).at(-1)!;
  expect(String(call[0])).toContain('query=MySQL');
  expect(String(call[0])).not.toContain('cursor=');
});

it('a draft template cannot be selected', async () => {
  authFetch.mockImplementation(routes());
  const element = await mount();
  element.toggleTemplate(element.templates[1], true);
  expect(element.selected).toHaveLength(1); // the binding pin survives, the draft is refused
  expect(element.error).toContain('没有已发布版本');
});

it('an unbound resource can check the first binding at base revision 0', async () => {
  authFetch.mockImplementation(routes({
    '/template-bindings/instance/2': () => ({ ok: true, json: async () => binding({
      source: 'unbound', revision: null, template_pins: [], configuration: null,
      pending: null, application: null, effective: null, published_at: null }) }),
    '/template-bindings/instance/2/preview': () => ({ ok: true, json: async () => ({ ...preview(), revision: 0 }) }),
  }));
  const fresh = document.createElement('native-template-configuration') as any;
  fresh.resourceId = 2; document.body.append(fresh);
  for (let i = 0; i < 40 && !fresh.loaded; i++) await settle();
  fresh.toggleTemplate(fresh.templates[0], true);
  await fresh.previewFlow();
  const call = authFetch.mock.calls.find((entry: unknown[]) => String(entry[0]).endsWith('/preview'));
  expect(call).toBeTruthy();
  const body = JSON.parse(String((call[1] as RequestInit).body));
  expect(body.expected_revision).toBe(0);
  expect(fresh.preview).not.toBeNull();
  expect(fresh.shadowRoot.textContent).toContain('首次绑定并启用');
});

it('preview carries the exact fixed version, parameters and settings; a change invalidates the trial', async () => {
  authFetch.mockImplementation(routes());
  const element = await mount();
  element.parameters = { 'tpl-mysql': { timeout: 9 } };
  element.settings = { enabled: 'enable' };
  await element.previewFlow();
  const body = jsonOf('/template-bindings/instance/1/preview');
  expect(body).toMatchObject({ expected_revision: 5, group_id: null,
    template_pins: [{ template_id: 'tpl-mysql', version: 2, content_hash: hash('b') }],
    overrides: { enabled: 'enable', template_parameters: { 'tpl-mysql': { timeout: 9 } } } });
  await element.runTrial();
  expect(nativeTrialPassed(element.trial)).toBe(true);
  element.changeParameter('tpl-mysql', 'timeout', '7', 'number');
  expect(element.trial).toBeNull();
  expect(element.previewStale).toBe(true);
  await element.applyFlow();
  expect(authFetch.mock.calls.some((entry: unknown[]) => String(entry[0]).endsWith('/apply'))).toBe(false);
});

it('renders the encoded observation value, never "[object Object]"', async () => {
  authFetch.mockImplementation(routes({ '/trial': () => ({ ok: true, json: async () => ({ ...trial(),
    samples: [{ ...trial().samples[0], value: { encoding: 'float64', value: 78602 } }] }) }) }));
  const element = await mount();
  await element.previewFlow(); await element.runTrial();
  const text = element.shadowRoot.textContent;
  expect(text).toContain('值 78602 s');
  expect(text).not.toContain('[object Object]');
});

it('a failed or partial trial never authorizes applying', async () => {
  authFetch.mockImplementation(routes({ '/trial': () => ({ ok: true, json: async () => ({ ...trial(),
    items: [{ template_id: 'tpl-mysql', item_id: 'uptime', item_version: 1, phases: { read: true, transform: true, unit: false } }] }) }) }));
  const element = await mount();
  await element.previewFlow(); await element.runTrial();
  expect(nativeTrialPassed(element.trial)).toBe(false);
  const before = authFetch.mock.calls.length;
  await element.applyFlow();
  expect(authFetch.mock.calls).toHaveLength(before);
});

it('apply keeps one operation key for the same intent and releases it only on an absent journal', async () => {
  let applyCall = 0;
  authFetch.mockImplementation(routes({
    '/apply': () => { applyCall += 1;
      if (applyCall === 1) throw new Error('network lost');
      return { ok: true, json: async () => ({ kind: 'committed', status: 'committed', persisted: true, committed: true,
        revision: 6, resolution_identity: hash('d'), operation: { key: 'k', caller_key: 'c', receipt_id: 'trial-1', status: 'committed' } }) }; },
    '/operations/': () => ({ ok: true, json: async () => ({ state: 'absent', operation: null }) }),
  }));
  const element = await mount();
  await element.previewFlow(); await element.runTrial();
  await element.applyFlow();
  expect(applyCall).toBe(1);
  // The absent lookup proves the intent was never recorded: the key is released
  // and the original failure is still reported.
  expect(element.unresolved).toHaveLength(0);
  expect(element.error).toBeTruthy();
  const bodies = () => authFetch.mock.calls.filter((entry: unknown[]) => String(entry[0]).endsWith('/apply'))
    .map((entry: unknown[]) => JSON.parse(String((entry[1] as RequestInit).body)));
  await element.applyFlow();
  expect(applyCall).toBe(2);
  // The same configuration is the same intent, so the re-trial receipt never
  // turns it into a second write under a different key.
  expect(bodies()[1].caller_key).toBe(bodies()[0].caller_key);
  expect(element.applyResult).toMatchObject({ revision: 6 });
});

it('a commit-unknown intent survives an edit, a reload and a switch, and is only looked up', async () => {
  let applyCall = 0;
  authFetch.mockImplementation(routes({
    '/apply': () => { applyCall += 1;
      return { ok: true, json: async () => ({ kind: 'commit_unknown', status: 'unknown', persisted: 'unknown',
        committed: 'unknown', cause: 'connection', lookup: true, operation: { key: 'k', caller_key: 'c', status: 'unknown' } }) }; },
    '/operations/': () => ({ ok: true, json: async () => ({ state: 'pending', operation: null }) }),
  }));
  const element = await mount();
  await element.previewFlow(); await element.runTrial();
  await element.applyFlow();
  expect(applyCall).toBe(1);
  expect(element.unresolved).toHaveLength(1);
  const stored = JSON.parse(sessionStorage.getItem('slide.metric.native.apply.anon.instance:1')!);
  expect(stored).toHaveLength(1);
  const key = stored[0].key;
  // An edit invalidates the trial but is not a draft: the unknown stays.
  element.changeParameter('tpl-mysql', 'timeout', '9', 'number');
  expect(element.unresolved).toHaveLength(1);
  // "Reload" / "discard" must query the original key, never forget it.
  element.discardChanges();
  expect(element.unresolved).toHaveLength(1);
  await element.reloadAll();
  expect(element.unresolved).toHaveLength(1);
  const lookups = authFetch.mock.calls.filter((entry: unknown[]) => String(entry[0]).includes('/operations/'));
  expect(lookups.length).toBeGreaterThanOrEqual(2);
  expect(String(lookups.at(-1)![0])).toContain(`/operations/${key}`);
  expect(applyCall).toBe(1);
  expect(element.shadowRoot.textContent).toContain('上次发布结果尚未确认');
});

it('a late apply answer for a resource the user already left is not projected onto the new one', async () => {
  let release: (() => void) | null = null;
  const gate = new Promise<void>(resolve => { release = resolve; });
  authFetch.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/apply')) { await gate;
      return { ok: true, json: async () => ({ kind: 'committed', status: 'committed', persisted: true, committed: true,
        revision: 6, resolution_identity: hash('d'), operation: { key: 'k', caller_key: 'c', receipt_id: 'trial-1', status: 'committed' } }) }; }
    return routes()(url, init);
  });
  const element = await mount();
  await element.previewFlow(); await element.runTrial();
  const pending = element.applyFlow();
  element.resourceId = 2;
  release!();
  await pending;
  for (let i = 0; i < 40 && !element.loaded; i++) await settle();
  expect(element.applyResult).toBeNull();
  expect(element.step).toBe(0);
});

it('published, pending, applied, first sample and formal collection stay separate facts', async () => {
  authFetch.mockImplementation(routes());
  const element = await mount();
  const text = element.shadowRoot.textContent;
  for (const fact of ['保存', '发布（已提交）', '等待应用', '调度应用', '首样本', '正式采集']) expect(text).toContain(fact);
  expect(text).toContain('API 返回 200 不代表健康');
  expect(text).toContain('尚未收到正式首样本');
});

it('never repins implicitly, and an explicit compatible upgrade moves only this pin', async () => {
  const nextPin = { template_id: 'tpl-mysql', version: 3, content_hash: hash('e') };
  authFetch.mockImplementation(routes({
    '/preview': () => ({ ok: true, json: async () => ({ ...preview(), executable: false }) }),
    '/repin': () => ({ ok: true, json: async () => ({ unchanged: false, template_id: 'tpl-mysql', from_version: 2, to_version: 3,
      content_hash: hash('e'), changes: [{ item_id: 'uptime',
        from: { version: 1, release: 'mysql-basic@1.0.0', implementation_id: 'builtin:mysql.status.v1' },
        to: { version: 2, release: 'mysql-basic@2.0.0', implementation_id: 'builtin:mysql.status.v2' },
        reason: 'target_version_incompatible' }], pin: nextPin }) }),
  }));
  const element = await mount();
  await element.previewFlow();
  expect(element.preview.executable).toBe(false);
  // Nothing published a version as a side effect of checking.
  expect(authFetch.mock.calls.some((entry: unknown[]) => String(entry[0]).endsWith('/repin'))).toBe(false);
  element.openRepin(element.templates[0]);
  expect(element.repinTarget).toEqual({ template_id: 'tpl-mysql', name: 'MySQL 基础监控' });
  await element.runRepin();
  const call = authFetch.mock.calls.find((entry: unknown[]) => String(entry[0]).endsWith('/repin'))!;
  expect(String(call[0])).toContain('/templates/tpl-mysql/repin');
  expect(JSON.parse(String((call[1] as RequestInit).body))).toEqual({ resource: { type: 'instance', id: 1 } });
  expect(element.selected).toEqual([nextPin]);
  expect(element.repinResult).toMatchObject({ from_version: 2, to_version: 3 });
  expect(element.preview).toBeNull(); // the new version must be checked again
});

it('a read-only user cannot select or write', async () => {
  authFetch.mockImplementation(routes());
  authFetch.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/config/resources/instance/1/status')) return { ok: true, json: async () => ({ ...collectionStatus('unbound'), can_manage: false }) };
    return routes()(url, init);
  });
  const element = await mount();
  expect(element.canManage).toBe(false);
  expect(element.shadowRoot.textContent).toContain('只读');
});

it('seeds every stored override and sends an unedited setting back unchanged', async () => {
  const configuration = { group_id: 'web', overrides: {
    enabled: { mode: 'set', value: false },
    interval_ms: { mode: 'set', value: 30000 },
    metrics: { 'db.uptime_seconds@1.0.0': 'disable' },
    template_parameters: { 'tpl-mysql': { timeout: 9 } } } };
  authFetch.mockImplementation(routes({
    '/template-bindings/instance/1': () => ({ ok: true, json: async () => binding({ configuration }) }),
  }));
  const element = await mount();
  expect(element.settings).toEqual({ enabled: { mode: 'set', value: false }, interval_ms: { mode: 'set', value: 30000 } });
  expect(element.metricToggles).toEqual({ 'db.uptime_seconds@1.0.0': 'disable' });
  expect(element.parameters).toEqual({ 'tpl-mysql': { timeout: 9 } });
  expect(element.groupId).toBe('web');

  // "Discard" returns to the published configuration; it never blanks the overrides.
  element.settings = {}; element.metricToggles = {}; element.parameters = {}; element.groupId = ''; element.dirty = true;
  element.discardChanges();
  expect(element.settings).toEqual({ enabled: { mode: 'set', value: false }, interval_ms: { mode: 'set', value: 30000 } });
  expect(element.metricToggles).toEqual({ 'db.uptime_seconds@1.0.0': 'disable' });
  expect(element.parameters).toEqual({ 'tpl-mysql': { timeout: 9 } });
  expect(element.groupId).toBe('web');

  // Editing exactly one parameter changes exactly that parameter.
  await element.previewFlow();
  element.changeParameter('tpl-mysql', 'timeout', '11', 'number');
  await element.previewFlow();
  const previews = authFetch.mock.calls.filter((entry: unknown[]) => String(entry[0]).endsWith('/preview'));
  const body = JSON.parse(String((previews.at(-1)![1] as RequestInit).body));
  expect(body.group_id).toBe('web');
  expect(body.overrides).toEqual({
    enabled: { mode: 'set', value: false }, interval_ms: { mode: 'set', value: 30000 },
    metrics: { 'db.uptime_seconds@1.0.0': 'disable' },
    template_parameters: { 'tpl-mysql': { timeout: 11 } },
  });
});

it('a plain reload keeps the stored override set instead of clearing it', async () => {
  const configuration = { group_id: 'web', overrides: {
    metrics: { 'db.uptime_seconds@1.0.0': 'enable' }, template_parameters: { 'tpl-mysql': { timeout: 9 } } } };
  authFetch.mockImplementation(routes({
    '/template-bindings/instance/1': () => ({ ok: true, json: async () => binding({ configuration }) }),
  }));
  const element = await mount();
  element.settings = { interval_ms: { mode: 'set', value: 5000 } };
  await element.reloadAll();
  expect(element.settings).toEqual({});
  expect(element.metricToggles).toEqual({ 'db.uptime_seconds@1.0.0': 'enable' });
  expect(element.parameters).toEqual({ 'tpl-mysql': { timeout: 9 } });
  expect(element.groupId).toBe('web');
  await element.previewFlow();
  const previews = authFetch.mock.calls.filter((entry: unknown[]) => String(entry[0]).endsWith('/preview'));
  expect(JSON.parse(String((previews.at(-1)![1] as RequestInit).body)).overrides).toEqual(configuration.overrides);
});

it('a delayed re-pin answer never lands on the resource the user switched to', async () => {
  let release: (() => void) | null = null;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const nextPin = { template_id: 'tpl-mysql', version: 3, content_hash: hash('e') };
  authFetch.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/repin')) {
      await gate;
      return { ok: true, json: async () => ({ unchanged: false, template_id: 'tpl-mysql', from_version: 2, to_version: 3,
        content_hash: hash('e'), changes: [], pin: nextPin }) };
    }
    return routes({
      '/preview': () => ({ ok: true, json: async () => ({ ...preview(), executable: false }) }),
      '/template-bindings/instance/2': () => ({ ok: true, json: async () => binding({ revision: 7,
        template_pins: [{ template_id: 'tpl-mysql', version: 1, content_hash: hash('a') }], configuration: { overrides: {}, group_id: null } }) }),
    })(url, init);
  });
  const element = await mount();
  await element.previewFlow();
  element.openRepin(element.templates[0]);
  const pending = element.runRepin();
  // The operator switches to instance 2 while the publication is still in flight.
  element.resourceId = 2;
  for (let i = 0; i < 40 && element.binding?.revision !== 7; i++) await settle();
  expect(element.selected.map((pin: { version: number }) => pin.version)).toEqual([1]);
  release!();
  await pending;
  for (let i = 0; i < 20; i++) await settle();
  // The late publication answer belongs to instance 1: it changes nothing here.
  expect(element.selected.map((pin: { version: number }) => pin.version)).toEqual([1]);
  expect(element.repinResult).toBeNull();
  expect(element.repinTarget).toBeNull();
});
