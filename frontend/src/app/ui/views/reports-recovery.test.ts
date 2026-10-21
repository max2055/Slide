import { afterEach, expect, it, vi } from 'vitest';
import { ReportsPage } from './reports.js';
import { authFetch } from '../../../api/index.js';
vi.mock('../../../api/index.js', () => ({ authFetch: vi.fn() }));
afterEach(() => { document.body.replaceChildren(); vi.resetAllMocks(); });
async function page() {
  const element = new ReportsPage();
  vi.spyOn(element, 'firstUpdated').mockImplementation(() => {});
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
