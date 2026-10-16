import { afterEach, expect, it, vi } from 'vitest';
import { findSettingsRoute } from '../settings-navigation.js';
const { authFetch } = vi.hoisted(() => ({ authFetch: vi.fn() }));
vi.mock('../../../api/index.js', () => ({ authFetch }));
import './metric-configuration.js';
import { collectionStatus } from './metric-test-fixtures.js';
const settle = () => new Promise(resolve => setTimeout(resolve, 15));
afterEach(() => { document.body.replaceChildren(); authFetch.mockReset(); vi.useRealTimers(); });
const catalog = { packages: [{ package: { id: 'mysql-basic', version: '1.0.0', digest: 'pin', resource_type: 'instance' }, recommendations: { interval_ms: 60000 } }], metrics: [] };
const recommendations = { resource: { type: 'instance', id: 1 }, evaluated_at: '', packages: catalog.packages.map(release => ({ release, compatibility: 'compatible', recommended: true, checks: [], coverage: [{ id: 'db.uptime_seconds' }], missing_core_metrics: [] })) };
const mock = (manage = true) => authFetch.mockImplementation(async (url: string) => ({ ok: !(/policy\/resources\/instance\/\d+$/.test(url)), status: (/policy\/resources\/instance\/\d+$/.test(url)) ? 404 : 200,
  json: async () => /policy\/resources\/instance\/\d+$/.test(url) ? { error: 'POLICY_NOT_FOUND' }
    : url.endsWith('/catalog') ? catalog : url.endsWith('/access') ? { can_manage: manage }
    : url.endsWith('/recommendations') ? recommendations : url.endsWith('/groups') ? { groups: [] }
    : url.endsWith('/status') ? collectionStatus('unbound')
    : url.endsWith('/preview') ? { resources: [], affected_resources: 1 }
    : url.endsWith('/trial') ? { decision: 'attempted', attempts: [], samples: [] } : [] }));
const mount = async () => { const el = document.createElement('metric-configuration') as any; el.resourceId = 1; document.body.append(el); await settle(); return el; };
it('preserves legacy catalog route and canonical route', () => {
  expect(findSettingsRoute('/metric-registry')?.view).toBe('catalog');
  expect(findSettingsRoute('/settings/monitoring/metrics')?.item.views?.map(v => v.id)).toEqual(['catalog', 'packages', 'policies', 'audit']);
});
it('does not offer writes before permissions load or to a reader', async () => {
  mock(false); const el = await mount();
  expect(el.shadowRoot.textContent).toContain('只读');
  expect([...el.shadowRoot.querySelectorAll('button')].some((b: any) => b.textContent === '发布')).toBe(false);
});
it('editing invalidates previews and trial; sends full overrides without credentials', async () => {
  mock(); const el = await mount();
  await el.execute('preview'); await el.execute('trial');
  expect(el.preview).not.toBeNull(); expect(el.trial).not.toBeNull();
  el.shadowRoot.querySelector('metric-policy-fields').dispatchEvent(new CustomEvent('policy-change', { detail: { enabled: 'disable' } }));
  await settle(); expect(el.preview).toBeNull(); expect(el.trial).toBeNull();
  const call = authFetch.mock.calls.find((c: any[]) => c[0].endsWith('/trial'))!;
  expect(JSON.parse(call[1].body)).toMatchObject({ expected_revision: 0, overrides: {} });
  expect(call[1].body).not.toContain('credential');
});
it('409 clears prior proofs without retrying or overwriting revision', async () => {
  mock(); const el = await mount();
  authFetch.mockResolvedValue({ ok: false, status: 409, json: async () => ({ error: 'POLICY_REVISION_CONFLICT' }) });
  const before = authFetch.mock.calls.length; await el.execute('preview');
  expect(authFetch.mock.calls.length).toBe(before + 1);
  expect(el.preview).toBeNull(); expect(el.error).toContain('重新加载');
});
it('resource switches discard stale responses', async () => {
  mock(); const el = await mount();
  let finish!: (v: unknown) => void;
  authFetch.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const old = el.execute('preview'); el.resourceId = 2; await settle();
  finish({ ok: true, json: async () => ({ affected_resources: 99 }) }); await old;
  expect(el.preview).toBeNull();
});
it('failed or empty trials cannot authorize publishing', async () => {
  mock(); const el = await mount(); await el.execute('preview'); await el.execute('trial');
  const before = authFetch.mock.calls.length; await el.execute('publish');
  expect(authFetch.mock.calls).toHaveLength(before);
  el.trial = { decision: 'attempted', attempts: [{ status: 'failed' }], samples: [] };
  await el.execute('publish'); expect(authFetch.mock.calls).toHaveLength(before);
});
it('publishing a successful trial sends the current revision and reloads application state', async () => {
  mock(); const el = await mount(); await el.execute('preview');
  authFetch.mockImplementationOnce(async () => ({ ok: true, json: async () => ({ decision: 'attempted', attempts: [{ status: 'succeeded' }], samples: [{ value: 1000 }] }) }));
  await el.execute('trial'); await el.execute('publish');
  const call = authFetch.mock.calls.find((c: any[]) => c[0].endsWith('/activate'))!;
  expect(JSON.parse(call[1].body).expected_revision).toBe(0);
  expect(el.trial).toBeNull(); expect(el.dirty).toBe(false);
});

it('keeps unsaved edits until the user confirms navigation', async () => {
  mock(); const el = await mount(); el.invalidate(); const leave = vi.fn(); el.confirmDiscard(leave); await el.updateComplete;
  expect(leave).not.toHaveBeenCalled(); expect(el.discardPending).toBe(true);
  [...el.shadowRoot.querySelectorAll('button')].find((b: any) => b.textContent === '放弃修改并继续').click();
  expect(leave).toHaveBeenCalledOnce(); expect(el.dirty).toBe(false);
});

it('allows authoritative disabled trials without calling them successful collection', async () => {
  mock(); const el = await mount();
  el.preview = { resources: [{ resolved: { settings: { enabled: false }, sources: {}, metric_templates: [], metric_sources: {} } }] };
  el.trial = { decision: 'disabled', attempts: [], samples: [] };
  expect(el.publishReady()).toBe(true);
  el.preview.resources[0].resolved.settings.enabled = true; expect(el.publishReady()).toBe(false);
});

it.each(['POLICY_RESOURCE_NOT_FOUND', 'NOT_FOUND', undefined])('does not swallow binding 404 %s as an unbound resource', async code => {
  mock(); const previous = authFetch.getMockImplementation()!;
  authFetch.mockImplementation(async (url: string, options: any) => /policy\/resources\/instance\/1$/.test(url)
    ? { ok: false, status: 404, json: async () => ({ error: code }) } : previous(url, options));
  const el = await mount();
  expect(el.shadowRoot.textContent).toContain('配置或资源不存在');
  expect(el.canManage).toBe(false);
  expect(el.shadowRoot.textContent).not.toContain('首次绑定');
});
it('first POLICY_NOT_FOUND loads and clearly describes first binding', async () => {
  mock(); const el = await mount();
  expect(el.shadowRoot.textContent).toContain('首次绑定');
  await el.execute('preview'); expect(el.preview).not.toBeNull();
});
it('shows version mismatch in preview and trial, with advice and no publish', async () => {
  mock(); const el = await mount();
  const applicability = [{ attribute: 'db.version', value: '9.6.0', supported_values: ['5.7', '8.0', '8.4'], status: 'unsupported' }];
  el.preview = { resources: [{ resolved: { applicability, settings: {}, sources: {}, metric_templates: [], metric_sources: {} } }] };
  await el.updateComplete;
  expect(el.shadowRoot.textContent).toContain('9.6.0'); expect(el.shadowRoot.textContent).toContain('5.7 / 8.0 / 8.4');
  el.trial = { decision: 'unsupported', applicability, samples: [], attempts: [] }; await el.updateComplete;
  expect(el.shadowRoot.textContent).toContain('版本不适用'); expect(el.shadowRoot.textContent).toContain('选择支持当前版本的采集包');
  const before = authFetch.mock.calls.length; await el.execute('publish'); expect(authFetch.mock.calls.length).toBe(before);
});
it.each([
  ['permission_denied', '目标数据库权限不足'], ['connection_error', '目标连接失败'], ['timeout', '超时'], ['parse_error', '数据格式或字段不符合采集包要求'],
])('explains %s trial failure', async (error, text) => {
  mock(); const el = await mount();
  el.trial = { decision: 'attempted', attempts: [{ status: 'failed', error }], samples: [] }; await el.updateComplete;
  expect(el.shadowRoot.textContent).toContain(text); expect(el.publishReady()).toBe(false);
});
it('does not publish a succeeded attempt returning zero samples', async () => {
  mock(); const el = await mount(); await el.execute('preview');
  el.trial = { decision: 'attempted', attempts: [{ status: 'succeeded' }], samples: [] }; await el.updateComplete;
  expect(el.shadowRoot.textContent).toContain('未返回样本'); expect(el.publishReady()).toBe(false);
});

it('selects only the compatible recommendation, disables incompatible releases and explains coverage', async () => {
  mock(); const original = authFetch.getMockImplementation()!;
  const releases = [catalog.packages[0], { ...catalog.packages[0], package: { ...catalog.packages[0].package, version: '2.0.0', digest: 'mysql96' } }];
  authFetch.mockImplementation((url, options) => url.endsWith('/catalog') ? Promise.resolve({ ok: true, json: async () => ({ ...catalog, packages: releases }) })
    : url.endsWith('/recommendations') ? Promise.resolve({ ok: true, json: async () => ({ ...recommendations, packages: releases.map((release, i) => ({
      release, compatibility: i ? 'compatible' : 'incompatible', recommended: !!i, coverage: [{ id: 'db.uptime_seconds' }], missing_core_metrics: [],
      checks: [{ attribute: 'db.version', value: '9.6.0', supported_values: i ? ['9.6'] : ['5.7', '8.0'], status: i ? 'supported' : 'unsupported' }],
    })) }) }) : original(url, options));
  const el = await mount();
  expect(el.selected).toBe('mysql96');
  expect(el.shadowRoot.querySelector('option[value="pin"]').disabled).toBe(true);
  expect(el.shadowRoot.textContent).toContain('数据库运行时长');
  expect(el.shadowRoot.textContent).toContain('9.6.0');
});

it('keeps an existing template and user overrides instead of silently replacing them with recommendations', async () => {
  mock(); const original = authFetch.getMockImplementation()!;
  const resolved = { settings: { enabled: true }, sources: {}, metric_sources: {}, metric_templates: [] };
  const published = { binding: { package: catalog.packages[0].package, revision: 7, group_id: 'existing', overrides: { interval_ms: { mode: 'set', value: 30000 } } }, resolved, application: { status: 'applied', applied_revision: 7 } };
  authFetch.mockImplementation((url, options) => /policy\/resources\/instance\/1(?:\/effective)?$/.test(url)
    ? Promise.resolve({ ok: true, json: async () => published }) : original(url, options));
  const el = await mount();
  expect(el.selected).toBe('pin'); expect(el.overrides).toEqual(published.binding.overrides); expect(el.groupId).toBe('existing');
  expect(el.candidate().expected_revision).toBe(7);
});

it('bounds state polling, preserves the candidate and stops on disconnection', async () => {
  mock(); const el = await mount(); vi.useFakeTimers();
  const pending = collectionStatus(); pending.formal_visibility.state = 'validating'; pending.blockers = ['SOURCE_VALIDATION_PENDING'];
  authFetch.mockResolvedValue({ ok: true, json: async () => pending });
  el.overrides = { enabled: 'disable' }; el.dirty = true; el.startPolling();
  await vi.advanceTimersByTimeAsync(30000);
  expect(el.pollLimitReached).toBe(true); expect(el.polling).toBe(false);
  expect(el.overrides).toEqual({ enabled: 'disable' }); expect(el.dirty).toBe(true);
  const calls = authFetch.mock.calls.length; await vi.advanceTimersByTimeAsync(60000); expect(authFetch.mock.calls.length).toBe(calls);
  el.startPolling(); el.remove(); await vi.advanceTimersByTimeAsync(60000); expect(authFetch.mock.calls.length).toBe(calls);
});

it('separates an applied binding from formal availability and displays global blocking', async () => {
  mock(); const el = await mount();
  const status = collectionStatus(); status.formal_visibility.state = 'pending'; status.effective_enabled.enabled = false;
  status.effective_enabled.global_enabled = false; status.effective_enabled.source = 'global'; status.blockers = ['GLOBAL_COLLECTION_DISABLED', 'AWAITING_SAMPLE'];
  el.collection = status; await el.updateComplete;
  expect(el.shadowRoot.textContent).toContain('全局采集已关闭');
  expect(el.shadowRoot.textContent).toContain('已应用'); expect(el.shadowRoot.textContent).not.toContain('正式可用');
  expect(el.terminal(status)).toBe(true);
});

it('revoked permissions clear proofs, values and write access without retrying', async () => {
  mock(); const el = await mount(); await el.execute('preview');
  const calls = authFetch.mock.calls.length;
  window.dispatchEvent(new Event('slide-permissions-loaded')); await el.updateComplete;
  expect(el.canManage).toBe(false); expect(el.collection).toBeNull(); expect(el.preview).toBeNull(); expect(el.trial).toBeNull();
  expect(el.shadowRoot.textContent).toContain('权限或登录状态已变更');
  await el.execute('publish'); expect(authFetch.mock.calls.length).toBe(calls);
});

it('does not call a malformed or failed status unbound', async () => {
  mock(); const original = authFetch.getMockImplementation()!;
  authFetch.mockImplementation((url, options) => url.endsWith('/status') ? Promise.resolve({ ok: true, json: async () => ({}) }) : original(url, options));
  const el = await mount();
  expect(el.collection).toBeNull(); expect(el.loaded).toBe(false); expect(el.canManage).toBe(false);
  expect(el.shadowRoot.textContent).not.toContain('首次绑定');
});

it('clears prior status and proofs when a status refresh revokes access', async () => {
  mock(); const el = await mount(); await el.execute('preview');
  expect(el.collection).not.toBeNull();
  authFetch.mockResolvedValue({ ok: false, status: 403, json: async () => ({ error: 'FORBIDDEN' }) });
  await el.refreshStatus();
  expect(el.collection).toBeNull(); expect(el.preview).toBeNull(); expect(el.canManage).toBe(false); expect(el.polling).toBe(false);
});
