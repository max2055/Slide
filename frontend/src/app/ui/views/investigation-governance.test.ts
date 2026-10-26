import { afterEach, expect, it, vi } from 'vitest';
import { authFetch } from '../../../api/index.ts';
import { InvestigationGovernancePage } from './investigation-governance.ts';
import { canAccessSettingsItem, settingsItemById } from '../settings-navigation.ts';
import { showToast } from '../components/app-toast-container.js';
vi.mock('../../../api/index.ts', () => ({ authFetch: vi.fn() }));
vi.mock('../components/app-toast-container.js', () => ({ showToast: vi.fn() }));
afterEach(() => { document.body.replaceChildren(); window.history.replaceState({}, '', '/'); vi.resetAllMocks(); });
const coverage = (type: 'database' | 'server' | 'network_device', extra: Record<string, unknown> = {}) =>
  ({ type, status: 'not_configured', configuredCount: 0, existingCount: 0, permittedCount: 0, typePermission: false, ...extra });
const policies = {
  schemaVersion: 3, source: 'production_composition', originBoundary: 'investigation_engine_persist_only',
  policy: { id: 'database-alert-pilot', version: 1, profileId: 'ops', source: 'database-alert-engine', readonly: true },
  configurationStatus: 'not_configured',
  masterSwitch: { source: 'defaults', status: 'defaulted', enabled: true, severityLevels: ['critical', 'error', 'warning'],
    timeWindowStart: '00:00', timeWindowEnd: '23:59', instanceWhitelistCount: 0 },
  investigationSwitch: { enabled: false, manualEnabled: false, legacyEnabled: false, source: 'environment' },
  serviceIdentity: { status: 'not_configured', permissionsSufficient: false, missingPermissions: [], instanceScopeSufficient: true },
  resourceCoverage: [coverage('database'), coverage('server'), coverage('network_device')],
  entry: { status: 'not_connected', observedReceiptCount: 0, lastObservedAt: null, witnessTypes: [] },
  receipts: { total: 0, accepted: 0, suppressed: 0, pending: 0, unknown: 0, lastStatus: null, lastReason: null, lastAttemptAt: null },
  execution: { observed: 0, accepted: 0, running: 0, completed: 0, failed: 0, partial: 0, timed_out: 0, cancelled: 0, suppressed: 0, unknown: 0,
    lastStatus: null, lastAt: null },
  budget: { status: 'uninitialized', quotaReached: false, capacityReached: false, reserveTokens: 32000,
    reserveCostMicros: 1000000, admissionReasons: [] },
  automaticAnalysisStatus: 'blocked',
  blockers: [
    { code: 'SERVICE_IDENTITY_NOT_CONFIGURED', layer: 'configuration', remediation: 'deployment_environment' },
    { code: 'RESOURCE_SCOPE_NOT_CONFIGURED', layer: 'configuration', remediation: 'deployment_environment' },
    { code: 'INVESTIGATION_SWITCH_DISABLED', layer: 'switch', remediation: 'deployment_environment' },
    { code: 'BUDGET_UNINITIALIZED', layer: 'budget', remediation: 'budget_settings' },
  ],
} as const;
const unwired = { ...policies, configurationStatus: 'configured', automaticAnalysisStatus: 'unverified',
  masterSwitch: { ...policies.masterSwitch, source: 'system_config', status: 'persisted' },
  investigationSwitch: { ...policies.investigationSwitch, enabled: true },
  serviceIdentity: { ...policies.serviceIdentity, status: 'ready', permissionsSufficient: true },
  resourceCoverage: [coverage('database', { status: 'covered', configuredCount: 1, existingCount: 1, permittedCount: 1, typePermission: true }),
    coverage('server'), coverage('network_device')],
  entry: { status: 'unverified', observedReceiptCount: 0, lastObservedAt: null, witnessTypes: [] },
  budget: { ...policies.budget, status: 'matching' },
  blockers: [{ code: 'ENTRY_NOT_OBSERVED', layer: 'wiring', remediation: 'alert_engine' }] };
const wired = { ...unwired, automaticAnalysisStatus: 'available', entry: { status: 'connected', observedReceiptCount: 2,
    lastObservedAt: '2026-10-26T00:00:00.000Z', witnessTypes: ['database'] },
  receipts: { total: 3, accepted: 1, suppressed: 2, pending: 0, unknown: 0, lastStatus: 'accepted', lastReason: null,
    lastAttemptAt: '2026-10-26T00:00:00.000Z' },
  execution: { observed: 2, accepted: 0, running: 0, completed: 1, failed: 0, partial: 0, timed_out: 0, cancelled: 1, suppressed: 1, unknown: 0,
    lastStatus: 'cancelled', lastAt: '2026-10-26T00:01:00.000Z' },
  budget: { ...unwired.budget, capacityReached: false, admissionReasons: [] }, blockers: [] };

it('renders unconfigured switches, identity and entry as separate facts', async () => {
  vi.mocked(authFetch).mockResolvedValue(new Response(JSON.stringify(policies)));
  const element = await mount(); await vi.waitFor(() => expect((element as any).facts).not.toBeNull());
  await element.updateComplete;
  const text = element.shadowRoot!.textContent!;
  expect(text).toContain('尚未配置');
  expect(text).toContain('尚未接入');
  expect(text).toContain('尚未配置专用服务身份');
  expect(text).toContain('数据库');
  expect(text).toContain('服务器');
  expect(text).toContain('网络设备');
  expect(element.shadowRoot!.querySelectorAll('[data-blocker]')).toHaveLength(4);
  expect(element.shadowRoot!.querySelector('app-data-table')).not.toBeNull();
});

it('does not claim automatic analysis is available before an entry receipt exists', async () => {
  vi.mocked(authFetch).mockResolvedValue(new Response(JSON.stringify(unwired)));
  const element = await mount(); await vi.waitFor(() => expect((element as any).facts).not.toBeNull());
  await element.updateComplete;
  const text = element.shadowRoot!.textContent!;
  const stats = [...element.shadowRoot!.querySelectorAll('stat-card')].map(card => (card as any).value);
  expect(stats).toContain('待验证入口');
  expect(text).toContain('自动分析待验证入口');
  expect(text).toContain('未观察到持久入口证据');
  expect(text).not.toContain('自动分析已就绪');
  expect(element.shadowRoot!.querySelector('[data-blocker="ENTRY_NOT_OBSERVED"]')).not.toBeNull();
});

it('keeps durable execution outcomes separate from historical receipts', async () => {
  vi.mocked(authFetch).mockResolvedValue(new Response(JSON.stringify(wired)));
  const element = await mount(); await vi.waitFor(() => expect((element as any).facts).not.toBeNull());
  await element.updateComplete;
  const text = element.shadowRoot!.textContent!;
  expect(text).toContain('已确认入口接线');
  expect(text).toContain('历史回执（全部告警）');
  expect(text).toContain('最近执行结果');
  expect(text).toContain('已完成');
  expect(text).toContain('已取消');
  expect(text).toContain('准入抑制');
  expect(text).toContain('数据库');
  expect(element.shadowRoot!.querySelectorAll('[data-blocker]')).toHaveLength(0);
});

it('shows non-completed canonical Run terminals without claiming success', async () => {
  const terminal = { ...wired, execution: { ...wired.execution, completed: 0, partial: 1, timed_out: 1,
    lastStatus: 'timed_out', lastAt: '2026-10-26T00:02:00.000Z' } };
  vi.mocked(authFetch).mockResolvedValue(new Response(JSON.stringify(terminal)));
  const element = await mount(); await vi.waitFor(() => expect((element as any).facts).not.toBeNull());
  await element.updateComplete;
  const text = element.shadowRoot!.textContent!;
  expect(text).toContain('执行超时');
  expect(text).toContain('部分完成');
  expect(text).toContain('工作流任务完成不代表调查成功');
});

it('shows the real automatic reserve and instantaneous admission reasons', async () => {
  const blocked = { ...wired, automaticAnalysisStatus: 'blocked',
    budget: { ...wired.budget, quotaReached: true, capacityReached: true,
      admissionReasons: ['AUTOMATIC_DAILY_TOKENS', 'GLOBAL_CONCURRENCY'] },
    blockers: [{ code: 'BUDGET_QUOTA_REACHED', layer: 'budget', remediation: 'budget_settings' },
      { code: 'BUDGET_CAPACITY_REACHED', layer: 'budget', remediation: 'budget_settings' }] };
  vi.mocked(authFetch).mockResolvedValue(new Response(JSON.stringify(blocked)));
  const element = await mount(); await vi.waitFor(() => expect((element as any).facts).not.toBeNull());
  await element.updateComplete;
  const text = element.shadowRoot!.textContent!;
  expect(text).toContain('32,000');
  expect(text).toContain('余额不足以容纳一次预留');
  expect(text).toContain('全局并发当前已满（瞬时）');
  expect(element.shadowRoot!.querySelector('[data-blocker="BUDGET_CAPACITY_REACHED"]')).not.toBeNull();
});

it('routes missing items to the existing configuration pages', async () => {
  vi.mocked(authFetch).mockResolvedValue(new Response(JSON.stringify(policies)));
  const element = await mount(); await vi.waitFor(() => expect((element as any).facts).not.toBeNull());
  await element.updateComplete;
  const navigated = vi.fn();
  window.addEventListener('popstate', navigated, { once: true });
  (element.shadowRoot!.querySelector('[data-remediation="analysis_settings"]') as HTMLButtonElement).click();
  expect(window.location.pathname).toBe('/settings/monitoring/analysis');
  expect(new URLSearchParams(window.location.search).get('view')).toBe('automatic');
  expect(navigated).toHaveBeenCalledTimes(1);
  (element.shadowRoot!.querySelector('[data-remediation="budget_settings"]') as HTMLButtonElement).click();
  expect(window.location.pathname).toBe('/settings/ai/budget');
});
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
const admissionPolicy = { maxConcurrent: 4, manualReserved: 1, maxPerResourceConcurrent: 2, maxAutomaticRequestsPerHour: 20,
  maxAutomaticTokensPerDay: 5000000, maxTotalTokensPerDay: 5000000, maxCostMicrosPerDay: 10000000 };
const budgetFacts = { schemaVersion: 1, source: 'investigationBudgetConfiguration',
  policy: { currency: 'USD', ...admissionPolicy },
  reserveCostMicros: 1000000, persistedPolicy: null, admissionStatus: 'uninitialized', automaticTriggerStatus: 'not_connected',
  window: 'UTC_admission_day_and_hour', profileLimitsSource: '/api/investigation-profiles',
  domain: 'investigation-v1:v2', admissionRevision: 2, policySource: 'settings' };
const runtime = { contextWindowTokens: 1000000, outputTokens: 393216, summaryOutputTokens: 393216, maxExecutionTokens: 1000000 };
const profileLimits = { deadlineMs: 600000, maxToolCalls: 36, maxProviderAttempts: 8, maxRows: 200, maxBytes: 128000, maxWindowMs: 3600000 };
const admission = { revision: 2, policy: admissionPolicy };
const effectiveView = { schemaVersion: 1, source: 'settings',
  effective: { schemaVersion: 1, version: 3, runtime, profileLimits, admission, updatedAt: '2026-10-25T00:00:00.000Z' },
  defaults: { schemaVersion: 1, version: 0, runtime, profileLimits, admission, updatedAt: '2026-10-25T00:00:00.000Z' },
  provider: { model: 'deepseek-v4-flash', contextWindowTokens: 1000000, maxOutputTokens: 393216, preferredOutputTokens: 393216, source: 'configuration' },
  capabilityVerified: true,
  admission: { domain: 'investigation-v1:v2', revision: 2, source: 'settings' } };
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
    expect(body.admissionPolicy).toEqual(admissionPolicy);
    return new Response(JSON.stringify({ ...effectiveView,
      effective: { ...effectiveView.effective, version: 4, runtime: { ...runtime, contextWindowTokens: 500000 } } }));
  });
  await (element as any).saveBudget();
  expect((element as any).budget.effective.version).toBe(4);
  expect(showToast).toHaveBeenCalledWith(expect.stringContaining('有效预算已保存'), 'success');
});
it('rotates the ledger domain when only the admission policy changes', async () => {
  const element = await mountedBudget();
  // 4 runtime + 6 profile fields precede the admission group; total is next to last.
  const inputs = element.shadowRoot!.querySelectorAll('app-form-field input');
  const input = inputs[15] as HTMLInputElement;
  input.value = '8000000'; input.dispatchEvent(new Event('input', { bubbles: true }));
  await element.updateComplete;
  expect(element.shadowRoot!.textContent).toContain('保存后轮换账本域');
  vi.mocked(authFetch).mockImplementation(async (_url: any, init: any) => {
    const body = JSON.parse(init.body);
    expect(body.admissionPolicy.maxTotalTokensPerDay).toBe(8000000);
    expect(body.admissionPolicy.maxAutomaticTokensPerDay).toBe(5000000);
    return new Response(JSON.stringify({ ...effectiveView, source: 'settings',
      effective: { ...effectiveView.effective, version: 4,
        admission: { revision: 3, policy: { ...admissionPolicy, maxTotalTokensPerDay: 8000000 } } },
      admission: { domain: 'investigation-v1:v3', revision: 3, source: 'settings' } }));
  });
  await (element as any).saveBudget();
  expect((element as any).budget.admission).toEqual({ domain: 'investigation-v1:v3', revision: 3, source: 'settings' });
  expect(showToast).toHaveBeenCalledWith(expect.stringContaining('investigation-v1:v3'), 'success');
});
it('rejects conflicting admission values before sending the update', async () => {
  const element = await mountedBudget();
  const inputs = element.shadowRoot!.querySelectorAll('app-form-field input');
  const input = inputs[11] as HTMLInputElement;
  input.value = '9'; input.dispatchEvent(new Event('input', { bubbles: true }));
  await element.updateComplete;
  await (element as any).saveBudget();
  expect((element as any).budgetFieldErrors.manualReserved).toContain('全局并发');
  expect(vi.mocked(authFetch)).toHaveBeenCalledTimes(2);
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
