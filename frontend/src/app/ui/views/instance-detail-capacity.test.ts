import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'lit';
import { authFetch } from '../../../api/index.js';
import { InstanceDetailPage } from './instance-detail.js';
vi.mock('../../../api/index.js', () => ({ authFetch: vi.fn() }));
const fetchMock = vi.mocked(authFetch);
const capacity = { total_size_gb: 10, top_tables: [] };
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
function page() { const el = new InstanceDetailPage() as any; el.instanceId = 1; el.activeTab = 'capacity'; return el; }
function content(el: any, diagnosis = false) {
  const root = document.createElement('div');
  render(diagnosis ? el._renderDiagnosisHistory() : el._renderCapacity(), root, { host: el });
  return root;
}
afterEach(() => fetchMock.mockReset());
describe('MAX-529 / #661 capacity and diagnosis history failures', () => {
  it.each([401, 403, 500])('HTTP %s is a visible failure with retry', async status => {
    fetchMock.mockImplementation(async url => String(url).includes('/capacity/history') ? response({ history: [] }) : response({}, status));
    const el = page(); await el.loadTabData();
    expect(content(el).textContent).toContain(`HTTP ${status}`);
    expect(content(el).textContent).not.toContain('暂无容量数据');
    expect(content(el).querySelector('button')?.textContent).toContain('重试');
    await el.loadDiagnosisHistory();
    expect(content(el, true).textContent).toContain(`HTTP ${status}`);
    expect(content(el, true).querySelector('button')?.textContent).toContain('重试');
  });
  it('network failures are visible and retries recover both reads', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    const el = page(); await el.loadTabData(); await el.loadDiagnosisHistory();
    expect(content(el).textContent).toContain('网络或服务');
    expect(content(el, true).textContent).toContain('网络或服务');
    fetchMock.mockImplementation(async url => String(url).includes('/capacity/history') ? response({ history: [] }) : String(url).includes('/analysis/history') ? response({ records: [] }) : response(capacity));
    content(el).querySelector('button')!.click();
    content(el, true).querySelector('button')!.click();
    await vi.waitFor(() => { expect(el.capacityLoading).toBe(false); expect(el.diagnosisHistoryLoading).toBe(false); });
    expect(content(el).textContent).toContain('10.00 GiB');
    expect(content(el).textContent).not.toContain('失败');
    expect(el.diagnosisHistoryError).toBe('');
  });
  it('preserves current capacity when historical sampling fails', async () => {
    fetchMock.mockImplementation(async url => String(url).includes('/history') ? response({}, 503) : response(capacity));
    const el = page(); await el.loadTabData();
    expect(content(el).textContent).toContain('容量历史读取失败（HTTP 503）');
    expect(content(el).textContent).toContain('10.00 GiB');
  });
  it('keeps a verified detail visible when current total is unknown', async () => {
    fetchMock.mockImplementation(async url => String(url).includes('/history')
      ? response({ history: [] })
      : response({ ...capacity, total_size_gb: undefined, details_unavailable: true,
        top_tables: [{ name: 'known-detail', size_gb: 0 }] }));
    const el = page(); await el.loadTabData();
    expect(content(el).textContent).toContain('容量总量未知');
    expect(content(el).textContent).toContain('部分容量明细读取失败');
    expect(content(el).textContent).toContain('已保存的容量样本');
    expect(content(el).textContent).toContain('known-detail');
    expect(content(el).textContent).toContain('0.00 GiB');
  });
  it('shows loading before an empty successful response, with no false error', async () => {
    let finish!: (r: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValue(response({ history: [] }));
    const el = page(); const pending = el.loadTabData();
    expect(content(el).textContent).toContain('加载中');
    finish(response(null)); await pending;
    expect(content(el).querySelector('app-empty-state')?.getAttribute('title')).toBe('暂无容量数据');
    expect(el.capacityError).toBe('');
  });
  it.each(['loadCapacity', 'loadDiagnosisHistory'])('%s ignores superseded and different-instance responses', async method => {
    let finish!: (r: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockImplementation(async url => String(url).includes('/capacity/history') ? response({ history: [] }) : method === 'loadCapacity' ? response(capacity) : response({ records: [] }));
    const el = page(); const pending = el[method]();
    await el[method](); finish(response({}, 500)); await pending;
    expect(method === 'loadCapacity' ? el.capacityError : el.diagnosisHistoryError).toBe('');
    fetchMock.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const other = el[method](); el.instanceId = 2; el.contextVersion++; el._resetEvidence();
    finish(response({}, 403)); await other;
    expect(el.capacity).toBeNull(); expect(el.diagnosisHistory).toEqual([]);
    expect(el.capacityError).toBe(''); expect(el.diagnosisHistoryError).toBe('');
  });
});
