import { describe, expect, it, vi, beforeEach } from 'vitest';
const { authFetch, get } = vi.hoisted(() => ({ authFetch: vi.fn(), get: vi.fn() }));
vi.mock('../../../api/index.js', () => ({ authFetch, apiClient: { get } }));
import { SchemaManagementPage } from './schema-management.js';
import { IndexManagementPage } from './index-management.js';
import { PermissionManagementTab } from './rbac-page.js';
import { ReportsPage } from './reports.js';
import { ListBrowser } from '../components/list-browser.js';
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
beforeEach(() => { authFetch.mockReset(); get.mockReset(); });

describe('list failure and compatibility', () => {
  it.each([403, 503])('clears prior schema snapshot on HTTP %s, then recovers', async status => {
    const view = new SchemaManagementPage() as any; view.selectedInstance = 1;
    authFetch.mockResolvedValueOnce(response({ tables: [{ table_name: 'private-old' }] })).mockResolvedValueOnce(response({}, status)).mockResolvedValueOnce(response({ tables: [] }));
    await view.loadTableList(); expect(view.tableList).toHaveLength(1);
    await view.loadTableList(); expect(view.tableList).toEqual([]); expect(view.tablesError).toBeTruthy();
    await view.loadTableList(); expect(view.tablesError).toBeNull(); expect(view.tableList).toEqual([]);
  });
  it('rejects a late schema response from a prior instance', async () => {
    const view = new SchemaManagementPage() as any; view.selectedInstance = 1;
    let resolve!: (r: Response) => void;
    authFetch.mockImplementationOnce(() => new Promise(r => { resolve = r; })).mockResolvedValueOnce(response({ tables: [{ table_name: 'current' }] }));
    const first = view.loadTableList(); view.selectedInstance = 2; await view.loadTableList();
    resolve(response({ tables: [{ table_name: 'private-old' }] })); await first;
    expect(view.tableList[0].table_name).toBe('current');
  });
  it('accepts the existing single-snapshot hint envelope without crashing the table page', async () => {
    const view = new SchemaManagementPage() as any; view.selectedInstance = 1;
    authFetch.mockResolvedValue(response({ changes: { hint: '需要至少两次快照才能进行变更检测' } }));
    await view.loadChanges(); expect(view.changes).toEqual([]); expect(view.hint).toContain('至少两次');
  });
  it('groups composite indexes by table and orders columns by sequence', () => {
    const view = new IndexManagementPage() as any;
    view.indexes = [{ table_name: 'a', index_name: 'PRIMARY', column_name: 'second', seq_in_index: 2 }, { table_name: 'b', index_name: 'PRIMARY', column_name: 'other', seq_in_index: 1 }, { table_name: 'a', index_name: 'PRIMARY', column_name: 'first', seq_in_index: 1 }];
    const groups = [...view.getGroupedIndexes().values()] as any[];
    expect(groups).toHaveLength(2); expect(groups[0].map((row: any) => row.column_name)).toEqual(['first', 'second']);
    view.selectedTable = 'b'; expect(view.getGroupedIndexes().size).toBe(1);
  });
  it('clears all index sections on a partial fetch failure', async () => {
    const view = new IndexManagementPage() as any; view.selectedInstanceId = 1;
    view.indexes = view.unusedIndexes = view.redundancyReport = [{ table_name: 'private-old' }];
    authFetch.mockResolvedValueOnce(response([])).mockResolvedValueOnce(response({}, 403)).mockResolvedValueOnce(response([]));
    await view.loadIndexes(); expect(view.indexes).toEqual([]); expect(view.unusedIndexes).toEqual([]); expect(view.redundancyReport).toEqual([]); expect(view.indexError).toContain('无权限');
  });
  it('clears permissions after revoked access', async () => {
    const view = new PermissionManagementTab() as any; view.permissions = [{ code: 'private-old' }]; get.mockRejectedValue(new Error('HTTP 403'));
    await view._loadPermissions(); expect(view.permissions).toEqual([]); expect(view.error).toContain('403');
  });
  it('reads subsequent report batches and invalidates the loaded history on failure', async () => {
    const view = new ReportsPage() as any;
    authFetch.mockResolvedValueOnce(response([{ id: 1, name: 'first' }])).mockResolvedValueOnce(response([{ id: 2, name: 'second' }])).mockResolvedValueOnce(response({}, 403));
    await view.loadReports(); await view.loadReports(true);
    expect(authFetch.mock.calls.map(c => c[0])).toEqual(['/api/reports?page=1&limit=100', '/api/reports?page=2&limit=100']);
    expect(view.reports).toHaveLength(2); await view.loadReports(true); expect(view.reports).toEqual([]); expect(view.error).toContain('无权限');
  });
  it('keeps searching available after data shrink and clamps an obsolete page', () => {
    const browser = new ListBrowser(); browser.page = 5;
    expect(browser.select([{ name: 'remaining' }], row => row.name, row => row.name).rows).toHaveLength(1);
    expect(browser.page).toBe(1); browser.query = 'absent'; expect(browser.select([{ name: 'remaining' }], row => row.name, row => row.name).total).toBe(0);
  });
});
