import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const themeInitScript = readFileSync(
  path.resolve(process.cwd(), 'public/theme-init.js'),
  'utf8',
);

describe('theme initialization', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
    document.documentElement.removeAttribute('data-theme-mode');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('restores a persisted theme before the application starts', () => {
    localStorage.setItem(
      'slide.control.settings.v1:default',
      JSON.stringify({ theme: 'knot', themeMode: 'light' }),
    );

    window.eval(themeInitScript);

    expect(document.documentElement.getAttribute('data-theme')).toBe('openknot-light');
    expect(document.documentElement.getAttribute('data-theme-mode')).toBe('light');
  });

  it('resolves system mode using the browser preference', () => {
    localStorage.setItem(
      'slide.control.settings.v1:default',
      JSON.stringify({ theme: 'dash', themeMode: 'system' }),
    );
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true } as MediaQueryList)));

    window.eval(themeInitScript);

    expect(document.documentElement.getAttribute('data-theme')).toBe('dash-light');
    expect(document.documentElement.getAttribute('data-theme-mode')).toBe('light');
  });

  it('ignores malformed persisted settings', () => {
    localStorage.setItem('slide.control.settings.v1:default', '{');

    expect(() => window.eval(themeInitScript)).not.toThrow();
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });
});
