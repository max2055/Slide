import { afterEach, expect, it, vi } from 'vitest';

const { authFetch, showToast } = vi.hoisted(() => ({ authFetch: vi.fn(), showToast: vi.fn() }));
vi.mock('../../../api/index.js', () => ({ authFetch }));
vi.mock('../components/app-toast-container.js', () => ({ showToast }));
import './instance-detail.js';
import './server-detail.js';

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
function deferred() {
  let resolve!: (value: any) => void;
  const promise = new Promise<any>(done => { resolve = done; });
  return { promise, resolve };
}
afterEach(() => { document.body.replaceChildren(); vi.resetAllMocks(); });

for (const boundary of ['capacity', 'history']) {
  it.each(['switch', 'revoke', 'disconnect'])(`rejects ${boundary} body after headers, then %s`, async action => {
    const el = document.createElement('instance-detail-page') as any;
    document.body.append(el); await el.updateComplete;
    el.instanceId = 1; el.activeTab = 'capacity';
    const body = deferred();
    const json = vi.fn(() => body.promise);
    authFetch.mockImplementation(async (url: string) => {
      const history = url.includes('/history');
      return { ok: true, status: 200, json: history === (boundary === 'history') ? json
        : async () => history ? { history: [] } : { total_size_gb: 1 } };
    });
    const pending = el.loadTabData(); await settle();
    expect(json).toHaveBeenCalledOnce(); // Both headers have arrived; only JSON is pending.
    if (action === 'switch') { el.instanceId = 2; el._resetEvidence(); }
    if (action === 'revoke') window.dispatchEvent(new CustomEvent('slide-permissions-loaded'));
    if (action === 'disconnect') { el.remove(); el._resetEvidence(); }
    body.resolve(boundary === 'history'
      ? { history: [{ total_size_gb: 999, recorded_at: '2026-10-15T00:00:00Z' }] }
      : { total_size_gb: 999, name: 'old-instance1' });
    await pending;
    expect(el.capacity).toBeNull();
    expect(el.capHistory).toEqual({ time: [], size: [] });
  });
}

it('commits current capacity and history after both bodies finish', async () => {
  const el = document.createElement('instance-detail-page') as any;
  el.instanceId = 1; el.activeTab = 'capacity';
  authFetch.mockImplementation(async (url: string) => ok(url.includes('/history')
    ? { history: [{ total_size_gb: 42, recorded_at: '2026-10-15T00:00:00Z' }] }
    : { total_size_gb: 42 }));
  await el.loadTabData();
  expect(el.capacity.total_size_gb).toBe(42); expect(el.capHistory.size).toEqual([42]);
});

async function mountServer() {
  // Supported OS, empty diagnostics cache. Calling the legacy GET would collect.
  authFetch.mockImplementation(async (url: string) => {
    if (url.endsWith('/diagnostics')) throw new Error('Implicit cache-miss collection');
    if (url.endsWith('/instances')) return ok({ instances: [] });
    if (url === '/api/resources/overview') return ok({ items: [] });
    return ok({ id: Number(url.split('/').at(-1)), os_type: 'rhel', host: 'isolated.invalid', status: 'offline' });
  });
  const el = document.createElement('server-detail') as any;
  el.serverId = 1; el.activeTab = 'logs'; document.body.append(el); await settle(); await el.updateComplete;
  return el;
}

it('never requests diagnostics on entry, all diagnostic tabs, refresh or resource switch with a supported OS and no cache', async () => {
  const el = await mountServer();
  expect(el.server.os_type).toBe('rhel');
  for (const tab of ['overview', 'diagnostics', 'network', 'processes', 'services', 'logs']) {
    el._applyTab(tab); await settle(); await el.refreshCurrentTab();
  }
  el.serverId = 2; await settle(); await el.updateComplete;
  expect(el.diagnostics).toBeNull(); expect(el.shadowRoot.textContent).toContain('当前页面尚未取得诊断证据');
  expect(authFetch.mock.calls.filter(([url]) => /diagnostics/.test(url))).toEqual([]);
});

it('explicit collection uses the POST evidence once, without a second cache-miss GET', async () => {
  const el = await mountServer();
  const evidence = { serverId: 1, quality: 'partial', sections: { logs: { items: [{ message: 'explicit-only' }] } } };
  authFetch.mockResolvedValue(ok({ success: true, diagnostics: evidence }));
  authFetch.mockClear();
  await el.collectDiagnostics();
  expect(authFetch.mock.calls).toEqual([['/api/servers/1/collect-diagnostics', { method: 'POST' }]]);
  expect(el.diagnostics).toEqual(evidence); expect(showToast).toHaveBeenCalledWith('诊断证据已更新', 'success');
});

it.each(['switch', 'revoke', 'disconnect'])('rejects an explicit collection body after %s', async action => {
  const el = await mountServer(); const body = deferred(); const json = vi.fn(() => body.promise);
  authFetch.mockResolvedValue({ ok: true, status: 200, json });
  const pending = el.collectDiagnostics(); await settle(); expect(json).toHaveBeenCalledOnce();
  if (action === 'switch') { el.serverId = 2; await settle(); }
  if (action === 'revoke') window.dispatchEvent(new CustomEvent('slide-session-expired'));
  if (action === 'disconnect') el.remove();
  body.resolve({ success: true, diagnostics: { serverId: 1, secret: 'old' } }); await pending;
  expect(el.diagnostics).toBeNull(); expect(showToast).not.toHaveBeenCalled();
});

it('preserves collection denial and never falls back to a view-permission GET', async () => {
  const el = await mountServer(); authFetch.mockClear();
  authFetch.mockResolvedValue({ ok: false, status: 403, json: async () => ({ error: 'PERMISSION_DENIED' }) });
  await el.collectDiagnostics();
  expect(authFetch).toHaveBeenCalledOnce(); expect(el.diagnostics).toBeNull();
  expect(showToast).toHaveBeenCalledWith('PERMISSION_DENIED', 'error');
});

for (const kind of ['server', 'instances']) {
  it.each(['switch', 'revoke', 'disconnect'])(`rejects a delayed ${kind} body after %s`, async action => {
    const el = await mountServer(); const body = deferred(); const json = vi.fn(() => body.promise);
    authFetch.mockResolvedValue({ ok: true, status: 200, json });
    const pending = kind === 'server' ? el.loadServer(1) : el.loadHostedInstances(1);
    await settle(); expect(json).toHaveBeenCalledOnce();
    // Other requests for the replacement resource may finish normally.
    authFetch.mockResolvedValue(ok(kind === 'server' ? { id: 2 } : { instances: [] }));
    if (action === 'switch') { el.serverId = 2; await settle(); }
    if (action === 'revoke') window.dispatchEvent(new CustomEvent('slide-permissions-loaded'));
    if (action === 'disconnect') el.remove();
    const before = kind === 'server' ? el.server : el.hostedInstances;
    body.resolve(kind === 'server' ? { id: 1, host: 'OLD' } : { instances: [{ instanceId: 999 }] });
    await pending;
    expect(kind === 'server' ? el.server : el.hostedInstances).toBe(before);
  });
}
