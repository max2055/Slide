import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { i18n, t } from '../../i18n/index.ts';
import { DEFAULT_TAB_OPTIONS, TAB_GROUPS, UTILITY_TABS, titleForTab } from '../navigation.ts';
import { AppearanceSettings } from './appearance-settings.ts';
import '../components/app-select-field.ts';
import '../components/app-toggle.ts';
import '../components/app-option-group.ts';
import type { AppSelectField } from '../components/app-select-field.ts';

const storageKey = 'slide.control.settings.v1:default';
let view: AppearanceSettings;
async function mount(settings?: unknown) {
  if (settings !== undefined) localStorage.setItem(storageKey, JSON.stringify(settings));
  view = new AppearanceSettings();
  document.body.append(view);
  await view.updateComplete;
  await Promise.all([...view.shadowRoot!.querySelectorAll<AppSelectField>('app-select-field')].map(field => field.updateComplete));
  return [...view.shadowRoot!.querySelectorAll<AppSelectField>('app-select-field')];
}
async function select(field: AppSelectField, value: string) {
  const native = field.shadowRoot!.querySelector('select')!;
  native.value = value;
  native.dispatchEvent(new Event('change'));
  await field.updateComplete;
  await vi.waitFor(async () => { await view.updateComplete; });
}
beforeEach(async () => { localStorage.clear(); await i18n.setLocale('en'); });
afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });

describe('appearance labels and stored-value compatibility', () => {
  for (const locale of ['en', 'zh-CN'] as const) it(`${locale}: uses navigation titles without changing option values`, async () => {
    await i18n.setLocale(locale);
    const fields = await mount({ defaultTab: 'instances-db', visibleTabs: ['chat', 'instances-db'] });
    expect(fields[1].options).toEqual(DEFAULT_TAB_OPTIONS.map(tab => ({ value: tab, label: titleForTab(tab) })));
    expect(fields[1].value).toBe('instances-db');
    expect([...view.shadowRoot!.querySelectorAll('app-toggle')].slice(1, 18).map(toggle => toggle.textContent?.trim()))
      .toEqual([...TAB_GROUPS.flatMap(group => group.tabs), ...UTILITY_TABS].map(titleForTab));
    expect(fields[2].options[0].label).toBe(locale === 'en' ? '10 rows' : '10 条');
    expect(view.shadowRoot!.querySelector('h1')!.textContent).toBe(t('tabs.appearance'));
    expect(view.shadowRoot!.querySelector('.color-swatch')!.getAttribute('title')).toBe(t('appearance.colors.defaultBlue'));
    const changed = vi.fn(); window.addEventListener('slide-settings-change', changed);
    try {
      await select(fields[1], 'network-devices');
      expect(changed.mock.calls[0][0].detail).toEqual({ defaultTab: 'network-devices' });
      const toggle = [...view.shadowRoot!.querySelectorAll('app-toggle')].find(el => el.textContent?.trim() === titleForTab('instances-db'))!;
      toggle.dispatchEvent(new CustomEvent('change', { detail: false }));
      expect(changed.mock.calls[1][0].detail).toEqual({ visibleTabs: ['chat'] });
    } finally { window.removeEventListener('slide-settings-change', changed); }
  });

  it('selects the new default without migrating explicit old blue or custom colors', async () => {
    await mount({ accentColor: '#409eff', btnPalette: { primaryBg: '#123456' } });
    const swatch = view.shadowRoot!.querySelector<HTMLButtonElement>('.color-swatch')!;
    expect(swatch.getAttribute('aria-pressed')).toBe('false');
    const changed = vi.fn(); window.addEventListener('slide-settings-change', changed);
    try {
      swatch.click();
      expect(changed.mock.calls[0][0].detail).toEqual({ accentColor: '#265f99' });
      expect(JSON.parse(localStorage.getItem(storageKey)!).btnPalette.primaryBg).toBe('#123456');
    } finally { window.removeEventListener('slide-settings-change', changed); }
  });

  it.each([undefined, {}, { locale: 'unsupported' }, { locale: 'en' }])('uses the effective language for missing, invalid or stale locale: %j', async settings => {
    await i18n.setLocale('zh-CN');
    const fields = await mount(settings);
    expect(fields[0].value).toBe('zh-CN');
  });

  it('reacts to external language changes and stops observing on disconnect', async () => {
    await mount();
    await i18n.setLocale('zh-CN'); await view.updateComplete;
    expect(view.shadowRoot!.querySelector('h1')!.textContent).toBe('外观');
    view.remove(); const update = vi.spyOn(view, 'requestUpdate');
    await i18n.setLocale('en'); expect(update).not.toHaveBeenCalled();
  });

  it('does not persist a failed language load and restores the selector', async () => {
    const fields = await mount();
    vi.spyOn(i18n, 'setLocale').mockResolvedValue(undefined);
    const changed = vi.fn(); window.addEventListener('slide-settings-change', changed);
    try {
      await select(fields[0], 'zh-CN');
      expect(changed).not.toHaveBeenCalled();
      expect(fields[0].value).toBe('en');
    } finally { window.removeEventListener('slide-settings-change', changed); }
  });

  it('preserves retired route values with an explicit unavailable label until replaced', async () => {
    const stored = { defaultTab: 'retired-private-route', visibleTabs: ['chat'] };
    const fields = await mount(stored);
    expect(fields[1].options[0]).toEqual({ value: stored.defaultTab, label: t('appearance.unavailablePage') });
    expect(fields[1].shadowRoot!.querySelector('select')!.selectedOptions[0].textContent).not.toContain(stored.defaultTab);
    expect(JSON.parse(localStorage.getItem(storageKey)!)).toEqual(stored);
  });

  it.each(['{broken', 'null', '{"defaultTab":{},"visibleTabs":42}'])('recovers unreadable or malformed preferences: %s', async raw => {
    localStorage.setItem(storageKey, raw);
    const fields = await mount();
    expect(fields[1].value).toBe('dashboard');
    expect(view.shadowRoot!.querySelectorAll('app-toggle').length).toBeGreaterThan(10);
    expect(localStorage.getItem(storageKey)).toBe(raw);
  });
});
