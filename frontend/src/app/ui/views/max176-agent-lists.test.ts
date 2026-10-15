import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiClient } from '../../../api/index.js';
import { AgentToolsPage } from './agent-tools.js';

const tool = (name: string) => ({ name, description: '用途'.repeat(100), parameters: { type: 'object' }, security: { effect: 'read', approval: 'never', resource: 'instance', permissions: ['instance:view'] } });
async function flush(element: AgentToolsPage) { await new Promise(resolve => setTimeout(resolve, 0)); await element.updateComplete; }
afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });
describe('MAX-176 full-list lifecycle', () => {
  it('filters the full authorized collection before paging and retains dialog context', async () => {
    vi.spyOn(apiClient, 'fetchResponseWithAuth').mockResolvedValue(new Response(JSON.stringify({ tools: Array.from({ length: 25 }, (_, i) => tool(`工具-${String(i).padStart(2, '0')}`)) })));
    const element = new AgentToolsPage(); document.body.append(element); await flush(element);
    expect(element.shadowRoot!.querySelectorAll('tbody tr')).toHaveLength(6);
    const search = element.shadowRoot!.querySelector('input')!;
    search.value = '工具-24'; search.dispatchEvent(new Event('input')); await flush(element);
    expect(element.shadowRoot!.querySelectorAll('tbody tr')).toHaveLength(1);
    expect(element.shadowRoot!.textContent).toContain('第 1 / 1 页');
    (element.shadowRoot!.querySelector('tbody button') as HTMLButtonElement).click(); await flush(element);
    expect(element.shadowRoot!.querySelector('app-dialog')!.textContent).toContain('工具-24');
    element.shadowRoot!.querySelector('app-dialog')!.dispatchEvent(new CustomEvent('app-dialog-close')); await flush(element);
    expect(search.value).toBe('工具-24');
  });
  it('clears stale records on forbidden refresh and keeps it distinct from an empty success', async () => {
    const request = vi.spyOn(apiClient, 'fetchResponseWithAuth').mockResolvedValueOnce(new Response(JSON.stringify({ tools: [tool('previous')] })))
      .mockResolvedValueOnce(new Response('{}', { status: 403 })).mockResolvedValueOnce(new Response(JSON.stringify({ tools: [] })));
    const element = new AgentToolsPage(); document.body.append(element); await flush(element);
    expect(element.shadowRoot!.textContent).toContain('previous');
    await element.load(); await flush(element);
    expect(element.shadowRoot!.textContent).not.toContain('previous');
    expect(element.shadowRoot!.querySelector('[role="alert"]')!.textContent).toContain('权限');
    await element.load(); await flush(element);
    expect(element.shadowRoot!.textContent).toContain('暂无已注册工具');
    expect(element.shadowRoot!.querySelector('[role="alert"]')).toBeNull(); expect(request).toHaveBeenCalledTimes(3);
  });
  it('does not restore a late response after session expiry', async () => {
    let resolve!: (value: Response) => void;
    vi.spyOn(apiClient, 'fetchResponseWithAuth').mockImplementation(() => new Promise(r => { resolve = r; }));
    const element = new AgentToolsPage(); document.body.append(element); await element.updateComplete;
    window.dispatchEvent(new Event('slide-session-expired'));
    resolve(new Response(JSON.stringify({ tools: [tool('late-private')] }))); await flush(element);
    expect(element.shadowRoot!.textContent).not.toContain('late-private');
    expect(element.shadowRoot!.textContent).toContain('登录已失效');
  });
});
