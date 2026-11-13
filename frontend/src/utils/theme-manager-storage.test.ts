import { afterEach, expect, it, vi } from 'vitest';
import { loadSettings } from '../app/ui/storage.ts';
import { getThemeMode, getRoundness, initTheme, setThemeMode, setRoundness } from './theme-manager.ts';
afterEach(() => vi.restoreAllMocks());
it('MAX-652: denied storage reads still initialize the light default', () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new DOMException('denied', 'SecurityError'); });
  expect(() => initTheme()).not.toThrow();
  expect(getThemeMode()).toBe('light');
  expect(loadSettings().themeMode).toBe('light');
  expect(getRoundness()).toBe('default');
  expect(document.documentElement.dataset.themeMode).toBe('light');
});
it('MAX-652: denied storage writes preserve supported DOM settings', () => {
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('full', 'QuotaExceededError'); });
  expect(() => setThemeMode('light')).not.toThrow();
  expect(() => setRoundness('round')).not.toThrow();
  expect(document.documentElement.dataset.themeMode).toBe('light');
  expect(document.documentElement.dataset.roundness).toBe('round');
});
it.each(['system', 'light', 'dark'] as const)('preserves an explicitly stored supported mode: %s', mode => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(key => key === 'app-theme-mode' ? mode : 'round');
  expect(getThemeMode()).toBe(mode);
  expect(getRoundness()).toBe('round');
});
