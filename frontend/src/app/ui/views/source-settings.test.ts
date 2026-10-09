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
it('renders source controls as aligned label-control rows', async () => {
  authFetch.mockRejectedValue(new Error('offline'));
  const view = document.createElement('source-settings'); document.body.append(view); await settle();
  const fields = [...view.shadowRoot!.querySelectorAll<any>('app-form-field')];
  expect(fields.length).toBeGreaterThan(0);
  expect(fields.every(field => field.inline)).toBe(true);
  expect(fields[0].querySelector('select')).not.toBeNull();
  const fieldParts = [...fields[0].shadowRoot!.querySelector('.form-field')!.children].map((node: Element) => node.className);
  expect(fieldParts).toEqual(['form-label', 'form-control', 'form-hint']);
});
it('defaults model sharing off and clears single-use sync credentials', async () => {
  localStorage.setItem('permissions', JSON.stringify(['*']));
  authFetch.mockImplementation(async (url: string) => ({ ok: true, text: async () => JSON.stringify(url.endsWith('/config') ? { config: null } : { releaseId: 'release-test', commitSha: 'abc', treeDigest: 'digest', signature: 'signed', files: [] }) }));
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
it('saves GitLab subgroup repository paths and deploy usernames', async () => {
  localStorage.setItem('permissions', JSON.stringify(['admin:*']));
  const config = { provider: 'gitlab', baseUrl: 'https://gitlab.example.test', repositoryPath: 'group/subgroup/repo', gitUsername: 'gitlab+deploy-token-7', allowedPaths: ['src/'], allowModelContent: false };
  authFetch.mockImplementation(async (url: string) => ({ ok: true, text: async () => JSON.stringify(url.endsWith('/config') ? { config } : { files: [], commitSha: 'a'.repeat(40), treeDigest: 'b'.repeat(64) }) }));
  const view = document.createElement('source-settings'); document.body.append(view); await settle();
  expect(view.shadowRoot!.querySelector<HTMLInputElement>('[aria-label="仓库路径"]')!.value).toBe(config.repositoryPath);
  expect(view.shadowRoot!.querySelector<HTMLInputElement>('[aria-label="Git 用户名"]')!.value).toBe(config.gitUsername);
  view.shadowRoot!.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true })); await settle();
  expect(authFetch).toHaveBeenCalledWith('/api/platform/source/config', expect.objectContaining({ method: 'PUT', body: JSON.stringify(config) }));
});
it('saves a ref and shows incomplete unbound HTTP snapshots without implying deployment verification', async () => {
  localStorage.setItem('permissions', JSON.stringify(['admin:*']));
  const config = { provider: 'gitlab', baseUrl: 'http://gitlab.internal', repositoryPath: 'group/repo', ref: 'release', allowedPaths: [], allowModelContent: false };
  const manifest = { releaseId: 'source-1', commitSha: 'a'.repeat(40), treeDigest: 'b'.repeat(64), files: [], signature: 'signed', completeness: 'partial', skippedFiles: [{ path: 'src/config.json', reason: 'SOURCE_SENSITIVE_CONTENT' }], verification: { status: 'repository-unbound', reason: 'SOURCE_DEPLOYMENT_UNKNOWN' } };
  authFetch.mockImplementation(async (url: string) => ({ ok: true, text: async () => JSON.stringify(url.endsWith('/config') ? { config } : manifest) }));
  const view = document.createElement('source-settings'); document.body.append(view); await settle();
  const ref = view.shadowRoot!.querySelector<HTMLInputElement>('[aria-label="分支、标签或 Commit"]');
  expect(ref).not.toBeNull(); expect(ref!.value).toBe('release');
  ref!.value = 'main'; ref!.dispatchEvent(new Event('input'));
  view.shadowRoot!.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true })); await settle();
  expect(authFetch).toHaveBeenCalledWith('/api/platform/source/config', expect.objectContaining({ body: JSON.stringify({ ...config, ref: 'main' }) }));
  const text = view.shadowRoot!.querySelector('source-manifest')!.shadowRoot!.textContent;
  expect(text).toContain('未验证部署一致性'); expect(text).toContain('部分同步'); expect(text).toContain('src/config.json');
});
it('shows advisory files as retained without marking a complete snapshot partial', async () => {
  authFetch.mockImplementation(async (url: string) => ({ ok: true, text: async () => JSON.stringify(url.endsWith('/config') ? { config: null } : {
    releaseId: 'source-advisory', files: [{ path: 'src/config.json', bytes: 100 }], completeness: 'complete', skippedFiles: [],
    warnings: [{ path: 'src/config.json', reason: 'SOURCE_SENSITIVE_CONTENT' }],
    verification: { status: 'repository-unbound' },
  }) }));
  const view = document.createElement('source-settings'); document.body.append(view); await settle();
  const text = view.shadowRoot!.querySelector('source-manifest')!.shadowRoot!.textContent;
  expect(text).toContain('提示（文件已保留，1 项）');
  expect(text).toContain('含疑似敏感信息');
  expect(text).toContain('同步完成');
  expect(text).not.toContain('部分同步');
  expect(text).not.toContain('已跳过');
});

it('uses saved credentials after reentry and supports explicit replacement/deletion without client persistence', async () => {
  localStorage.setItem('permissions', JSON.stringify(['admin:*']));
  const config = { provider: 'github', baseUrl: 'https://github.com', repositoryPath: 'owner/repo', allowedPaths: [], allowModelContent: false };
  const credential = { identity: 'a'.repeat(64), hasSavedToken: true };
  authFetch.mockImplementation(async (url: string, options?: any) => {
    if (url.endsWith('/credential') && options?.method === 'DELETE') credential.hasSavedToken = false;
    return { ok: true, text: async () => JSON.stringify(url.endsWith('/config') ? { config, credential } : url.endsWith('/credential') ? credential : { files: [] }) };
  });
  const view = document.createElement('source-settings'); document.body.append(view); await settle();
  const root = view.shadowRoot!;
  expect(root.querySelector<HTMLButtonElement>('[data-action="sync"]')!.disabled).toBe(false);
  root.querySelector<HTMLButtonElement>('[data-action="sync"]')!.click(); await settle();
  expect(authFetch).toHaveBeenCalledWith('/api/platform/source/sync', expect.objectContaining({ body: JSON.stringify({ token: '', expectedIdentity: credential.identity }) }));
  const token = root.querySelector<HTMLInputElement>('input[type="password"]')!;
  token.value = 'replacement-fixture'; token.dispatchEvent(new Event('input')); await settle();
  root.querySelector<HTMLButtonElement>('[data-action="save-token"]')!.click(); await settle();
  expect(authFetch).toHaveBeenCalledWith('/api/platform/source/credential', expect.objectContaining({ method: 'PUT', body: JSON.stringify({ token: 'replacement-fixture', expectedIdentity: credential.identity }) }));
  expect(token.value).toBe('');
  root.querySelector<HTMLButtonElement>('[data-action="delete-token"]')!.click(); await settle();
  expect(root.querySelector<HTMLButtonElement>('[data-action="sync"]')!.disabled).toBe(true);
  expect(JSON.stringify(localStorage)).not.toContain('replacement-fixture');
  view.remove(); document.body.append(view); await settle();
  expect(token.value).toBe('');
});

it('retains only by explicit opt-in, blocks unsaved config changes and explains expired credentials', async () => {
  localStorage.setItem('permissions', JSON.stringify(['admin:*']));
  const config = { provider: 'gitlab', baseUrl: 'https://gitlab.example.test', repositoryPath: 'group/repo', allowedPaths: [], allowModelContent: false };
  const credential = { identity: 'b'.repeat(64), hasSavedToken: false };
  authFetch.mockImplementation(async (url: string) => ({ ok: !url.endsWith('/sync'), text: async () => JSON.stringify(url.endsWith('/config') ? { config, credential } : url.endsWith('/manifest') ? { files: [] } : { error: 'SOURCE_CREDENTIAL_INVALID' }) }));
  const view = document.createElement('source-settings'); document.body.append(view); await settle();
  const root = view.shadowRoot!;
  const token = root.querySelector<HTMLInputElement>('input[type="password"]')!;
  token.value = 'expired-fixture'; token.dispatchEvent(new Event('input'));
  const retain = root.querySelector<HTMLInputElement>('[aria-label="保留同步令牌"]')!;
  expect(retain.checked).toBe(false); retain.checked = true; retain.dispatchEvent(new Event('change')); await settle();
  root.querySelector<HTMLButtonElement>('[data-action="sync"]')!.click(); await settle();
  expect(authFetch).toHaveBeenCalledWith('/api/platform/source/sync', expect.objectContaining({ body: JSON.stringify({ token: 'expired-fixture', retainToken: true, expectedIdentity: credential.identity }) }));
  expect(root.textContent).toContain('已过期或缺少仓库读取权限'); expect(token.value).toBe('');
  const path = root.querySelector<HTMLInputElement>('[aria-label="仓库路径"]')!;
  path.value = 'group/other'; path.dispatchEvent(new Event('input')); await settle();
  token.value = 'other-fixture'; token.dispatchEvent(new Event('input')); await settle();
  expect(root.querySelector<HTMLButtonElement>('[data-action="sync"]')!.disabled).toBe(true);
  expect(root.querySelector<HTMLButtonElement>('[data-action="save-token"]')!.disabled).toBe(true);
  expect(root.textContent).toContain('请先保存配置');
  view.remove(); expect((view as any).token).toBe(''); expect((view as any).retainToken).toBe(false);
});

it.each([
  { identity: 'c'.repeat(64), hasSavedToken: false, hasStoredToken: true },
  { identity: 'c'.repeat(64), hasSavedToken: false, hasStoredToken: true, error: 'SOURCE_SAVED_CREDENTIAL_UNAVAILABLE' },
])('allows deletion of unmatched or corrupt stored credentials %j', async credential => {
  localStorage.setItem('permissions', JSON.stringify(['admin:*']));
  const config = { provider: 'github', baseUrl: 'https://github.com', repositoryPath: 'owner/repo', allowedPaths: [], allowModelContent: false };
  authFetch.mockImplementation(async (url: string) => ({ ok: true, text: async () => JSON.stringify(url.endsWith('/config') ? { config, credential } : url.endsWith('/credential') ? { ...credential, hasStoredToken: false, error: undefined } : { files: [] }) }));
  const view = document.createElement('source-settings'); document.body.append(view); await settle();
  const root = view.shadowRoot!;
  expect(root.querySelector<HTMLButtonElement>('[data-action="sync"]')!.disabled).toBe(true);
  const remove = root.querySelector<HTMLButtonElement>('[data-action="delete-token"]')!;
  expect(remove.disabled).toBe(false); remove.click(); await settle();
  expect(authFetch).toHaveBeenCalledWith('/api/platform/source/credential', expect.objectContaining({ method: 'DELETE' }));
  expect(remove.disabled).toBe(true);
});
