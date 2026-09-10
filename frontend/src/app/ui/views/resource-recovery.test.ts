import { afterEach, expect, it, vi } from 'vitest';
const { authFetch } = vi.hoisted(() => ({ authFetch: vi.fn() }));
vi.mock('../../../api/index.js', () => ({ authFetch }));
import './resource-recovery.js';
const policy = { schemaVersion: 1, version: 0, enabled: false, commandTypes: [], metricId: '', source: '', windowSeconds: 60, maxSampleGapSeconds: 30 };
const settle = () => new Promise(resolve => setTimeout(resolve, 10));
afterEach(() => { document.body.replaceChildren(); localStorage.clear(); authFetch.mockReset(); });
async function mount(permissions = ['*']) {
  localStorage.setItem('permissions', JSON.stringify(permissions));
  const view = document.createElement('resource-recovery') as HTMLElement & { resourceType: string; resourceId: number };
  view.resourceType = 'server'; view.resourceId = 2; document.body.append(view); await settle(); return view;
}
it('keeps policy disabled by default and preserves draft on CAS conflict', async () => {
  authFetch.mockImplementation(async (_url: string, options?: RequestInit) => options ? { ok: false, status: 409, json: async () => ({ error: 'RECOVERY_POLICY_VERSION_CONFLICT' }) } : { ok: true, json: async () => policy });
  const view = await mount();
  expect(view.shadowRoot?.querySelector<HTMLInputElement>('[aria-label="启用恢复策略"]')?.checked).toBe(false);
  const metric = view.shadowRoot!.querySelector<HTMLInputElement>('[aria-label="恢复指标 ID"]')!;
  metric.value = 'cpu'; metric.dispatchEvent(new Event('input'));
  view.shadowRoot!.querySelector('[data-policy-form]')!.dispatchEvent(new Event('submit', { cancelable: true })); await settle();
  expect(view.shadowRoot?.textContent).toContain('RECOVERY_POLICY_VERSION_CONFLICT');
  expect(metric.value).toBe('cpu');
  const writes = authFetch.mock.calls.filter(([, options]) => options?.method === 'PUT');
  expect(writes).toHaveLength(1);
  expect(JSON.parse(writes[0][1].body)).toMatchObject({ expectedVersion: 0, enabled: false, metricId: 'cpu' });
});
it('allows read-only operation verification and renders server evidence without mutations', async () => {
  authFetch.mockImplementation(async (url: string) => ({ ok: true, json: async () => url.endsWith('/recovery-policy') ? policy : { status: 'unknown', reason: 'RECOVERY_PLAN_NOT_BOUND', operationId: 'op-1', operationState: 'completed', evidenceRefs: ['ev-1'], verifiedBy: 'evidence' } }));
  const view = await mount(['servers:view']);
  expect(view.shadowRoot?.querySelector<HTMLInputElement>('[aria-label="启用恢复策略"]')?.disabled).toBe(true);
  const input = view.shadowRoot!.querySelector<HTMLInputElement>('[aria-label="操作 ID"]')!;
  input.value = 'op-1'; input.dispatchEvent(new Event('input'));
  view.shadowRoot!.querySelector('[data-verify-form]')!.dispatchEvent(new Event('submit', { cancelable: true })); await settle();
  expect(authFetch).toHaveBeenCalledWith('/api/resources/server/2/recovery/op-1');
  expect(view.shadowRoot?.textContent).toContain('RECOVERY_PLAN_NOT_BOUND');
  expect(view.shadowRoot?.textContent).toContain('ev-1');
  expect(authFetch.mock.calls.every(([, options]) => !options)).toBe(true);
});
