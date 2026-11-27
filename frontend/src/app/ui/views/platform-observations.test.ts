import { afterEach, expect, it, vi } from 'vitest';
const { authFetch } = vi.hoisted(() => ({ authFetch: vi.fn() }));
vi.mock('../../../api/index.js', () => ({ authFetch }));
const initialLocation = location.pathname + location.search + location.hash;
afterEach(() => {
  document.body.replaceChildren();
  history.replaceState(null, '', initialLocation);
  authFetch.mockReset();
});

const logRange = { from: '2026-09-08T00:00:00Z', to: '2026-09-08T00:20:00Z', component: 'api' };
const staleEvidence = { quality: 'unknown', gaps: ['LOG_EVIDENCE_STALE'], groups: [{ count: 1 }], persistence: 'process-local', ...logRange };

it('forwards an explicit observation scope and shows expired evidence with its range', async () => {
  await import('./platform-observations.js');
  history.replaceState(null, '', '/health?' + new URLSearchParams({ view: 'observations', ...logRange, unrelated: 'omit' }));
  authFetch.mockResolvedValue({ ok: true, json: async () => ({ schemaVersion: 1, logs: staleEvidence }) });
  const view = document.createElement('platform-observations-page');
  document.body.append(view);
  await vi.waitFor(() => expect(view.shadowRoot?.textContent).toContain('已过期'));
  expect(authFetch).toHaveBeenCalledWith('/api/platform/observations?' + new URLSearchParams(logRange));
  expect(view.shadowRoot?.textContent).toContain('日志范围');
  expect(view.shadowRoot?.textContent).toContain('API 服务');
});

it('opens a recent historical range and restores the unqualified default', async () => {
  await import('./platform-observations.js');
  history.replaceState(null, '', '/health?view=observations&unrelated=preserve');
  authFetch.mockResolvedValue({ ok: true, json: async () => ({ schemaVersion: 1 }) });
  const view = document.createElement('platform-observations-page');
  document.body.append(view);
  function control(name: string) {
    return [...view.shadowRoot!.querySelectorAll('button')].find(button => button.textContent?.trim() === name);
  }
  await vi.waitFor(() => expect(control('查看最近 30 分钟')?.disabled).toBe(false));
  expect(authFetch).toHaveBeenLastCalledWith('/api/platform/observations');
  control('查看最近 30 分钟')!.click();
  await vi.waitFor(() => expect(control('恢复默认范围')?.disabled).toBe(false));
  const selected = new URL(authFetch.mock.lastCall![0], location.origin);
  expect(selected.pathname).toBe('/api/platform/observations');
  expect(Date.parse(selected.searchParams.get('to')!) - Date.parse(selected.searchParams.get('from')!)).toBe(30 * 60_000);
  control('恢复默认范围')!.click();
  await vi.waitFor(() => expect(authFetch).toHaveBeenLastCalledWith('/api/platform/observations'));
  expect(location.search).toBe('?view=observations&unrelated=preserve');
});
it('shows release identity and explicit process-local log gaps', async () => {
  await import('./platform-observations.js');
  authFetch.mockResolvedValue({ ok: true, json: async () => ({ schemaVersion: 1, generatedAt: '2026-09-08T00:00:00Z', releaseId: 'release-test', commitSha: 'abc123', uptimeSeconds: 42, components: [], logs: { quality: 'unknown', gaps: ['NO_LOGS'], groups: [], retentionSeconds: 3600, persistence: 'process-local' } }) });
  const element = document.createElement('platform-observations') as HTMLElement & { updateComplete: Promise<unknown> };
  document.body.append(element);
  await new Promise(resolve => setTimeout(resolve, 10));
  await element.updateComplete;
  expect(authFetch).toHaveBeenCalledWith('/api/platform/observations');
  const buttons = Array.from(element.shadowRoot!.querySelectorAll<HTMLButtonElement>('button'));
  buttons.find(button => button.textContent?.trim() === '查看缺口')!.click();
  await element.updateComplete;
  expect(element.shadowRoot?.querySelector('pre')?.textContent).toContain('release-test');
  element.shadowRoot!.querySelector('app-dialog')!.dispatchEvent(new CustomEvent('app-dialog-close'));
  await element.updateComplete;
  Array.from(element.shadowRoot!.querySelectorAll<HTMLButtonElement>('tbody button'))[0].click();
  await element.updateComplete;
  expect(element.shadowRoot?.querySelector('pre')?.textContent).toContain('NO_LOGS');
  expect(element.shadowRoot?.querySelector('pre')?.textContent).toContain('process-local');
});
