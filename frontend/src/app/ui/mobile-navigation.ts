import type { ReactiveController, ReactiveControllerHost } from 'lit';

type NavigationHost = HTMLElement & ReactiveControllerHost & { navDrawerOpen: boolean };

/** The navigation uses the same native modal mechanism as app-dialog. */
export class MobileNavigationController implements ReactiveController {
  private media: MediaQueryList | null = null;
  private modal: HTMLDialogElement | null = null;
  private trigger: HTMLElement | null = null;
  private railTabIndexes = new Map<HTMLElement, string | null>();

  constructor(private host: NavigationHost) {
    host.addController(this);
  }

  private onContextChange = () => {
    // A drawer is transient; close it on history navigation and breakpoint changes.
    this.host.navDrawerOpen = false;
    this.host.requestUpdate();
  };

  hostConnected() {
    this.media = window.matchMedia('(max-width: 1100px)');
    this.media.addEventListener('change', this.onContextChange);
    window.addEventListener('popstate', this.onContextChange);
    this.host.addEventListener('keydown', this.onKeydown);
  }

  hostDisconnected() {
    this.media?.removeEventListener('change', this.onContextChange);
    window.removeEventListener('popstate', this.onContextChange);
    this.host.removeEventListener('keydown', this.onKeydown);
    this.closeModal();
  }

  private closeModal() {
    if (!this.modal) return;
    this.modal.close();
    this.modal = null;
    // Explicitly restore the opener after route renders too. On desktop it is hidden.
    if (this.trigger?.isConnected && this.trigger.getClientRects().length) this.trigger.focus();
    this.trigger = null;
  }

  hostUpdated() {
    for (const [control, tabindex] of this.railTabIndexes) {
      if (tabindex === null) control.removeAttribute('tabindex');
      else control.setAttribute('tabindex', tabindex);
    }
    this.railTabIndexes.clear();
    const nav = this.host.querySelector<HTMLDialogElement>('dialog.shell-nav');
    const mobile = Boolean(this.media?.matches);
    const open = mobile && Boolean(this.host.querySelector('.shell--nav-drawer-open'));
    if (this.modal && (this.modal !== nav || !open)) this.closeModal();
    if (!nav) return;
    // Existing compact rails stay clickable. Closed links do not join Tab order;
    // fully hidden drawers are inert. showModal handles the open background.
    const compactRail = !open && Boolean(this.host.querySelector('.shell--nav-collapsed')) &&
      !this.host.querySelector('settings-shell');
    nav.inert = mobile && !open && !compactRail;
    if (compactRail) {
      for (const control of nav.querySelectorAll<HTMLElement>('a[href], button')) {
        this.railTabIndexes.set(control, control.getAttribute('tabindex'));
        control.tabIndex = -1;
      }
    }
    if (open) {
      nav.setAttribute('aria-modal', 'true');
      if (!this.modal) {
        if (nav.open) nav.close();
        this.trigger = this.host.querySelector<HTMLElement>('.topbar-nav-toggle');
        this.modal = nav;
        nav.showModal();
      }
    } else {
      nav.removeAttribute('aria-modal');
      if (mobile && nav.open) nav.close();
    }
  }

  private onKeydown = (event: KeyboardEvent) => {
    if (!this.modal || event.key !== 'Tab' || event.defaultPrevented) return;
    // As in app-dialog, wrap the endpoints rather than letting Tab reach browser chrome.
    // Navigation controls are light DOM links and buttons.
    const controls = Array.from(this.modal.querySelectorAll<HTMLElement>('a[href], button:not(:disabled)'))
      .filter(el => el.tabIndex >= 0 && el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden');
    const first = controls[0], last = controls[controls.length - 1];
    if (!first || (event.shiftKey ? document.activeElement === first : document.activeElement === last)) {
      event.preventDefault();
      (event.shiftKey ? last : first)?.focus();
    }
  };
}
