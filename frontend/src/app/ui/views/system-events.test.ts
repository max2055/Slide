import { afterEach, expect, it, vi } from 'vitest';
import { authFetch } from '../../../api/index.ts';
import { SystemEventsPageElement } from './system-events.ts';

vi.mock('../../../api/index.ts', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../api/index.ts')>(), authFetch: vi.fn(),
}));

const eventId = '8a3957d6-0fad-4ea8-8a74-3f5b5a8e7b44';
const investigationId = 'b9f9b923-33f0-448c-a6f7-64d9b8e6e098';
const json = (data: object, status = 200) => new Response(JSON.stringify(data), { status });

afterEach(() => { document.body.replaceChildren(); vi.resetAllMocks(); });

it.each(['查看原始事实', '打开只读调查'])('clears displayed facts and investigation links if %s is denied', async action => {
  vi.mocked(authFetch).mockImplementation(async (url) => {
    if (url === '/api/platform/observations') return json({ system: { collection: { effective: true } } });
    if (url === '/api/platform/system-events') return json({ truncated: false, items: [{
      eventId, component: 'api', occurredAt: '2026-11-26T01:30:00.000Z', summary: '受权限约束的异常', disposition: 'suppressed', investigationId: null,
    }, {
      eventId: '21cc3e44-fd89-4a61-86dd-ffb2bbe85d49', component: 'agent', occurredAt: '2026-11-26T01:31:00.000Z',
      summary: '已关联其他调查的异常', disposition: 'suppressed', investigationId,
    }] });
    return json({ error: 'INVESTIGATION_NOT_FOUND' }, 404);
  });
  const page = new SystemEventsPageElement();
  document.body.append(page);
  const root = page.shadowRoot!;
  await vi.waitFor(() => expect(root.querySelectorAll('[data-event-id]')).toHaveLength(2));
  const card = root.querySelector(`[data-event-id="${eventId}"]`)!;
  const button = [...card.querySelectorAll('button')].find(item => item.textContent === action)!;
  button.click();
  await vi.waitFor(() => expect(root.querySelector('[role="alert"]')?.textContent).toContain('无访问权限'));
  expect(root.querySelectorAll('[data-event-id]')).toHaveLength(0);
  expect(root.querySelector('a')).toBeNull();
  expect(root.querySelector('pre')).toBeNull();
  expect(root.querySelector<HTMLButtonElement>('.btn-refresh')?.disabled).toBe(false);
});

it('keeps the original event visible when the draft receipt belongs to a different event', async () => {
  vi.mocked(authFetch).mockImplementation(async (url) => {
    if (url === '/api/platform/observations') return json({ system: { collection: { effective: true } } });
    if (url === '/api/platform/system-events') return json({ truncated: false, items: [{
      eventId, component: 'api', occurredAt: '2026-11-26T01:30:00.000Z', summary: '等待调查的异常', disposition: 'suppressed', investigationId: null,
    }] });
    return json({ id: investigationId, eventId: '21cc3e44-fd89-4a61-86dd-ffb2bbe85d49', modelInvoked: false });
  });
  const page = new SystemEventsPageElement();
  document.body.append(page);
  const root = page.shadowRoot!;
  await vi.waitFor(() => expect(root.querySelector('[data-event-id]')).not.toBeNull());
  const button = [...root.querySelectorAll('button')].find(item => item.textContent === '打开只读调查')!;
  button.click();
  await vi.waitFor(() => expect(root.querySelector('[role="alert"]')?.textContent).toContain('调查保存回执未确认'));
  expect(root.querySelector('[data-event-id]')?.getAttribute('data-event-id')).toBe(eventId);
  expect(root.querySelector('a')).toBeNull();
  expect(button.disabled).toBe(false);
});
