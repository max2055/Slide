import { afterEach, expect, it, vi } from 'vitest';
import { apiClient, authFetch, notifySessionExpired } from '../../../api/index.js';
import './resource-diagnosis.js';

afterEach(() => {
  document.body.replaceChildren(); vi.restoreAllMocks();
  apiClient.setToken(null); apiClient.setRefreshToken(null);
  localStorage.clear(); sessionStorage.clear(); history.replaceState({}, '', '/');
});

it.each(['rotation', 'logout', 'switch-user'] as const)('MAX-432 review: %s preserves only the owning session receipt', async change => {
  apiClient.setToken('session-before'); apiClient.setRefreshToken('refresh-before');
  localStorage.setItem('permissions', '["*"]');
  history.replaceState({}, '', '/resource-diagnosis?resourceType=instance&resourceId=1');
  let release!: (response: Response) => void;
  const pending = new Promise<Response>(resolve => { release = resolve; });
  let posts = 0;
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    if (url.endsWith('/diagnose-agent')) { posts++; return pending; }
    if (url.endsWith('/auth/refresh')) return json({ token: 'session-after', refreshToken: 'refresh-after' });
    if (url.endsWith('/rotation-probe')) return json({}, new Headers(init?.headers).get('Authorization') === 'Bearer session-before' ? 401 : 200);
    if (url === '/api/resources') return json({ items: [] });
    if (url.includes('/analyses/')) return json({ analysisId: 99, status: 'unknown' });
    return json({ facts: [], inferences: [], hypotheses: [], gaps: [], truncated: false });
  });
  const mount = async () => {
    const view = document.createElement('resource-diagnosis-page') as any;
    document.body.append(view); await vi.waitFor(() => expect(view.loading).toBe(false));
    return view;
  };
  const first = await mount();
  const submission = first.diagnose(true);
  await vi.waitFor(() => expect(posts).toBe(1));
  const context = apiClient.getSessionContext();
  if (change === 'rotation') {
    await authFetch('/api/rotation-probe');
    expect(apiClient.getSessionContext()).toBe(context);
    expect(apiClient.getRefreshToken()).toBe('refresh-after');
  } else {
    if (change === 'logout') notifySessionExpired();
    apiClient.setToken('another-login'); apiClient.setRefreshToken('another-refresh');
    localStorage.setItem('permissions', '["*"]');
    expect(apiClient.getSessionContext()).not.toBe(context);
  }
  first.remove();
  const second = await mount();
  if (change === 'rotation') {
    expect(second.busy).toBe(true);
    await second.diagnose(true); expect(posts).toBe(1);
  } else {
    expect(second.busy).toBe(false);
    expect(second.agentResult).toBeNull();
  }
  release(json({ analysisId: 99, status: 'queued' })); await submission;
  if (change === 'rotation') {
    await vi.waitFor(() => expect(second.agentResult?.status).toBe('unknown'));
    expect(location.search).toContain('analysisId=99');
    await second.diagnose(true); expect(posts).toBe(1);
  } else {
    expect(second.agentResult).toBeNull();
    expect(location.search).not.toContain('analysisId=99');
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/analyses/99'))).toBe(false);
  }
});
