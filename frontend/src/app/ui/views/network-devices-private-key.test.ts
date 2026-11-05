import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { authFetch } = vi.hoisted(() => ({ authFetch: vi.fn() }));
vi.mock('../../../api/index.js', () => ({ authFetch }));
vi.mock('../components/app-toast-container.js', () => ({ showToast: vi.fn() }));
import './network-devices-page.js';

// Deliberately synthetic; never use a real credential in test artifacts.
const pem = '\n-----BEGIN PRIVATE KEY-----\n  synthetic-only  \n\n-----END PRIVATE KEY-----\n';
const response = (body: unknown) => ({ ok: true, json: async () => body });

async function editor() {
  const page = document.createElement('network-devices-page') as any;
  document.body.append(page);
  await page.updateComplete;
  await new Promise(resolve => setTimeout(resolve, 0));
  page.openCreate();
  page.form = { ...page.form, name: 'synthetic-switch', host: '192.0.2.7', community: 'synthetic', sshUsername: 'ops' };
  await page.updateComplete;
  const selector = page.querySelector('app-ssh-auth-selector');
  selector.dispatchEvent(new CustomEvent('ssh-auth-change', { detail: { value: 'key' } }));
  await page.updateComplete;
  return page;
}

describe('MAX-312 / #433 private key editor', () => {
  beforeEach(() => {
    authFetch.mockReset();
    authFetch.mockImplementation(async (_url: string, init?: RequestInit) => response(init?.method === 'POST' ? { id: 7, success: true } : []));
  });
  afterEach(() => document.body.replaceChildren());

  it('preserves multiline whitespace from the control through save and both probes', async () => {
    const page = await editor();
    const field = page.querySelector('app-form-field[label="SSH 私钥"] textarea');
    expect(field).not.toBeNull();
    field.value = pem;
    field.dispatchEvent(new Event('input', { bubbles: true }));
    await page.updateComplete;
    await page.testSshConnection();
    await page.testConnection();
    await page.saveDevice();
    const writes = authFetch.mock.calls.filter(([, init]) => init?.method === 'POST');
    expect(writes).toHaveLength(3);
    for (const [, init] of writes) expect(JSON.parse(init.body).ssh.credentialValue).toBe(pem);
  });

  it('defaults to masked and keeps content when toggled; resets on reopen and auth changes', async () => {
    const page = await editor();
    const field = page.querySelector('textarea');
    expect(field).not.toBeNull();
    field.value = pem;
    field.dispatchEvent(new Event('input', { bubbles: true }));
    await page.updateComplete;
    const toggle = () => page.querySelector('button[aria-controls="network-device-ssh-private-key"]');
    expect(toggle().textContent).toContain('显示私钥');
    expect(toggle().getAttribute('aria-pressed')).toBe('false');
    toggle().click();
    await page.updateComplete;
    expect(toggle().textContent).toContain('隐藏私钥');
    expect(field.value).toBe(pem);
    page.querySelector('app-ssh-auth-selector').dispatchEvent(new CustomEvent('ssh-auth-change', { detail: { value: 'password' } }));
    await page.updateComplete;
    expect(page.querySelector('app-form-field[label="SSH 密码"] input').type).toBe('password');
    expect(toggle()).toBeNull();
    page.querySelector('app-ssh-auth-selector').dispatchEvent(new CustomEvent('ssh-auth-change', { detail: { value: 'key' } }));
    await page.updateComplete;
    expect(toggle().getAttribute('aria-pressed')).toBe('false');
    toggle().click();
    await page.updateComplete;
    await page.finishCloseDialog();
    page.openCreate();
    page.form = { ...page.form, sshCredentialType: 'key' };
    await page.updateComplete;
    expect(toggle().getAttribute('aria-pressed')).toBe('false');
    expect(page.querySelector('textarea').value).toBe('');
  });

  it('keeps password whitespace and omits untouched SSH credentials when editing', async () => {
    const page = await editor();
    await page.openEdit({ id: 7, name: 'synthetic-switch', host: '192.0.2.7', snmp_port: 161, ssh_port: 22 });
    await page.updateComplete;
    const input = page.querySelector('app-form-field[label="SSH 密码"] input');
    expect(input.type).toBe('password');
    expect(page.requestPayload().ssh).toBeUndefined();
    input.value = '  synthetic password  ';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    page.form = { ...page.form, sshUsername: 'ops' };
    await page.saveDevice();
    const write = authFetch.mock.calls.find(([, init]) => init?.method === 'PUT');
    expect(JSON.parse(write[1].body).ssh).toMatchObject({ credentialType: 'password', credentialValue: '  synthetic password  ' });
  });
});
