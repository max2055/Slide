import { afterEach, expect, it, vi } from 'vitest';
import { html, render } from 'lit';
import type { AppBadge } from './app-badge.js';
import type { AppToggle } from './app-toggle.js';
import type { StatCard } from '../../../components/stat-card.js';
import './app-badge.js';
import './app-toggle.js';
import '../../../components/stat-card.js';

afterEach(() => document.body.replaceChildren());

it('#445 keeps string attributes as text and template properties as markup', async () => {
  const root = document.createElement('div'); document.body.append(root);
  render(html`<stat-card hint="已存快照 &lt;表&gt;"></stat-card><stat-card .hint=${html`<span>正常 <b>2</b></span>`}></stat-card>`, root);
  const [text, template] = [...root.querySelectorAll<StatCard>('stat-card')];
  await Promise.all([text.updateComplete, template.updateComplete]);
  expect(text.hint).toBe('已存快照 <表>');
  expect(text.shadowRoot!.querySelector('[part=hint]')!.textContent).toBe('已存快照 <表>');
  expect(text.shadowRoot!.querySelector('[part=hint]')!.children).toHaveLength(0);
  expect(template.shadowRoot!.querySelector('b')!.textContent).toBe('2');
});

it('#646 exposes the default and property-bound variant to existing CSS', async () => {
  const badge = document.createElement('app-badge') as AppBadge;
  document.body.append(badge); await badge.updateComplete;
  expect(badge.getAttribute('variant')).toBe('muted');
  for (const variant of ['ok', 'danger', 'warn', 'info', 'muted'] as const) {
    badge.variant = variant; await badge.updateComplete;
    expect(badge.getAttribute('variant')).toBe(variant);
  }
});

it('#715 label and slider each emit once; disabled property blocks synthetic activation too', async () => {
  const toggle = document.createElement('app-toggle') as AppToggle;
  toggle.textContent = '启用'; document.body.append(toggle); await toggle.updateComplete;
  const change = vi.fn(); toggle.addEventListener('change', change);
  toggle.shadowRoot!.querySelector<HTMLElement>('.label')!.click(); await toggle.updateComplete;
  expect(toggle.checked).toBe(true); expect(change).toHaveBeenCalledTimes(1);
  expect(change.mock.calls[0][0].detail).toBe(true);
  toggle.shadowRoot!.querySelector('button')!.click(); await toggle.updateComplete;
  expect(toggle.checked).toBe(false); expect(change).toHaveBeenCalledTimes(2);
  toggle.disabled = true; await toggle.updateComplete;
  toggle.shadowRoot!.querySelector<HTMLElement>('.label')!.click();
  toggle.shadowRoot!.querySelector('button')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  expect(toggle.checked).toBe(false); expect(change).toHaveBeenCalledTimes(2);
});
