import type { LitElement } from 'lit';

export async function retryReadWithFocus(
  view: LitElement,
  event: Event,
  load: () => Promise<void>,
  successSelector?: string,
): Promise<void> {
  const root = view.shadowRoot;
  const region = root?.querySelector<HTMLElement>('[data-read-results]');
  const ownsFocus = region && root?.activeElement === event.currentTarget;

  // Move focus before rendering removes the focused retry button.
  if (ownsFocus) region.focus();
  await load();
  if (!ownsFocus) return;

  await view.updateComplete;
  if (root?.activeElement !== region || region.getAttribute('aria-busy') !== 'false') return;

  const retry = region.querySelector<HTMLElement>('[data-read-retry]');
  const target = retry ?? (successSelector ? region.querySelector<HTMLElement>(successSelector) : null);
  target?.focus();
}
