import { AsyncLocalStorage } from 'node:async_hooks';
import type { CronCompletion } from './cron-run-store.js';
export interface CronCompletionContext {
  runId: string;
  outputSchema?: Record<string, unknown> | null;
  signal: AbortSignal;
  save(completion: CronCompletion): Promise<void>;
  completion?: CronCompletion;
}
export const cronCompletionContext = new AsyncLocalStorage<CronCompletionContext>();
