import { afterEach, expect, it, vi } from 'vitest';
import { authFetch } from '../../../api/index.ts';
import { InvestigationGovernancePage } from './investigation-governance.ts';
import { canAccessSettingsItem, settingsItemById } from '../settings-navigation.ts';
vi.mock('../../../api/index.ts', () => ({ authFetch: vi.fn() }));
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
