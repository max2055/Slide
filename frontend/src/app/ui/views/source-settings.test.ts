import { afterEach, expect, it, vi } from 'vitest';
import { SETTINGS_GROUPS, canAccessSettingsItem } from '../settings-navigation.js';
const { authFetch } = vi.hoisted(() => ({ authFetch: vi.fn() }));
vi.mock('../../../api/index.js', () => ({ authFetch }));
import './source-settings.js';
afterEach(() => { document.body.replaceChildren(); authFetch.mockReset(); localStorage.clear(); });
const settle = async () => { await new Promise(resolve => setTimeout(resolve, 10)); };
it('registers source within platform settings', () => {
  expect(SETTINGS_GROUPS.find(group => group.id === 'platform')?.items.some(item => item.id === 'source')).toBe(true);
});
it('allows source administrators to reach the source settings page', () => {
  const item = SETTINGS_GROUPS.find(group => group.id === 'platform')!.items.find(item => item.id === 'source')!;
  expect(canAccessSettingsItem(item, new Set(['admin:*']))).toBe(true);
});
it('defaults model sharing off and clears single-use sync credentials', async () => {
  localStorage.setItem('permissions', JSON.stringify(['*']));
  authFetch.mockImplementation(async (url: string) => ({ ok: true, json: async () => url.endsWith('/config') ? { config: null } : { releaseId: 'release-test', commitSha: 'abc', treeDigest: 'digest', signature: 'signed', files: [] } }));
  const view = document.createElement('source-settings'); document.body.append(view); await settle();
  const checkbox = view.shadowRoot?.querySelector<HTMLInputElement>('input[type="checkbox"]');
  expect(checkbox?.checked).toBe(false);
  const token = view.shadowRoot?.querySelector<HTMLInputElement>('input[type="password"]');
  expect(token).not.toBeNull();
  token!.value = 'one-time-token'; token!.dispatchEvent(new Event('input')); await settle();
  view.shadowRoot?.querySelector<HTMLButtonElement>('[data-action="sync"]')?.click(); await settle();
  expect(authFetch).toHaveBeenCalledWith('/api/platform/source/sync', expect.objectContaining({ method: 'POST', body: JSON.stringify({ token: 'one-time-token' }) }));
  expect(token!.value).toBe('');
  expect(JSON.stringify(localStorage)).not.toContain('one-time-token');
});
it('disables mutations for config readers', async () => {
  localStorage.setItem('permissions', JSON.stringify(['config:view']));
  authFetch.mockImplementation(async (url: string) => url.endsWith('/manifest') ? { ok: false, json: async () => ({ error: 'SOURCE_NOT_CONFIGURED' }) } : { ok: true, json: async () => ({ config: null }) });
  const view = document.createElement('source-settings'); document.body.append(view); await settle();
  expect(view.shadowRoot?.querySelector('[data-action="sync"]')).toBeNull();
  expect(view.shadowRoot?.querySelector<HTMLInputElement>('input[type="url"]')?.disabled).toBe(true);
});
