import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'lit';
import { authFetch } from '../../../api/index.js';
import { InstanceDetailPage } from './instance-detail.js';
vi.mock('../../../api/index.js', () => ({ authFetch: vi.fn() }));
const fetchMock = vi.mocked(authFetch);
const roots: HTMLElement[] = [];
function page(tab = 'topsql') {
  const el = new InstanceDetailPage() as any;
  el.instanceId = 1; el.activeTab = tab;
  return el;
}
async function text(el: any) {
  const root = document.createElement('div'); roots.push(root);
  render(el.activeTab === 'sessions' ? el._renderSessions() : el._renderTopSQL(), root);
  await Promise.all(Array.from(root.querySelectorAll('app-empty-state'), (e: any) => e.updateComplete));
  return root.textContent ?? '';
}
afterEach(() => { vi.restoreAllMocks(); fetchMock.mockReset(); roots.forEach(r => r.remove()); roots.length = 0; });
describe('instance query read states', () => {
  it('does not infer health before any read', async () => {
    const content = await text(page());
    expect(content).not.toContain('数据库运行良好'); expect(content).toContain('尚未读取');
  });
  it.each(['topsql', 'sessions'])('%s empty success retains source and window without health inference', async tab => {
    fetchMock.mockResolvedValue(new Response('[]'));
    const el = page(tab); await el.loadTabData();
    const content = await text(el);
    expect(content).toContain('未返回'); expect(content).toContain('来源'); expect(content).toContain('时间范围');
    expect(content).not.toContain('数据库运行良好'); expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it.each([403, 404, 500])('HTTP %s does not become an empty success', async status => {
    fetchMock.mockResolvedValue(new Response('{}', { status }));
    const el = page(); await el.loadTabData();
    const content = await text(el);
    expect(content).toContain(status === 403 ? '无权' : status === 404 ? '不可用' : '失败');
    expect(content).not.toContain('暂无慢查询'); expect(content).not.toContain('数据库运行良好');
  });
  it.each(['null', '{}', '{"error":"unavailable"}'])('rejects malformed success %s', async body => {
    fetchMock.mockResolvedValue(new Response(body));
    const el = page('sessions'); await el.loadTabData(); expect(await text(el)).toContain('失败');
  });
  it('shows loading and a network failure rather than old data', async () => {
    let fail!: (error: Error) => void;
    fetchMock.mockImplementation(() => new Promise((_, reject) => { fail = reject; }));
    const el = page('sessions'); const pending = el.loadTabData();
    expect(await text(el)).toContain('加载'); fail(new Error('offline')); await pending;
    expect(await text(el)).toContain('失败');
  });
  it('labels an aged read as expired without implying health', async () => {
    vi.useFakeTimers();
    try {
      fetchMock.mockResolvedValue(new Response('[]')); const el = page(); await el.loadTabData();
      vi.setSystemTime(Date.now() + 120_000);
      expect(await text(el)).toContain('已过期'); expect(await text(el)).not.toContain('数据库运行良好');
    } finally { vi.useRealTimers(); }
  });
  it('ignores an older response and a response for a different instance', async () => {
    let finish!: (r: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const el = page(); const first = el.loadTabData();
    el.instanceId = 2; fetchMock.mockResolvedValue(new Response('[]')); await el.loadTabData();
    finish(new Response('[{"id":"old","sql_text":"old instance SQL"}]')); await first;
    expect(await text(el)).not.toContain('old instance SQL');
  });
});
