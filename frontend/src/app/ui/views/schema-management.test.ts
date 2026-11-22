import { afterEach, expect, it, vi } from 'vitest';
import { SchemaManagementPage } from './schema-management.js';
import { authFetch } from '../../../api/index.js';
vi.mock('../../../api/index.js', () => ({ authFetch: vi.fn() }));
afterEach(() => { document.body.replaceChildren(); vi.resetAllMocks(); });
const reply = (data: unknown, status = 200) => Response.json(data, { status });
const hint = '需要至少两次快照才能进行变更检测';
function deferred() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>(done => { resolve = done; });
  return { promise, resolve };
}
async function mount() {
  vi.mocked(authFetch).mockImplementation(async url => {
    if (String(url) === '/api/database/instances') return reply([{ id: 1, name: 'one' }, { id: 2, name: 'two' }]);
    if (String(url).includes('/snapshot/')) return reply({ tables: [{ table_name: `table-${String(url).at(-1)}`, data_length: null, table_rows: 1, column_count: 1 }] });
    if (String(url).includes('/snapshots/')) return reply([{ tables: Number(String(url).at(-1)) }]);
    return reply({ changes: [{ table_name: `change-${String(url).at(-1)}` }] });
  });
  const view = new SchemaManagementPage() as any;
  view.instanceId = 1;
  document.body.append(view);
  await vi.waitFor(() => expect(view.tableList[0]?.table_name).toBe('table-1'));
  await view.updateComplete;
  return view;
}
it('#676 reloads tables, snapshots and changes when the bound instance changes', async () => {
  const view = await mount();
  view.expandedTable = 'old'; view.tableDetail = [{}]; view.hint = hint;
  view.collectResult = { tables: 99 }; view.tableBrowser.page = 5;
  view.instanceId = 2;
  await vi.waitFor(() => expect(view.tableList[0]?.table_name).toBe('table-2'));
  expect(view.snapshotTimes[0].tables).toBe(2);
  expect(view.changes[0].table_name).toBe('change-2');
  expect(view.selectedInstanceName).toBe('two');
  expect(view.hint).toBeNull(); expect(view.collectResult).toBeNull();
  expect(view.expandedTable).toBeNull(); expect(view.tableDetail).toEqual([]);
  expect(view.tableBrowser.page).toBe(1);
  expect(view._formatBytes(null)).toBe('不可用');
});
it.each(['loadSnapshotTimes', 'loadTableList', 'loadChanges', 'handleCollect', 'handleDetect', 'handleTableClick'])('#676 discards late %s responses across A → B → A', async method => {
  const view = await mount();
  const gate = deferred();
  vi.mocked(authFetch).mockImplementationOnce(() => gate.promise);
  const pending = view[method]('old-table');
  view.instanceId = 2; await view.updateComplete;
  await vi.waitFor(() => expect(view.tableList[0]?.table_name).toBe('table-2'));
  view.instanceId = 1; await view.updateComplete;
  await vi.waitFor(() => expect(view.tableList[0]?.table_name).toBe('table-1'));
  gate.resolve(reply({ success: true, tables: [{ table_name: 'stale' }], changes: [{ table_name: 'stale' }], hint: 'stale', data: { tables: 99 } }));
  await pending;
  expect(view.tableList[0].table_name).toBe('table-1');
  expect(view.snapshotTimes[0].tables).toBe(1);
  expect(view.changes[0].table_name).toBe('change-1');
  expect(view.collectResult).toBeNull(); expect(view.hint).toBeNull();
  expect(view.tableDetail).toEqual([]); expect(view.error).toBeNull();
  expect(view.collecting).toBe(false); expect(view.detecting).toBe(false);
});
it.each(['handleCollect', 'handleDetect'])('#676 discards late %s failure without releasing the new operation', async method => {
  const view = await mount(); const old = deferred(); const current = deferred();
  vi.mocked(authFetch).mockImplementationOnce(() => old.promise);
  const pending = view[method]();
  view.instanceId = 2; await view.updateComplete;
  await vi.waitFor(() => expect(view.tableList[0]?.table_name).toBe('table-2'));
  vi.mocked(authFetch).mockImplementationOnce(() => current.promise);
  const newPending = view[method]();
  old.resolve(reply({ error: 'old forbidden' }, 403)); await pending;
  expect(view.error).toBeNull();
  expect(method === 'handleCollect' ? view.collecting : view.detecting).toBe(true);
  current.resolve(reply({ success: true, changes: [], data: { tables: 2 } })); await newPending;
  expect(view.collecting).toBe(false); expect(view.detecting).toBe(false);
});
it('#677 renders an insufficient-snapshot hint and clears it after successful detection', async () => {
  const view = await mount();
  vi.mocked(authFetch).mockResolvedValueOnce(reply({ success: true, changes: [], hint }));
  await view.handleDetect(); await view.updateComplete;
  expect(view.shadowRoot.querySelector('[role="status"]').textContent).toContain(hint);
  vi.mocked(authFetch).mockResolvedValueOnce(reply({ success: true, changes: [{ table_name: 'updated', target: 'table', type: 'added' }] }));
  await view.handleDetect(); view.activeTab = 'changes'; await view.updateComplete;
  expect(view.shadowRoot.textContent).not.toContain(hint);
  expect(view.shadowRoot.textContent).toContain('updated');
});
it('#677 a late initial read cannot overwrite an explicit detection result', async () => {
  const view = await mount(); const gate = deferred();
  vi.mocked(authFetch).mockImplementationOnce(() => gate.promise);
  const initial = view.loadChanges();
  vi.mocked(authFetch).mockResolvedValueOnce(reply({ success: true, changes: [], hint }));
  await view.handleDetect();
  gate.resolve(reply({ changes: [{ table_name: 'old' }] })); await initial;
  expect(view.hint).toBe(hint); expect(view.changes).toEqual([]);
});
it.each([[null, '0', 'NULL → 0'], ['0', null, '0 → NULL'], ['', 'value', '"" → value'], ['value', '', 'value → ""'], [null, '', 'NULL → ""'], ['', null, '"" → NULL'], [0, false, '0 → false']])('#678 displays both default values for %j → %j', async (old, next, expected) => {
  const view = await mount();
  view.activeTab = 'changes';
  view.changes = [{ type: 'modified', target: 'column', table_name: 't', column_name: 'c', details: { column_default: { old, new: next } } }];
  await view.updateComplete;
  expect(view.shadowRoot.querySelector('.change-detail').textContent).toContain(`column_default: ${expected}`);
  expect(view._changeDetails({})).toBe('');
  expect(view._changeDetails({ details: {} })).toBe('');
});
it.each([403, 503])('#676 clears the former table on HTTP %s and recovers explicitly', async status => {
  const view = await mount();
  vi.mocked(authFetch).mockResolvedValueOnce(reply({}, status));
  await view.loadTableList(); expect(view.tableList).toEqual([]); expect(status === 403 ? view.schemaAccessError : view.tablesError).toBeTruthy();
  if (status === 403) await view.refreshData(); else await view.loadTableList();
  expect(view.tableList[0].table_name).toBe('table-1'); expect(view.tablesError).toBeNull();
});
