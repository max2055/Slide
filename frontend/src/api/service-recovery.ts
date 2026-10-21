export const SERVICE_RECOVERED_EVENT = 'slide-service-recovered';

/** Only a shared readiness GET is retried. Failed business requests are never
 * retained here, so recovery cannot replay writes or overwrite a form draft. */
export class ServiceRecovery {
  private failed = false;
  private consumers = 0;
  private attempts = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private pending?: Promise<void>;
  private controller?: AbortController;
  constructor(private readonly probe: (signal: AbortSignal) => Promise<boolean>,
    private readonly recovered: () => void, private readonly timeoutMs = 5_000) {}
  retain() { this.consumers++; if (this.failed) this.schedule(); }
  release() {
    this.consumers = Math.max(0, this.consumers - 1);
    if (!this.consumers) {
      if (this.timer) clearTimeout(this.timer);
      this.timer = undefined; this.controller?.abort();
    }
  }
  unavailable() { this.failed = true; this.schedule(); }
  visible() {
    if (this.failed && !this.pending) {
      if (this.timer) clearTimeout(this.timer);
      this.timer = undefined; this.schedule(0);
    }
  }
  private schedule(delay?: number) {
    if (!this.failed || !this.consumers || this.timer || this.pending) return;
    const backoff = Math.min(1_000 * 2 ** Math.min(this.attempts++, 5), 10_000);
    this.timer = setTimeout(() => { this.timer = undefined; void this.check(); }, delay ?? backoff * (0.75 + Math.random() * 0.25));
  }
  private check() {
    const controller = new AbortController(); this.controller = controller;
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    // Fetch observes AbortSignal. Retain pending until it actually settles;
    // non-cooperative transports cannot accumulate replacement probes.
    this.pending = this.probe(controller.signal).then(ready => {
      if (ready && !controller.signal.aborted && this.consumers) {
        this.failed = false; this.attempts = 0; this.recovered();
      }
    }).catch(() => {}).finally(() => {
      clearTimeout(timeout); this.pending = undefined; this.controller = undefined;
      this.schedule();
    });
    return this.pending;
  }
}

const recovery = new ServiceRecovery(async signal => {
  const response = await fetch('/api/health/ready', { method: 'GET', cache: 'no-store', signal });
  return response.ok && (await response.json()).ready === true;
}, () => window.dispatchEvent(new CustomEvent(SERVICE_RECOVERED_EVENT)));

export function reportServiceUnavailable() { recovery.unavailable(); }
const onVisible = () => { if (document.visibilityState === 'visible') recovery.visible(); };
let subscriptions = 0;
export function subscribeServiceRecovery(listener: () => void): () => void {
  window.addEventListener(SERVICE_RECOVERED_EVENT, listener);
  if (++subscriptions === 1) document.addEventListener('visibilitychange', onVisible);
  recovery.retain();
  let active = true;
  return () => {
    if (!active) return; active = false;
    window.removeEventListener(SERVICE_RECOVERED_EVENT, listener);
    if (--subscriptions === 0) document.removeEventListener('visibilitychange', onVisible);
    recovery.release();
  };
}
