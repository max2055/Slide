import { afterEach, expect, it, vi } from 'vitest';
const { authFetch } = vi.hoisted(() => ({ authFetch: vi.fn() }));
vi.mock('../../../api/index.js', () => ({ authFetch }));
import { DatabaseLogTab } from './database-log-tab.js';
import { SemanticMetrics } from '../components/semantic-metrics.js';
const settle = () => new Promise(resolve => setTimeout(resolve, 20));
const logs = (id = 1) => ({ logs: [{ id, message: `event-${id}`, raw_content: `full-${id}`, collected_at: '2026-10-15T00:00:00Z', log_level: 'info', source: 'other' }], total: 55 });
const ok = (data: unknown) => ({ ok: true, status: 200, json: async () => data });
const stats = { total: 55, by_level: {} };
const mountLog = async () => { const el = new DatabaseLogTab() as any; el.instanceId = 1; document.body.append(el); await settle(); return el; };
afterEach(() => { document.body.replaceChildren(); vi.resetAllMocks(); });
it('requests a real second batch using the same window, clears selection and returns filters to page one', async () => {
  authFetch.mockImplementation(async (url: string) => ok(url.includes('/stats?') ? stats : logs(new URL(url, 'http://x').searchParams.get('offset') === '50' ? 51 : 1)));
  const el = await mountLog();
  el.selectedIds = new Set([1]); el.expandedId = 1;
  el.offset = 50; await el.loadLogs(); await el.updateComplete;
  const requests = authFetch.mock.calls.filter(([u]) => u.startsWith('/api/logs?')).map(([u]) => new URL(u, 'http://x'));
  expect(requests.map(u => u.searchParams.get('offset'))).toEqual(['0', '50']);
  expect(requests[1].searchParams.get('endTime')).toBe(requests[0].searchParams.get('endTime'));
  expect(el.logs[0].id).toBe(51); expect(el.selectedIds.size).toBe(0); expect(el.expandedId).toBeNull();
  el.filterLevel = 'warning'; el._handleFilterChange(); await settle();
  expect(el.offset).toBe(0); expect(authFetch.mock.calls.some(([u]) => u.includes('offset=0') && u.includes('level=warning'))).toBe(true);
});
it('rejects log and stats bodies that arrive after object change or permission invalidation', async () => {
  const bodies: ((data: unknown) => void)[] = [];
  authFetch.mockImplementation(async () => ({ ok:true, status:200, json: () => new Promise(resolve => bodies.push(resolve)) }));
  const el = await mountLog(); el.instanceId = 2; await settle();
  bodies[0](logs(999)); bodies[1](stats); await settle();
  expect(el.logs).toEqual([]); expect(el.stats).toBeNull();
  window.dispatchEvent(new CustomEvent('slide-permissions-loaded'));
  bodies.slice(2).forEach((resolve, i) => resolve(i % 2 ? stats : logs(888))); await settle();
  expect(el.logs).toEqual([]); expect(el.stats).toBeNull(); expect(el.shadowRoot.textContent).toContain('权限或登录状态已变更');
});
it('keeps pagination available when the current batch has no keyword match; fullname uses a button', async () => {
  authFetch.mockImplementation(async (url: string) => ok(url.includes('/stats?') ? stats : logs()));
  const el = await mountLog();
  const button = el.shadowRoot.querySelector('button.message-cell')!; button.click(); await el.updateComplete;
  expect(el.shadowRoot.querySelector('.raw-content').textContent).toBe('full-1');
  el.filterKeyword = 'does-not-match'; await el.updateComplete;
  expect(el.shadowRoot.textContent).toContain('下一页'); expect(el.shadowRoot.textContent).toContain('关键字仅过滤本批');
});
it('invalidates stats failure and makes authorization denial clear all evidence', async () => {
  authFetch.mockImplementation(async (url: string) => ok(url.includes('/stats?') ? stats : logs())); const el = await mountLog();
  authFetch.mockResolvedValue({ok:false,status:503}); await el.loadStats(); expect(el.stats).toBeNull();
  authFetch.mockResolvedValue({ok:false,status:403}); await el.loadLogs(); await el.updateComplete;
  expect(el.logs).toEqual([]); expect(el.selectedIds.size).toBe(0); expect(el.shadowRoot.textContent).toContain('权限');
});
it('clears previous metric time-window values during a new query and rejects permission-late data', async () => {
  const data = { profile:{columns:[]}, window:{from:'2026-10-15T00:00:00Z',to:'2026-10-15T01:00:00Z'}, metrics:[] };
  authFetch.mockResolvedValue(ok(data)); const el = new SemanticMetrics(); el.resourceId = 1; document.body.append(el); await settle();
  let finish!: (value: unknown) => void;
  authFetch.mockImplementation(() => new Promise(resolve => finish = resolve));
  const select = el.shadowRoot!.querySelector('select')!; select.value='6'; select.dispatchEvent(new Event('change')); await el.updateComplete;
  expect(el.result).toBeNull();
  window.dispatchEvent(new CustomEvent('slide-session-expired')); finish(ok(data)); await settle();
  expect(el.result).toBeNull(); expect(el.error).toContain('权限或登录状态');
});

it('network clears old interfaces and backups, rejects delayed bodies on resource switch and revocation', async () => {
  await import('./network-device-detail.js');
  let finish!: (data: unknown) => void;
  authFetch.mockImplementation(async (url: string) => {
    if (url.endsWith('/interfaces')) return { ok:true, json:() => new Promise(resolve=>finish=resolve) };
    if (url.endsWith('/relations')) return ok({relations:[]});
    if (url.endsWith('/config-backups')) return ok({backups:[]});
    if (url.endsWith('/backup-schedule')) return ok({enabled:false,dailyTime:'00:00'});
    if (url==='/api/resources/overview') return ok({items:[]});
    return ok({id:Number(url.split('/').at(-1)),name:'fixture',host:'isolated.invalid',vendor:'huawei',status:'unknown'});
  });
  const el=document.createElement('network-device-detail') as any;el.deviceId=1;document.body.append(el);await settle();
  const pending=el.loadInterfaces();await settle();el.deviceId=2;await settle();finish({interfaces:[{ifName:'OLD-INTERFACE'}]});await pending;await settle();
  expect(el.interfaces).toEqual([]);expect(el.selectedBackup).toBeNull();
  const next=el.loadInterfaces();await settle();window.dispatchEvent(new CustomEvent('slide-session-expired'));finish({interfaces:[{ifName:'REVOKED-INTERFACE'}]});await next;await settle();
  expect(el.interfaces).toEqual([]);expect(el.device).toBeNull();expect(el.textContent).toContain('权限或登录状态');
});

it('server clears diagnostic evidence and rejects late server reads after a switch', async () => {
  await import('./server-detail.js');
  let finish!: (data: unknown) => void;
  authFetch.mockImplementation(async (url:string)=>{
    if(url==='/api/servers/1') return {ok:true,json:()=>new Promise(resolve=>finish=resolve)};
    if(url.endsWith('/instances')) return ok({instances:[]});
    if(url==='/api/resources/overview') return ok({items:[]});
    return ok({id:2,host:'new.invalid',status:'offline',os_type:'Linux'});
  });
  const el=document.createElement('server-detail') as any;el.serverId=1;document.body.append(el);await settle();el.diagnostics={secret:'old'};
  el.serverId=2;await settle();finish({id:1,host:'OLD.invalid'});await settle();
  expect(el.server.id).toBe(2);expect(el.diagnostics).toBeNull();
  window.dispatchEvent(new CustomEvent('slide-permissions-loaded'));await settle();expect(el.server).toBeNull();
});
