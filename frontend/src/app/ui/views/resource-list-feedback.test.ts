import { afterEach, expect, it, vi } from 'vitest';
const { authFetch } = vi.hoisted(() => ({ authFetch: vi.fn() }));
vi.mock('../../../api/index.js', () => ({ authFetch }));
vi.mock('../components/app-toast-container.js', () => ({ showToast: vi.fn() }));
import './instances-db.js';
import './servers-page.js';
import './network-devices-page.js';

const response = (data: unknown, status = 200) => ({ ok: status === 200, status, json: async () => data });
afterEach(() => { document.body.replaceChildren(); sessionStorage.clear(); authFetch.mockReset(); });
const cases = [
  ['instances-page', '/api/database/instances', { id: 1, name: 'db', host: 'db.invalid', db_type: 'mysql', health_status: 'unknown' }],
  ['servers-page', '/api/servers', { id: 1, label: '192.0.2.1', host: '192.0.2.1', os_type: 'kylin', status: 'offline' }],
  ['network-devices-page', '/api/network-devices', { id: 1, name: 'switch', host: 'switch.invalid', status: 'unknown' }],
] as const;

it.each(cases)('%s has one refresh for inventory and stored metrics, and columns in the search toolbar', async (tag, endpoint, entry) => {
  let finish: ((value: unknown) => void) | undefined;
  let holdMetrics = false;
  authFetch.mockImplementation(async (url: string) => {
    if (url === '/api/resources/overview') return response({ items: [] });
    if (url === endpoint) return response([entry]);
    if (url === '/api/metrics/query') return holdMetrics ? new Promise(resolve => { finish = resolve; }) : response({}, 503);
    throw new Error(`Unexpected request ${url}`);
  });
  const page = document.createElement(tag) as any;
  document.body.append(page);
  const root = page.renderRoot;
  await vi.waitFor(() => expect(root.querySelector('resource-metrics-table')?.shadowRoot.querySelector('app-data-table')?.rows).toHaveLength(1));
  const refresh = root.querySelector('.btn-refresh') as HTMLButtonElement;
  await vi.waitFor(() => expect(refresh.disabled).toBe(false));
  const table = root.querySelector('resource-metrics-table');
  expect(table.shadowRoot.querySelector('.toolbar')).toBeNull();
  expect(table.shadowRoot.querySelector('.btn-refresh')).toBeNull();
  const columns = [...root.querySelectorAll('.resource-toolbar button')].find((el: any) => el.textContent.trim() === '列设置') as HTMLButtonElement;
  expect(columns).toBeTruthy();
  expect(columns.closest('.resource-toolbar')?.querySelector('input')).toBeTruthy();
  // Same IDs and metadata must still re-read stored metrics, without remounting.
  authFetch.mockClear(); holdMetrics = true;
  refresh.click();
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  expect(root.querySelector('resource-metrics-table')).toBe(table);
  expect(refresh.disabled).toBe(true);
  finish!(response({}, 503));
  await vi.waitFor(() => expect(refresh.disabled).toBe(false));
  expect(authFetch.mock.calls.map(call => call[0])).toEqual(tag === 'instances-page' ? [endpoint, '/api/resources/overview', '/api/metrics/query'] : [endpoint, '/api/metrics/query']);
  expect(table.shadowRoot.querySelector('app-data-table').columns.slice(0, 2).map((c: any) => c.label)).toEqual(['选择', '序号']);
  if (tag === 'servers-page') {
    const cell = table.shadowRoot.querySelector('app-data-table tbody td:nth-child(3)');
    expect(cell.textContent.match(/192\.0\.2\.1/g)).toHaveLength(1);
  }
  if (tag === 'network-devices-page') expect(table.shadowRoot.querySelector('app-data-table tbody .btn-ghost')).toBeTruthy();
});
