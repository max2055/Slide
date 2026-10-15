import { afterEach, describe, expect, it, vi } from 'vitest';
import { authFetch } from '../../../api/index.ts';
import { AlertsPage } from './alerts.ts';
import '../components/alert-detail-modal.ts';

vi.mock('../../../api/index.ts', () => ({ authFetch: vi.fn() }));
vi.mock('../components/app-toast-container.js', () => ({ showToast: vi.fn() }));
afterEach(() => { document.body.replaceChildren(); vi.resetAllMocks(); });
const alert = (severity: string) => ({ id: 7, severity, title: '历史升级告警', message: 'test', status: 'acknowledged', created_at: '2026-10-15T00:00:00Z' });

describe('persisted alert levels', () => {
  it.each([['p0', '紧急（P0）', 'danger'], ['error', '错误', 'danger'], ['critical', '严重', 'danger'], ['warning', '警告', 'warn'], ['info', '提示', 'info'], ['future', '未知等级（future）', 'muted'], ['constructor', '未知等级（constructor）', 'muted']])('%s has consistent list/detail meaning', async (severity, label, variant) => {
    const list = document.createElement('alert-list') as any;
    list.alerts = [alert(severity)]; list.total = 1;
    const detail = document.createElement('alert-detail-modal') as any;
    detail.alert = alert(severity); detail.open = true;
    document.body.append(list, detail);
    await list.updateComplete; await detail.updateComplete;
    for (const element of [list, detail]) {
      const badge = element.shadowRoot.querySelector('app-badge');
      expect(Array.from(badge.childNodes as NodeListOf<ChildNode>).filter(node => node.nodeType === Node.TEXT_NODE).map(node => node.textContent).join('').trim()).toBe(label);
      expect(badge.getAttribute('variant')).toBe(variant);
    }
  });
  it('offers every persisted level including unknown counts for filtering', async () => {
    const list = document.createElement('alert-list') as any;
    list.levelCounts = { p0: 4, critical: 1, error: 2, warning: 3, info: 5, future: 6 };
    document.body.append(list); await list.updateComplete;
    const options = Array.from(list.shadowRoot.querySelectorAll('select:first-child option')) as HTMLOptionElement[];
    expect(options.map(o => o.value)).toEqual(['', 'p0', 'critical', 'error', 'warning', 'info', 'future']);
    expect(list.shadowRoot.textContent).toContain('未知等级（future）');
    expect(list.shadowRoot.querySelector('[aria-label="等级统计"]')?.textContent).toContain('紧急（P0）：4');
  });
  it('sends severity to the backend and resets pagination rather than filtering one page', async () => {
    vi.mocked(authFetch).mockImplementation(async () => new Response(JSON.stringify({ items: [], total: 0, level_counts: { p0: 1 } })));
    const page = new AlertsPage() as any;
    page.mode = 'active'; document.body.append(page); await page.updateComplete;
    await vi.waitFor(() => expect(page.loading).toBe(false));
    page.page = 3;
    page.shadowRoot.querySelector('alert-list').dispatchEvent(new CustomEvent('alert-filter-severity', { detail: { value: 'p0' } }));
    await vi.waitFor(() => expect(vi.mocked(authFetch).mock.calls.some(([url]) => url.includes('level=p0') && url.includes('offset=0'))).toBe(true));
    expect(page.page).toBe(0);
  });
  it('keeps P0 selected when editing a persisted escalation rule', async () => {
    const page = new AlertsPage() as any;
    page.escalationRules = [{ id: 1, from_level: 'critical', to_level: 'p0', trigger_value: 60, enabled: true }];
    page._openEscalationModal(page.escalationRules[0]);
    const { render } = await import('lit');
    const host = document.createElement('div'); document.body.append(host);
    render(page._renderEscalation(), host);
    expect(host.querySelector('tbody')?.textContent).toContain('紧急（P0）');
    expect((host.querySelectorAll('select')[1] as HTMLSelectElement).value).toBe('p0');
  });
});
