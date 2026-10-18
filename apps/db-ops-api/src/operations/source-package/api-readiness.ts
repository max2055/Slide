/** The external lease and this child's durable standby receipt gate readiness.
 * The caller retains the operation deadline, cancellation and cleanup authority. */
export async function waitForSourceApi(probe: {
  assertActive(): Promise<void>;
  childRunning(): boolean;
  standby(): Promise<boolean>;
  health(): Promise<boolean>;
}): Promise<boolean> {
  const readyUntil = Date.now() + 30_000;
  while (Date.now() < readyUntil && probe.childRunning()) {
    await probe.assertActive();
    const standby = await probe.standby();
    // Standby workers deliberately report worker readiness as false. Only the
    // owned child's receipt plus API health permits the later business request.
    try {
      if (standby && await probe.health()) return true;
    } catch { /* bounded own child readiness; assertActive remains fail-closed */ }
    await new Promise(done => setTimeout(done, 100));
  }
  return false;
}
