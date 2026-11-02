import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../../api/index.js', () => ({ authFetch: vi.fn(async (url: string) =>
  url.startsWith('/api/metrics/template-events/')
    // These fixtures are legacy events, so the production evidence API returns
    // 404, rather than a successful legacy event-list payload.
    ? { ok: false, status: 404, json: async () => ({ code: 'TEMPLATE_EVENT_NOT_FOUND' }) }
    : { ok: true, json: async () => ({ items: [], total: 0 }) }) }));
import { EventManagementPage } from './event-management.js';

describe('manual recovery confirmation', () => {
  afterEach(() => document.body.replaceChildren());

  async function renderEvent(extra: Record<string, unknown> = {}) {
    const page = new EventManagementPage();
    const event = { id: '1', status: 'resolved', title: 'fixture', severity: 'warning', alert_count: 0, ...extra };
    Object.assign(page, { _loadEvents: async () => {}, events: [event], selectedEvent: event, loading: false });
    document.body.append(page);
    await page.updateComplete;
    const evidence = page.shadowRoot!.querySelector('template-event-evidence') as any;
    await new Promise(resolve => setTimeout(resolve, 0));
    await evidence.updateComplete;
    expect(evidence.shadowRoot.querySelector('h4')).toBeNull();
    expect(evidence.shadowRoot.querySelector('[role="alert"]')).toBeNull();
    return page.shadowRoot!;
  }

  it('asks for a manual basis and does not imply automatic metric verification', async () => {
    const root = await renderEvent();
    expect(root.textContent).toContain('人工确认恢复');
    expect(root.textContent).toContain('不代表客观指标观察窗验证通过');
    const input = root.querySelector<HTMLTextAreaElement>('[aria-label="人工恢复确认依据"]')!;
    expect(input.maxLength).toBe(1024);
    expect([...root.querySelectorAll('button')].find(b => b.textContent === '人工确认恢复')?.disabled).toBe(true);
    expect([...root.querySelectorAll('button')].some(b => b.textContent === '关闭事件')).toBe(false);
  });

  it('keeps actor/time/reason visible after close and identifies legacy unknown actors', async () => {
    const root = await renderEvent({ status: 'closed', verification_passed_at: '2026-10-03T12:00:00Z', verification_actor_id: 42, verification_reason: 'checked manually' });
    expect(root.textContent).toContain('人工恢复确认');
    expect(root.textContent).toContain('42');
    expect(root.textContent).toContain('checked manually');
    expect(root.textContent).toContain('不代表客观指标观察窗验证通过');
    const legacy = await renderEvent({ verification_passed_at: '2026-10-03T12:00:00Z', verification_actor_id: null });
    expect(legacy.textContent).toContain('历史记录未提供');
  });
});
