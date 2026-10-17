import { afterEach, expect, it, vi } from 'vitest';
const { authFetch, showToast } = vi.hoisted(() => ({ authFetch: vi.fn(), showToast: vi.fn() }));
vi.mock('../../../api/index.js', () => ({ authFetch }));
vi.mock('../components/app-toast-container.js', () => ({ showToast }));
import './instances-db.js';
import './servers-page.js';
import './network-devices-page.js';

const response = (data: unknown, status = 200) => ({ ok: status < 400, status, json: async () => data });
afterEach(() => { document.body.replaceChildren(); localStorage.clear(); authFetch.mockReset(); showToast.mockReset(); });

it.each(['instance', 'server', 'network_device'])('%s saves a connection once and continues into the shared editor even when collection loading fails', async type => {
  localStorage.setItem('permissions', '["*"]');
  let created = false;
  const entry: any = { id: 42, name: 'task-resource', host: '192.0.2.42', port: 3306, db_type: 'mysql',
    username: 'reader', os_type: 'rhel', credential_type: 'password', snmp_version: 2, snmp_port: 161, ssh_port: 22, collection_enabled: true, vendor: 'cisco' };
  const endpoint = type === 'instance' ? '/api/database/instances' : type === 'server' ? '/api/servers' : '/api/network-devices';
  authFetch.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url.startsWith('/api/metrics/')) return response({}, 503);
    if (url === endpoint && init?.method === 'POST') { created = true; return response({ id: 42 }); }
    if (url === endpoint) return response(created ? [entry] : []);
    if (url.endsWith('/hosts')) return response({ hosts: [] });
    if (url === '/api/servers/42') return response({ ...entry, credential_username: 'reader' });
    if (url === '/api/servers') return response([]);
    return response([]);
  });
  const page = document.createElement(type === 'instance' ? 'instances-page' : type === 'server' ? 'servers-page' : 'network-devices-page') as any;
  document.body.append(page); await page.updateComplete;
  await new Promise(resolve => setTimeout(resolve, 0));
  if (type === 'instance') {
    page._addInstance(); page.formData = { ...page.formData, name: 'task-resource', host: '192.0.2.42', username: 'reader', password: 'test-only' };
    await page.updateComplete; await page._handleSubmit(false, true);
  } else if (type === 'server') {
    page._openAddDialog(); page._form = { ...page._form, host: '192.0.2.42', credential_username: 'reader', credential_value: 'test-only' };
    await page.updateComplete; await page._handleSubmit(true);
  } else {
    page.openCreate(); page.form = { ...page.form, name: 'task-resource', host: '192.0.2.42', community: 'test-only' };
    await page.updateComplete; await page.saveDevice(true);
  }
  await page.updateComplete;
  const section = page.renderRoot.querySelector('resource-collection-section') as any;
  await section.updateComplete;
  expect(section.resourceId).toBe(42); expect(section.resourceType).toBe(type);
  expect(section.renderRoot.querySelector('metric-configuration')).not.toBeNull();
  expect(authFetch.mock.calls.filter(([url, init]) => url === endpoint && init?.method === 'POST')).toHaveLength(1);
  expect(showToast).toHaveBeenCalledWith('连接信息已保存；采集配置需单独检查并发布', 'success');
  expect(showToast.mock.calls.flat().join(' ')).not.toContain('采集已启用');
});
