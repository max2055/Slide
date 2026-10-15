import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'lit';
import { authFetch } from '../../../api/index.js';
import { InstanceDetailPage } from './instance-detail.js';
import { ServerDetailPage } from './server-detail.js';
vi.mock('../../../api/index.js', () => ({ authFetch: vi.fn() }));
vi.mock('../components/app-toast-container.js', () => ({ showToast: vi.fn() }));
const fetchMock = vi.mocked(authFetch);
const roots: HTMLElement[] = [];
function detail(kind: string) {
  const el = (kind === 'instance' ? new InstanceDetailPage() : new ServerDetailPage()) as any;
  if (kind === 'instance') el.instanceId = 1; else el.serverId = 1;
  el.activeTab = 'overview';
  return el;
}
function response(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status }); }
afterEach(() => { vi.restoreAllMocks(); fetchMock.mockReset(); roots.forEach(r => r.remove()); roots.length = 0; });
describe.each(['instance', 'server'])('%s detail read time', kind => {
  it('does not record a success on initial HTTP failure', async () => {
    fetchMock.mockResolvedValue(response({}, 500)); const el = detail(kind);
    await (kind === 'instance' ? el.loadData() : el.loadServerContext(1));
    expect(el.lastUpdated).toBeNull();
  });
  it.each([403, 500, 'network', 'malformed'])('failed refresh %s preserves the last successful read', async status => {
    const el = detail(kind); const previous = new Date('2026-10-14T01:00:00Z');
    el.lastUpdated = previous;
    if (status === 'network') fetchMock.mockRejectedValue(new Error('offline'));
    else if (status === 'malformed') fetchMock.mockResolvedValue(new Response('not-json'));
    else fetchMock.mockResolvedValue(response({}, Number(status)));
    await el.refreshCurrentTab();
    expect(el.lastUpdated).toEqual(previous);
  });
  it('labels the successful detail read separately from resource observation', () => {
    const el = detail(kind); el.loading = false;
    const row = { id: 1, host: 'fixture.invalid', status: 'online', health_status: 'unknown' };
    if (kind === 'instance') el.instance = row; else el.server = row;
    el.lastUpdated = new Date('2026-10-14T01:00:00Z');
    const root = document.createElement('div'); roots.push(root); render(el.render(), root);
    expect(root.querySelector('.last-updated')!.textContent).toContain('详情成功读取');
    expect(root.querySelector('.last-updated')!.textContent).toContain('非资源观测');
  });
  it('ignores a refresh response after switching resources', async () => {
    const el = detail(kind); let finish!: (value: Response) => void;
    fetchMock.mockImplementation((url: string) => url.endsWith('/instances') ? Promise.resolve(response({ instances: [] })) : new Promise(resolve => { finish = resolve; }));
    const pending = el.refreshCurrentTab();
    if (kind === 'instance') el.instanceId = 2; else { el.serverId = 2; el.contextVersion++; }
    finish(response({ id: 1, host: 'old.invalid' })); await pending;
    expect(el.lastUpdated).toBeNull();
    expect(kind === 'instance' ? el.instance : el.server).toBeNull();
  });
});
