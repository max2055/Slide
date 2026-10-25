import { afterEach, expect, it, vi } from 'vitest';
import { authFetch } from '../../../api/index.ts';
import { InvestigationGovernancePage } from './investigation-governance.ts';
import { canAccessSettingsItem, settingsItemById } from '../settings-navigation.ts';
import { showToast } from '../components/app-toast-container.js';
vi.mock('../../../api/index.ts', () => ({ authFetch: vi.fn() }));
vi.mock('../components/app-toast-container.js', () => ({ showToast: vi.fn() }));
afterEach(() => { document.body.replaceChildren(); vi.resetAllMocks(); });
const policies = { schemaVersion: 1, configurationStatus: 'not_configured', integrationStatus: 'not_connected', source: 'production_composition', items: [], originBoundary: 'investigation_engine_persist_only' };
async function mount(kind: 'policies' | 'budget' | 'usage' = 'policies', permissions = ['ai:view', 'config:manage']) {
  const element = new InvestigationGovernancePage(); element.kind = kind; element.permissions = new Set(permissions);
  document.body.append(element); await element.updateComplete;
  return element;
}
it.each(['budget', 'usage'] as const)('%s requires BOTH permissions for navigation and direct component access', async kind => {
  for (const codes of [[], ['ai:view'], ['config:manage']]) {
    expect(canAccessSettingsItem(settingsItemById(kind)!, new Set(codes))).toBe(false);
    const element = await mount(kind, codes); await element.updateComplete;
    expect(vi.mocked(authFetch)).not.toHaveBeenCalled(); element.remove();
  }
  expect(canAccessSettingsItem(settingsItemById(kind)!, new Set(['ai:view', 'config:manage']))).toBe(true);
  expect(canAccessSettingsItem(settingsItemById(kind)!, new Set(['admin:*']))).toBe(true);
  expect(canAccessSettingsItem(settingsItemById(kind)!, null)).toBe(false);
});
it.each([401, 403, 503])('HTTP %s clears old facts instead of showing fake current totals', async status => {
  vi.mocked(authFetch).mockResolvedValue(new Response(JSON.stringify(policies)));
  const element = await mount(); await vi.waitFor(() => expect((element as any).facts).not.toBeNull());
  vi.mocked(authFetch).mockResolvedValue(new Response('{}', { status }));
  await (element as any).load(); await element.updateComplete;
  expect((element as any).facts).toBeNull();
  expect(element.shadowRoot!.textContent).toContain(status === 401 ? '登录已失效' : status === 403 ? '无权访问' : '暂不可用');
});
const budgetFacts = { schemaVersion: 1, source: 'investigationBudgetConfiguration',
  policy: { currency: 'USD', maxConcurrent: 4, manualReserved: 1, maxPerResourceConcurrent: 2, maxAutomaticRequestsPerHour: 20,
    maxAutomaticTokensPerDay: 256000, maxTotalTokensPerDay: 1000000, maxCostMicrosPerDay: 10000000 },
  reserveCostMicros: 1000000, persistedPolicy: null, admissionStatus: 'uninitialized', automaticTriggerStatus: 'not_connected',
  window: 'UTC_admission_day_and_hour', profileLimitsSource: '/api/investigation-profiles' };
const runtime = { contextWindowTokens: 1000000, outputTokens: 393216, summaryOutputTokens: 393216, maxExecutionTokens: 1000000 };
const profileLimits = { deadlineMs: 600000, maxToolCalls: 36, maxProviderAttempts: 8, maxRows: 200, maxBytes: 128000, maxWindowMs: 3600000 };
const effectiveView = { schemaVersion: 1, source: 'settings',
  effective: { schemaVersion: 1, version: 3, runtime, profileLimits, updatedAt: '2026-10-25T00:00:00.000Z' },
  defaults: { schemaVersion: 1, version: 0, runtime, profileLimits, updatedAt: '2026-10-25T00:00:00.000Z' },
  provider: { model: 'deepseek-v4-flash', contextWindowTokens: 1000000, maxOutputTokens: 393216, preferredOutputTokens: 393216, source: 'configuration' },
  capabilityVerified: true };
function mockBudget(view: object = effectiveView) {
  vi.mocked(authFetch).mockImplementation(async (url: any) => String(url).includes('/effective')
    ? new Response(JSON.stringify(view)) : new Response(JSON.stringify(budgetFacts)));
}
async function mountedBudget() {
  mockBudget();
  const element = await mount('budget');
  await vi.waitFor(() => expect((element as any).budget).not.toBeNull());
  await element.updateComplete;
  return element;
}
it('renders the editable effective budget and saves it with the observed version', async () => {
  const element = await mountedBudget();
  expect(element.shadowRoot!.textContent).toContain('有效预算（可编辑）');
  const inputs = element.shadowRoot!.querySelectorAll('app-form-field input');
  expect((inputs[0] as HTMLInputElement).value).toBe('1000000');
  (inputs[0] as HTMLInputElement).value = '500000';
  inputs[0].dispatchEvent(new Event('input', { bubbles: true }));
  await element.updateComplete;
  vi.mocked(authFetch).mockImplementation(async (_url: any, init: any) => {
    const body = JSON.parse(init.body);
    expect(body.expectedVersion).toBe(3);
    expect(body.runtime.contextWindowTokens).toBe(500000);
    return new Response(JSON.stringify({ ...effectiveView,
      effective: { ...effectiveView.effective, version: 4, runtime: { ...runtime, contextWindowTokens: 500000 } } }));
  });
  await (element as any).saveBudget();
  expect((element as any).budget.effective.version).toBe(4);
  expect(showToast).toHaveBeenCalledWith(expect.stringContaining('有效预算已保存'), 'success');
});
it('rejects an invalid window before sending the update', async () => {
  const element = await mountedBudget();
  const input = element.shadowRoot!.querySelector('app-form-field input') as HTMLInputElement;
  input.value = '100'; input.dispatchEvent(new Event('input', { bubbles: true }));
  await element.updateComplete;
  await (element as any).saveBudget();
  expect((element as any).budgetFieldErrors.contextWindowTokens).toContain('1024');
  expect((element as any).budget.effective.version).toBe(3);
  expect(vi.mocked(authFetch)).toHaveBeenCalledTimes(2);
});
it('surfaces a version conflict without overwriting the local draft', async () => {
  const element = await mountedBudget();
  vi.mocked(authFetch).mockResolvedValue(new Response(JSON.stringify({ error: 'INVESTIGATION_BUDGET_CONFLICT' }), { status: 409 }));
  await (element as any).saveBudget();
  expect((element as any).budgetError).toContain('已被他人修改');
  expect((element as any).budget.effective.version).toBe(3);
});
it.each(['slide-session-expired', 'slide-permissions-loaded', 'disconnect', 'kind', 'refresh'] as const)('%s rejects a delayed successful read', async boundary => {
  const deliveries: Array<(response: Response) => void> = [];
  vi.mocked(authFetch).mockImplementation(() => new Promise(resolve => deliveries.push(resolve)));
  const element = await mount(); await vi.waitFor(() => expect(deliveries.length).toBe(1));
  if (boundary === 'disconnect') element.remove();
  else if (boundary === 'kind') { element.kind = 'budget'; await element.updateComplete; }
  else if (boundary === 'refresh') void (element as any).load();
  else window.dispatchEvent(new CustomEvent(boundary, { detail: { permissions: [] } }));
  deliveries[0](new Response(JSON.stringify(policies))); await new Promise(resolve => setTimeout(resolve, 0)); await element.updateComplete;
  expect((element as any).facts).toBeNull();
  for (const deliver of deliveries.slice(1)) deliver(new Response('{}', { status: 503 }));
});
