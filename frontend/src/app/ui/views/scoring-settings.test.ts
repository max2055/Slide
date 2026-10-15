import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { authFetch } = vi.hoisted(() => ({ authFetch: vi.fn() }));
vi.mock('../../../api/index.js', () => ({ authFetch }));
import './scoring-settings.js';

const defaults = { availability: .35, performance: .35, capacity: .2, security: .1 };
const response = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });
type Page = HTMLElement & { updateComplete: Promise<boolean>; _save(): Promise<void> };
async function mount(body: unknown = defaults, status = 200) {
  authFetch.mockResolvedValue(response(body, status));
  const page = document.createElement('scoring-settings-page') as unknown as Page;
  document.body.append(page);
  await vi.waitFor(() => expect(page.shadowRoot?.querySelector('.loading')).toBeNull());
  await page.updateComplete;
  return page;
}
const root = (page: Page) => page.shadowRoot!;

describe('scoring percentages and validation', () => {
  beforeEach(() => authFetch.mockReset());
  afterEach(() => { document.body.replaceChildren(); vi.useRealTimers(); });

  it('uses percent for the total and saves the unchanged backend ratio values', async () => {
    const page = await mount();
    expect(root(page).querySelector('.total-value')?.textContent).toContain('100%');
    authFetch.mockResolvedValue(response({ success: true }));
    await page._save();
    expect(authFetch).toHaveBeenLastCalledWith('/api/scoring/config', expect.objectContaining({ method: 'PUT', body: JSON.stringify(defaults) }));
  });

  it.each([
    [.345, '99.5%', '不足'], [.355, '100.5%', '超过'], [0, '65%', '不足'],
  ])('blocks saving when availability=%s, with a precise total and explanation', async (availability, total, reason) => {
    const page = await mount({ ...defaults, availability });
    expect(root(page).querySelector('.total-value')?.textContent).toContain(total);
    expect(root(page).querySelector('[role="status"]')?.textContent).toContain(reason);
    expect(root(page).querySelector('button')?.disabled).toBe(true);
    authFetch.mockClear();
    await page._save();
    expect(authFetch).not.toHaveBeenCalled();
  });

  it('preserves fractional stored weights without rounding each dimension to an integer percent', async () => {
    const page = await mount({ availability: .3333, performance: .3333, capacity: .2334, security: .1 });
    expect([...root(page).querySelectorAll('.dim-value')].map(el => el.textContent)).toEqual(['33.33%', '33.33%', '23.34%', '10%']);
    expect(root(page).querySelector('.total-value')?.textContent).toContain('100%');
    expect(root(page).querySelector('button')?.disabled).toBe(false);
  });

  it.each([{}, [], { ...defaults, security: null }, { ...defaults, security: '0.1' }, { ...defaults, security: NaN }, { ...defaults, security: Infinity }, { ...defaults, security: -1 }, { ...defaults, security: 2 }])('rejects unknown/invalid response %j instead of showing fake sliders', async body => {
    authFetch.mockResolvedValue(response(body));
    const page = document.createElement('scoring-settings-page') as unknown as Page;
    document.body.append(page);
    await vi.waitFor(() => expect(root(page).textContent).toContain('评分权重配置不完整或无效'));
    expect(root(page).querySelectorAll('input')).toHaveLength(0);
    authFetch.mockClear();
    await page._save();
    expect(authFetch).not.toHaveBeenCalled();
  });

  it.each([403, 500])('keeps save errors visible with editable data (%s)', async status => {
    const page = await mount();
    authFetch.mockResolvedValue(response({ error: status === 403 ? '无权限' : '保存失败' }, status));
    await page._save(); await page.updateComplete;
    expect(root(page).querySelector('[role="alert"]')?.textContent).toContain(status === 403 ? '无权限' : '保存失败');
    expect(root(page).querySelectorAll('input')).toHaveLength(4);
  });
});
