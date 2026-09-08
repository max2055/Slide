export interface ClientRuntimeEvent { eventType: 'boot.completed' | 'runtime.error' | 'runtime.rejection'; buildId: string }
export function installPlatformRuntimeObservation(target: EventTarget, send: (body: ClientRuntimeEvent) => Promise<unknown>, authenticated: () => boolean, buildId: string) {
  const last = new Map<string, number>();
  const report = (eventType: ClientRuntimeEvent['eventType']) => {
    if (!authenticated()) return;
    const now = Date.now();
    if (last.has(eventType) && now - last.get(eventType)! < 60_000) return;
    last.set(eventType, now);
    // Never retain browser error objects, source URLs, messages or user content.
    void send({ eventType, buildId: /^[a-f0-9]{40}$/.test(buildId) ? buildId : 'unknown' }).catch(() => {});
  };
  const boot = () => report('boot.completed');
  const error = () => report('runtime.error');
  const rejection = () => report('runtime.rejection');
  target.addEventListener('slide-permissions-loaded', boot);
  target.addEventListener('error', error);
  target.addEventListener('unhandledrejection', rejection);
  boot();
  return () => {
    target.removeEventListener('slide-permissions-loaded', boot);
    target.removeEventListener('error', error);
    target.removeEventListener('unhandledrejection', rejection);
  };
}
