import { afterEach, expect, it, vi } from 'vitest';
import { ReportsPage } from './reports.js';
import { authFetch } from '../../../api/index.js';
vi.mock('../../../api/index.js', () => ({ authFetch: vi.fn() }));
afterEach(() => { document.body.replaceChildren(); vi.resetAllMocks(); });
async function page() {
  const element = new ReportsPage();
  vi.spyOn(element, 'firstUpdated').mockImplementation(() => {});
  (element as any).loading = false;
  document.body.append(element); await element.updateComplete;
  return element as any;
}
it('re-reads loaded history without resetting an open config draft or the current range', async () => {
  const element = await page(); element.historyBatch = 2; element.configForm = { name: 'unsaved' };
  vi.mocked(authFetch).mockImplementation(async url => Response.json(String(url).endsWith('/stats') ? { total: 2 } : [{ id: String(url).includes('page=1') ? 1 : 2 }]));
  await element.refreshReadData();
  expect(element.historyBatch).toBe(2); expect(element.reports.map((report: any) => report.id)).toEqual([1, 2]);
  expect(element.configForm.name).toBe('unsaved');
});
it('cannot replace a newer history range loaded while recovery reads were in flight', async () => {
  const element = await page(); element.historyBatch = 1;
  let finish!: (response: Response) => void;
  vi.mocked(authFetch).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValue(Response.json({ total: 2 }));
  const pending = element.refreshReadData();
  element.historyBatch = 2; element.reports = [{ id: 99 }];
  finish(Response.json([{ id: 1 }]));
  // A newer range must win, so recovery must not proceed to a stats request.
  await pending;
  expect(element.historyBatch).toBe(2); expect(element.reports).toEqual([{ id: 99 }]);
});

// MAX-615 R1 / #361: failed reconciliation must never look like confirmed absence.
it.each([
  () => Promise.resolve(Response.json({ error: 'REPORT_CONFIG_LIST_UNAVAILABLE' }, { status: 503 })),
  () => Promise.reject(new Error('network unavailable')),
  () => Promise.resolve(Response.json({ invalid: true })),
])('shows unknown list state on read failure and recovers without replaying creation', async fail => {
  const element = await page();
  vi.mocked(authFetch).mockImplementationOnce(fail);
  await element.loadConfigs(); await element.updateComplete;
  expect(element.shadowRoot.querySelector('[role="alert"]').textContent).toBeTruthy();
  expect(element.shadowRoot.querySelector('app-empty-state[title="定时报表读取失败"]')).not.toBeNull();
  expect(element.shadowRoot.querySelector('app-empty-state[title="暂无定时报表"]')).toBeNull();
  const create = [...element.shadowRoot.querySelectorAll('button')].find((button: any) => button.textContent.includes('新建计划')) as HTMLButtonElement;
  expect(create.disabled).toBe(true);
  vi.mocked(authFetch).mockResolvedValueOnce(Response.json([{ id: 42, name: 'already committed', cron: '@daily', type: 'health', enabled: false }]));
  await element.loadConfigs(); await element.updateComplete;
  expect(element.shadowRoot.querySelector('[role="alert"]')).toBeNull();
  expect(element.shadowRoot.textContent).toContain('already committed');
  expect(create.disabled).toBe(false);
  expect(vi.mocked(authFetch).mock.calls.every(([, options]) => !options?.method || options.method === 'GET')).toBe(true);
});

it('keeps a healthy empty list distinct from failure', async () => {
  const element = await page();
  vi.mocked(authFetch).mockResolvedValueOnce(Response.json([]));
  await element.loadConfigs(); await element.updateComplete;
  expect(element.shadowRoot.querySelector('app-empty-state[title="暂无定时报表"]')).not.toBeNull();
  expect(element.shadowRoot.querySelector('[role="alert"]')).toBeNull();
  expect(element.shadowRoot.querySelector('button.btn-primary').disabled).toBe(false);
});
