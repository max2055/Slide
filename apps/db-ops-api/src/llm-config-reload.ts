/**
 * Provider configuration is persisted before it reaches the runtime, so the two
 * outcomes are reported separately. A failed reload keeps the previous working
 * runtime configuration and returns a fixed code instead of raw error text.
 */
export interface ReloadLogger {
  warn(context: Record<string, unknown>, message: string): void;
}

export interface ReloadOutcome {
  applied: boolean;
  reloadError?: string;
}

export async function reloadOutcome(log: ReloadLogger, reload: () => Promise<void>): Promise<ReloadOutcome> {
  try {
    await reload();
    return { applied: true };
  } catch {
    log.warn({ code: 'LLM_CONFIGURATION_UNAVAILABLE' }, 'Provider reload failed after configuration change');
    return { applied: false, reloadError: 'LLM_CONFIGURATION_UNAVAILABLE' };
  }
}
