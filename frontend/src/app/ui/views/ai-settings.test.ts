import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const { authFetch } = vi.hoisted(() => ({ authFetch: vi.fn() }));
vi.mock('../../../api/index.js', () => ({ authFetch }));
import './ai-settings.js';
import type { AiSettingsPage } from './ai-settings.js';

const config = { enabled: true, cronExpression: '* * * * *', severityLevels: ['warning'], instanceWhitelist: [], timeWindowStart: '00:00', timeWindowEnd: '23:59' };
async function mount() {
  const view = document.createElement('ai-settings-page');
  document.body.append(view);
  await vi.waitFor(() => expect(view.shadowRoot!.querySelector('.inst-dropdown-toggle')).toBeTruthy());
  (view.shadowRoot!.querySelector('.inst-dropdown-toggle') as HTMLButtonElement).click();
  await view.updateComplete;
  return view;
}
const menu = (view: AiSettingsPage) => view.shadowRoot!.querySelector('.inst-dropdown-menu');
const mouseDown = (target: EventTarget) => target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, composed: true }));

describe('MAX-645 / #289 Shadow DOM whitelist interaction', () => {
  beforeEach(() => authFetch.mockImplementation(async (url: string) => ({ ok: true, json: async () => url.endsWith('/config') ? structuredClone(config) : [{ id: 1, name: '测试实例' }] })));
  afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });

  it('keeps search and checkbox mousedown inside the component despite event retargeting', async () => {
    const view = await mount();
    for (const selector of ['.inst-dropdown-search input', '.inst-dropdown-item input']) {
      let target: EventTarget | null = null;
      document.addEventListener('mousedown', event => { target = event.target; }, { once: true });
      mouseDown(view.shadowRoot!.querySelector(selector)!);
      await view.updateComplete;
      expect(target).toBe(view);
      expect(menu(view)).not.toBeNull();
    }
    mouseDown(document.body);
    await view.updateComplete;
    expect(menu(view)).toBeNull();
  });

  it('removes the document listener on disconnect and restores it on reconnect', async () => {
    const view = await mount();
    const remove = vi.spyOn(document, 'removeEventListener');
    view.remove();
    expect(remove).toHaveBeenCalledWith('mousedown', expect.any(Function));
    mouseDown(document.body);
    await view.updateComplete;
    expect(menu(view)).not.toBeNull();
    document.body.append(view);
    await vi.waitFor(() => expect(menu(view)).not.toBeNull());
    mouseDown(document.body);
    await view.updateComplete;
    expect(menu(view)).toBeNull();
  });

  it('uses native checkbox and label activation to keep selection state consistent', async () => {
    const view = await mount();
    const checkbox = view.shadowRoot!.querySelector('.inst-dropdown-item input') as HTMLInputElement;
    checkbox.click();
    await view.updateComplete;
    expect(checkbox.checked).toBe(true);
    expect(view.shadowRoot!.querySelector('.inst-dropdown-toggle')!.textContent).toContain('已选 1 个实例');
    (view.shadowRoot!.querySelector('.inst-dropdown-item') as HTMLLabelElement).click();
    await view.updateComplete;
    expect(checkbox.checked).toBe(false);
    expect(view.shadowRoot!.querySelector('.inst-dropdown-toggle')!.textContent).toContain('全部实例参与分析');
    expect(menu(view)).not.toBeNull();
  });
});
