import { afterEach, expect, it, vi } from 'vitest';
import { findSettingsRoute } from '../settings-navigation.js';
const { authFetch } = vi.hoisted(() => ({ authFetch: vi.fn() }));
vi.mock('../../../api/index.js', () => ({ authFetch }));
import './metric-configuration.js';
const settle = () => new Promise(resolve => setTimeout(resolve, 15));
afterEach(() => { document.body.replaceChildren(); authFetch.mockReset(); });
const catalog = { packages: [{ package: { id: 'mysql-basic', version: '1.0.0', digest: 'pin', resource_type: 'instance' }, recommendations: { interval_ms: 60000 } }], metrics: [] };
const mock = (manage = true) => authFetch.mockImplementation(async (url: string) => ({ ok: !(/resources\/instance\/\d+$/.test(url)), status: (/resources\/instance\/\d+$/.test(url)) ? 404 : 200,
  json: async () => url.endsWith('/catalog') ? catalog : url.endsWith('/access') ? { can_manage: manage } : url.endsWith('/preview') ? { resources: [], affected_resources: 1 } : url.endsWith('/trial') ? { decision: 'attempted', attempts: [], samples: [] } : [] }));
const mount = async () => { const el = document.createElement('metric-configuration') as any; el.resourceId = 1; document.body.append(el); await settle(); return el; };
it('preserves legacy catalog route and canonical route', () => {
  expect(findSettingsRoute('/metric-registry')?.view).toBe('legacy');
  expect(findSettingsRoute('/settings/monitoring/metrics')?.item.views?.map(v => v.id)).toEqual(['catalog', 'packages', 'policies', 'legacy']);
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
  el.shadowRoot.querySelector('input').dispatchEvent(new Event('input'));
  await settle(); expect(el.preview).toBeNull(); expect(el.trial).toBeNull();
  const call = authFetch.mock.calls.find((c: any[]) => c[0].endsWith('/trial'))!;
  expect(JSON.parse(call[1].body)).toMatchObject({ expected_revision: 0, overrides: {} });
  expect(call[1].body).not.toContain('credential');
});
it('409 clears prior proofs without retrying or overwriting revision', async () => {
  mock(); const el = await mount();
  authFetch.mockResolvedValue({ ok: false, status: 409 });
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
  authFetch.mockImplementationOnce(async () => ({ ok: true, json: async () => ({ decision: 'attempted', attempts: [{ status: 'succeeded' }], samples: [] }) }));
  await el.execute('trial'); await el.execute('publish');
  const call = authFetch.mock.calls.find((c: any[]) => c[0].endsWith('/publish'))!;
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
