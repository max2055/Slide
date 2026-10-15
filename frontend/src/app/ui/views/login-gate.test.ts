import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'lit';
import { i18n, t } from '../../i18n/index.ts';
import type { AppViewState } from '../app-view-state.ts';
import { apiClient } from '../../../api/index.ts';
import { renderLoginGate } from './login-gate.ts';

let state: AppViewState;
let host: HTMLDivElement;
function paint() { render(renderLoginGate(state), host); }
function submit() { host.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true })); }
beforeEach(() => {
  host = document.createElement('div'); document.body.append(host);
  state = {
    settings: { username: ' operator ' }, password: ' password with spaces ', lastError: null,
    loginShowGatewayPassword: false, connect: vi.fn(),
    applySettings: vi.fn(next => { state.settings = next; }),
    setPassword: vi.fn(next => { state.password = next; }), requestUpdate: paint,
  } as unknown as AppViewState;
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: async () => [] }));
});
afterEach(() => { host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('login validation and compatibility', () => {
  for (const locale of ['zh-CN', 'en'] as const) {
    it(`${locale}: blocks missing credentials and translates errors/actions`, async () => {
      await i18n.setLocale(locale);
      const login = vi.spyOn(apiClient, 'directLogin');
      for (const [username, password] of [['', 'secret'], ['   ', 'secret'], ['operator', '']]) {
        state.settings.username = username; state.password = password; paint(); submit();
        expect(state.lastError).toBe(t('login.requiredCredentials'));
      }
      expect(login).not.toHaveBeenCalled(); expect(state.connect).not.toHaveBeenCalled();
      expect(host.querySelector('button[type="submit"]')!.textContent?.trim()).toBe(t('login.submit'));
      expect(host.querySelector('input[autocomplete="current-password"]')!.hasAttribute('required')).toBe(true);
    });

    it(`${locale}: distinguishes rejected credentials and server/invalid-response failures`, async () => {
      await i18n.setLocale(locale); paint();
      const login = vi.spyOn(apiClient, 'directLogin').mockResolvedValue(null);
      submit(); await vi.waitFor(() => expect(state.lastError).toBe(t('login.invalidCredentials')));
      for (const error of ['network error', 'server-error', 'parse error']) {
        login.mockRejectedValueOnce(new Error(error)); submit();
        await vi.waitFor(() => expect(state.lastError).toBe(t('login.serverUnavailable', {
          address: new URL('/api/auth/login', window.location.origin).href,
        })));
      }
      expect(state.connect).not.toHaveBeenCalled();
    });
  }

  it('preserves the exact password, normalizes username and prevents concurrent submissions', async () => {
    let resolve!: (token: string) => void;
    const login = vi.spyOn(apiClient, 'directLogin').mockReturnValue(new Promise(done => { resolve = done; }));
    paint(); submit(); submit();
    await vi.waitFor(() => expect(login).toHaveBeenCalledTimes(1));
    expect(login).toHaveBeenCalledWith('operator', ' password with spaces ');
    expect(host.querySelector('button[type="submit"]')!.hasAttribute('disabled')).toBe(true);
    expect(host.querySelector('form')!.getAttribute('aria-busy')).toBe('true');
    // Re-rendering (e.g. typing or toggling visibility) cannot lose the pending guard.
    paint(); submit(); expect(login).toHaveBeenCalledTimes(1);
    resolve('test-token'); await vi.waitFor(() => expect(state.connect).toHaveBeenCalledTimes(1));
    expect(host.querySelector('button[type="submit"]')!.hasAttribute('disabled')).toBe(false);
    expect(fetch).toHaveBeenCalledWith('/api/auth/permissions', { headers: { Authorization: 'Bearer test-token' } });
  });

  it('keeps password input and visibility synchronized without submitting', () => {
    paint(); const input = host.querySelector<HTMLInputElement>('[autocomplete="current-password"]')!;
    input.value = ' edited '; input.dispatchEvent(new Event('input'));
    expect(state.password).toBe(' edited ');
    host.querySelector<HTMLButtonElement>('button[type="button"]')!.click(); paint();
    expect(input.type).toBe('text'); expect(input.value).toBe(' edited ');
    expect(host.querySelector('button[type="button"]')!.getAttribute('aria-label')).toBe(t('login.hidePassword'));
    expect(state.connect).not.toHaveBeenCalled();
  });
});
