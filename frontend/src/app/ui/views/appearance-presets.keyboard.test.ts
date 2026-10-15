import { afterEach, expect, it, vi } from 'vitest';
import { AppearanceSettings } from './appearance-settings.ts';
import { i18n, t } from '../../i18n/index.ts';

afterEach(() => { document.body.replaceChildren(); localStorage.clear(); vi.restoreAllMocks(); });

it('names native preset buttons, preserves custom colors, updates selection and dispatches the existing preference', async () => {
  localStorage.setItem('slide.control.settings.v1:default', JSON.stringify({ accentColor: '#123456' }));
  await i18n.setLocale('en');
  const view = new AppearanceSettings(); document.body.append(view); await view.updateComplete;
  const presets = [...view.shadowRoot!.querySelectorAll<HTMLButtonElement>('.color-swatch')];
  expect(presets.every(button => button.tagName === 'BUTTON' && button.type === 'button')).toBe(true);
  expect(presets.every(button => button.getAttribute('aria-pressed') === 'false')).toBe(true);
  const changed = vi.fn(); window.addEventListener('slide-settings-change', changed);
  try {
    presets[1].click(); await view.updateComplete;
    expect(changed.mock.calls[0][0].detail).toEqual({ accentColor: '#22d3ee' });
    expect(presets[1].getAttribute('aria-pressed')).toBe('true');
    expect(presets.filter(button => button.getAttribute('aria-pressed') === 'true')).toHaveLength(1);
    expect(presets[1].getAttribute('aria-label')).toBe(t('appearance.colors.cyan'));
    await i18n.setLocale('zh-CN'); await view.updateComplete;
    expect(presets[1].getAttribute('aria-label')).toBe(t('appearance.colors.cyan'));
    expect(presets[1].getAttribute('aria-pressed')).toBe('true');
    expect(changed).toHaveBeenCalledTimes(1);
  } finally { window.removeEventListener('slide-settings-change', changed); }
});
