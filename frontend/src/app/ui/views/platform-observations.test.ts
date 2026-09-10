import { afterEach, expect, it, vi } from 'vitest';
const { authFetch } = vi.hoisted(() => ({ authFetch: vi.fn() }));
vi.mock('../../../api/index.js', () => ({ authFetch }));
afterEach(() => { document.body.replaceChildren(); authFetch.mockReset(); });
it('shows release identity and explicit process-local log gaps', async () => {
  await import('./platform-observations.js');
  authFetch.mockResolvedValue({ ok: true, json: async () => ({ schemaVersion: 1, generatedAt: '2026-09-08T00:00:00Z', releaseId: 'release-test', commitSha: 'abc123', uptimeSeconds: 42, components: [], logs: { quality: 'unknown', gaps: ['NO_LOGS'], groups: [], retentionSeconds: 3600, persistence: 'process-local' } }) });
  const element = document.createElement('platform-observations') as HTMLElement & { updateComplete: Promise<unknown> };
  document.body.append(element);
  await new Promise(resolve => setTimeout(resolve, 10));
  await element.updateComplete;
  expect(authFetch).toHaveBeenCalledWith('/api/platform/observations');
  expect(element.shadowRoot?.textContent).toContain('release-test');
  expect(element.shadowRoot?.textContent).toContain('NO_LOGS');
  expect(element.shadowRoot?.textContent).toContain('process-local');
});
