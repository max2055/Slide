import { afterEach, expect, it, vi } from 'vitest';
import { SchemaManagementPage } from './schema-management.js';
import { authFetch } from '../../../api/index.js';

vi.mock('../../../api/index.js', () => ({ authFetch: vi.fn() }));
afterEach(() => { document.body.replaceChildren(); vi.resetAllMocks(); });

async function page() {
  const element = new SchemaManagementPage();
  vi.spyOn(element, 'firstUpdated').mockImplementation(() => {});
  element.instanceId = 1;
  document.body.append(element);
  await element.updateComplete;
  const state = element as any;
  state.loading = false;
  return state;
}

// #438: every terminal response must release loading, without replaying a POST.
it.each([
  ['503', () => Promise.resolve(Response.json({ error: 'unavailable' }, { status: 503 })), 'unavailable'],
  ['403', () => Promise.resolve(Response.json({ error: 'forbidden' }, { status: 403 })), 'forbidden'],
  ['HTTP invalid JSON', () => Promise.resolve(new Response('<html>', { status: 503 })), 'HTTP 503'],
  ['network', () => Promise.reject(new Error('offline')), 'offline'],
  ['invalid JSON', () => Promise.resolve(new Response('{')), /JSON/],
  ['business failure', () => Promise.resolve(Response.json({ success: false, error: '采集失败' })), '采集失败'],
] as const)('%s allows an explicit retry after failure', async (_, response, error) => {
  const element = await page();
  const existing = [{ table_name: 'existing', table_rows: 1, data_length: 10, column_count: 2 }];
  element.tableList = existing;
  vi.mocked(authFetch).mockImplementationOnce(response);
  const refresh = vi.spyOn(element, 'refreshData').mockResolvedValue(undefined);
  await element.handleCollect();
  await element.updateComplete;
  expect(element.collecting).toBe(false);
  expect(element.error).toEqual(error instanceof RegExp ? expect.stringMatching(error) : error);
  expect(element.shadowRoot.querySelector('.btn-primary').disabled).toBe(false);
  expect(element.tableList).toEqual(existing);
  expect(authFetch).toHaveBeenCalledTimes(1);
  expect(refresh).not.toHaveBeenCalled();

  const result = { collected: 1, tables: 1, columns: 2 };
  vi.mocked(authFetch).mockResolvedValueOnce(Response.json({ success: true, data: result }));
  await element.handleCollect();
  expect(authFetch).toHaveBeenCalledTimes(2);
  expect(element.collecting).toBe(false);
  expect(element.collectResult).toEqual(result);
  expect(refresh).toHaveBeenCalledTimes(1);
});

it('keeps loading until the successful collection refresh finishes', async () => {
  const element = await page();
  let finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  vi.spyOn(element, 'refreshData').mockReturnValue(gate);
  vi.mocked(authFetch).mockResolvedValue(Response.json({ success: true, data: { tables: 2, columns: 3 } }));
  const pending = element.handleCollect();
  await vi.waitFor(() => expect(element.collectResult).toEqual({ tables: 2, columns: 3 }));
  expect(element.collecting).toBe(true);
  finish();
  await pending;
  expect(element.collecting).toBe(false);
  expect(authFetch).toHaveBeenCalledTimes(1);
});

it('#558 renders unavailable size distinctly from measured zero', async () => {
  const element = await page();
  element.tableList = [
    { table_name: 'unknown', data_length: null, table_rows: 0, column_count: 1 },
    { table_name: 'empty', data_length: 0, table_rows: 0, column_count: 1 },
    { table_name: 'allocated', data_length: 131072, table_rows: 1, column_count: 1 },
  ];
  await element.updateComplete;
  const rows = [...element.shadowRoot.querySelectorAll('tbody tr')].map((r: any) => r.textContent);
  expect(rows.find((r: string) => r.includes('unknown'))).toContain('不可用');
  expect(rows.find((r: string) => r.includes('empty'))).toContain('0 B');
  expect(rows.find((r: string) => r.includes('allocated'))).toContain('128 KB');
});
