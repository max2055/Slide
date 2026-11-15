import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { authFetch, showToast } = vi.hoisted(() => ({ authFetch: vi.fn(), showToast: vi.fn() }));
vi.mock('../../../api/index.js', () => ({ authFetch }));
vi.mock('../components/app-toast-container.js', () => ({ showToast }));
import './server-detail.js';

const response = (body = {}, ok = true) => ({ ok, json: async () => body });
const deferred = () => {
  let resolve!: (value: any) => void, reject!: (reason: Error) => void;
  const promise = new Promise<any>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
async function settle(view: any) {
  await view.updateComplete;
  await new Promise(done => setTimeout(done, 0));
  await view.updateComplete;
}
async function mount() {
  const view = document.createElement('server-detail') as any;
  view.serverId = 9; document.body.append(view); await settle(view); return view;
}
const button = (view: any) => [...view.shadowRoot.querySelectorAll('button')].find((b: any) => /巡检/.test(b.textContent)) as HTMLButtonElement;

describe('MAX-558 one click inspection', () => {
  let requests: ReturnType<typeof deferred>[];
  let navigation: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    requests = []; showToast.mockReset(); authFetch.mockReset(); navigation = vi.fn();
    window.addEventListener('slide-navigate', navigation);
    authFetch.mockImplementation(async (url: string) => {
      if (url === '/api/servers/reports/generate') {
        const pending = deferred(); requests.push(pending); return pending.promise;
      }
      if (url.endsWith('/instances')) return response({ instances: [] });
      if (url === '/api/resources/overview') return response({ items: [] });
      return response({ id: Number(url.split('/').pop()), host: 'test-host', port: 22, os_type: 'Linux' });
    });
  });
  afterEach(() => {
    document.body.replaceChildren(); window.removeEventListener('slide-navigate', navigation);
  });
  it('synchronously blocks rapid clicks and direct reentry; succeeds with one navigation', async () => {
    const view = await mount();
    button(view).click(); button(view).click(); void view._oneClickInspection();
    await settle(view);
    expect(requests).toHaveLength(1);
    expect(button(view).disabled).toBe(true);
    expect(button(view).getAttribute('aria-busy')).toBe('true');
    expect(JSON.parse(authFetch.mock.calls.find(([url]) => url.endsWith('/generate'))![1].body)).toEqual({ server_id: 9 });
    requests[0].resolve(response({ id: 123 })); await settle(view);
    expect(navigation).toHaveBeenCalledTimes(1);
    expect(navigation.mock.calls[0][0].detail).toEqual({ tab: 'reports' });
    expect(showToast).toHaveBeenCalledExactlyOnceWith('巡检报告已生成', 'success');
  });
  it.each(['http', 'network', 'invalid-json'])('shows %s failure and permits explicit retry', async kind => {
    const view = await mount(); button(view).click();
    if (kind === 'network') requests[0].reject(new Error('连接中断'));
    else if (kind === 'invalid-json') requests[0].resolve({ ok: false, json: async () => { throw new Error('json'); } });
    else requests[0].resolve(response({ error: '采集超时' }, false));
    await settle(view);
    const reason = kind === 'network' ? '连接中断' : kind === 'http' ? '采集超时' : '巡检失败';
    expect(view.shadowRoot.querySelector('[role="alert"]').textContent).toContain(reason);
    expect(button(view).disabled).toBe(false); expect(navigation).not.toHaveBeenCalled();
    button(view).click(); await settle(view); expect(requests).toHaveLength(2);
    requests[1].resolve(response()); await settle(view);
    expect(navigation).toHaveBeenCalledTimes(1);
  });
  it.each(['success', 'failure'])('ignores old object %s without unlocking the new inspection', async result => {
    const view = await mount(); button(view).click();
    view.serverId = 10; await settle(view); button(view).click(); await settle(view);
    expect(requests).toHaveLength(2);
    requests[0].resolve(response({ error: '旧对象失败' }, result === 'success')); await settle(view);
    expect(button(view).disabled).toBe(true); expect(navigation).not.toHaveBeenCalled(); expect(showToast).not.toHaveBeenCalled();
    requests[1].resolve(response()); await settle(view); expect(navigation).toHaveBeenCalledTimes(1);
  });
  it('ignores delayed error parsing after switching away and back to the same id', async () => {
    const view = await mount(); button(view).click();
    const body = deferred();
    requests[0].resolve({ ok: false, json: () => body.promise }); await settle(view);
    view.serverId = 10; await settle(view); view.serverId = 9; await settle(view);
    button(view).click(); await settle(view);
    body.resolve({ error: '旧巡检失败' }); await settle(view);
    expect(button(view).disabled).toBe(true);
    expect(showToast).not.toHaveBeenCalled(); expect(navigation).not.toHaveBeenCalled();
    requests[1].resolve(response()); await settle(view);
    expect(navigation).toHaveBeenCalledTimes(1);
  });
  it.each(['unmount', 'permissions'])('ignores results after %s', async action => {
    const view = await mount(); button(view).click();
    if (action === 'unmount') view.remove();
    else window.dispatchEvent(new CustomEvent('slide-permissions-loaded'));
    requests[0].resolve(response()); await settle(view);
    expect(navigation).not.toHaveBeenCalled(); expect(showToast).not.toHaveBeenCalled();
  });
});
