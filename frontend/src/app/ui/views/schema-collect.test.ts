import { afterEach, expect, it, vi } from 'vitest';
import { SchemaManagementPage } from './schema-management.js';
import { authFetch } from '../../../api/index.js';

vi.mock('../../../api/index.js', () => ({ authFetch: vi.fn() }));
afterEach(() => { document.body.replaceChildren(); vi.resetAllMocks(); });

async function page() {
  const element = new SchemaManagementPage();
  vi.spyOn(element, 'firstUpdated').mockImplementation(() => {});
  document.body.append(element);
  await element.updateComplete;
  const state = element as any;
  state.instanceId = 1;
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
