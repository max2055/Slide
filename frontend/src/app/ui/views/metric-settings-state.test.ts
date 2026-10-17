import { afterEach, expect, it, vi } from 'vitest';
const { authFetch } = vi.hoisted(() => ({ authFetch: vi.fn() }));
vi.mock('../../../api/index.js', () => ({ authFetch }));
import './metric-settings.js';

const response = (body: unknown, status = 200) => ({ ok: status === 200, status, json: async () => body });
const audit = { action: 'binding.publish', revision: 3, at: '2026-10-16T00:00:00Z', configuration: { package: { id: 'mysql-basic' } } };
const mock = () => authFetch.mockImplementation(async (url: string) => response(url === '/api/resources' ? { items: [] }
  : url.includes('/groups') ? { groups: [] } : url.endsWith('/catalog') ? { packages: [], metrics: [] } : [audit]));
const mount = async () => {
  const el = document.createElement('metric-settings') as any; el.view = 'audit'; document.body.append(el);
  await vi.waitFor(() => expect(el.catalog).not.toBeNull()); el.resourceId = 7;
  await vi.waitFor(() => expect(el.audits).toHaveLength(1)); await el.updateComplete; return el;
};
afterEach(() => { document.body.replaceChildren(); authFetch.mockReset(); });

it('reads resource audit, keeps revision/details, and distinguishes empty from forbidden', async () => {
  mock(); const el = await mount();
  const table = el.shadowRoot.querySelector('app-data-table'); await table.updateComplete;
  expect(table.textContent).toContain('发布资源配置'); expect(table.textContent).toContain('mysql-basic');
  expect(authFetch.mock.calls.some(c => c[0] === '/api/metrics/policy/resources/instance/7/audit')).toBe(true);
  authFetch.mockResolvedValue(response([])); await el.loadAudit(); await el.updateComplete; await table.updateComplete;
  expect(table.textContent).toContain('暂无配置变更记录');
  authFetch.mockResolvedValue(response({}, 403)); await el.loadAudit(); await el.updateComplete;
  expect(el.shadowRoot.textContent).toContain('没有此资源的操作权限');
  expect(el.shadowRoot.textContent).not.toContain('暂无配置变更记录'); expect(el.audits).toEqual([]);
});

it('discards in-flight audit and group responses after permission revocation', async () => {
  mock(); const el = await mount();
  let release!: (body: unknown) => void;
  authFetch.mockImplementation(() => new Promise(resolve => { release = resolve; }));
  const loading = el.loadAudit(); window.dispatchEvent(new Event('slide-permissions-loaded'));
  release(response([audit])); await loading;
  expect(el.audits).toEqual([]); expect(el.resourceId).toBe(0); expect(el.groupManage).toBe(false);
  const groups = el.loadGroups(); window.dispatchEvent(new Event('slide-session-expired'));
  release(response({ groups: [{ id: 'revoked', revision: 9 }] })); await groups;
  expect(el.groups).toEqual([]);
});

it('queries groups on the server and preserves the currently inherited group', async () => {
  mock(); const el = await mount();
  el.groups = [{ id: 'current', revision: 3 }]; el.groupId = 'current'; el.groupSearch = 'beyond first page';
  authFetch.mockResolvedValue(response({ groups: [{ id: 'later-match', revision: 1 }] }));
  await el.loadGroups();
  expect(authFetch.mock.calls.at(-1)?.[0]).toBe('/api/metrics/policy/groups?query=beyond%20first%20page');
  expect(el.groups.map((g: any) => g.id)).toEqual(['current', 'later-match']);
});
