import { afterEach, expect, it, vi } from 'vitest';
import { MetricPolicyFields, numericFields, type NumberKey } from './metric-policy-fields.js';

afterEach(() => document.body.replaceChildren());

it('GH #647: clearing and invalid edits preserve overrides, then valid input converts units', async () => {
  const el = new MetricPolicyFields();
  el.disabled = false;
  el.overrides = { interval_ms: { mode: 'set', value: 60000 } };
  document.body.append(el);
  const changed = vi.fn((event: Event) => { el.overrides = (event as CustomEvent).detail; });
  el.addEventListener('policy-change', changed);
  await el.updateComplete;
  const input = el.shadowRoot!.querySelector('input')!;
  for (const value of ['', 'NaN', 'Infinity', '0', '-1', '86401']) {
    input.value = value;
    input.dispatchEvent(new Event('input'));
    await el.updateComplete;
    expect(changed).not.toHaveBeenCalled();
    expect(el.overrides.interval_ms).toEqual({ mode: 'set', value: 60000 });
  }
  input.value = '';
  input.dispatchEvent(new Event('input'));
  expect(input.value).toBe('');
  input.value = '1.234';
  input.dispatchEvent(new Event('input'));
  await el.updateComplete;
  expect(el.overrides.interval_ms).toEqual({ mode: 'set', value: 1234 });
});

it.each([
  ['interval_ms', 1, 86400], ['timeout_ms', .25, 30],
  ['stale_after_ms', .001, 86400], ['max_counter_gap_ms', .001, 86400],
  ['max_rows', 1, 100], ['max_concurrency', 1, 16], ['max_series_per_resource', 1, 10000],
] as [NumberKey, number, number][])('GH #647: %s accepts boundaries and rejects outside them', async (key, min, max) => {
  const el = new MetricPolicyFields();
  el.disabled = false;
  el.overrides = { [key]: { mode: 'set', value: 1 } };
  document.body.append(el);
  const changed = vi.fn();
  el.addEventListener('policy-change', changed);
  await el.updateComplete;
  const input = el.shadowRoot!.querySelector('input')!;
  expect(input.getAttribute('aria-label')).toBe(numericFields[key]);
  for (const value of [min, max]) {
    input.value = String(value);
    input.dispatchEvent(new Event('input'));
    expect(changed.mock.lastCall![0].detail[key]).toEqual({ mode: 'set', value: value * (key.endsWith('_ms') ? 1000 : 1) });
  }
  changed.mockClear();
  for (const value of [min - .001, max + .001]) {
    input.value = String(value);
    input.dispatchEvent(new Event('input'));
  }
  expect(changed).not.toHaveBeenCalled();
});
