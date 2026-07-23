import { securityEventService } from './security-event-service.js';

export function createFatalProcessHandler(
  reasonCode: 'FATAL_UNCAUGHT_EXCEPTION' | 'FATAL_UNHANDLED_REJECTION',
  exit: (code: number) => never = process.exit,
  log: (message: string) => void = console.error,
  record: (reasonCode: string) => Promise<void> = async (code) => securityEventService.record({
    eventType: 'fatal_shutdown',
    reasonCode: code,
    resourceType: 'api-process',
  }),
  timeoutMs = 250,
): () => Promise<never> {
  return async () => {
    log(reasonCode);
    await Promise.race([
      record(reasonCode).catch(() => undefined),
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
    return exit(1);
  };
}
