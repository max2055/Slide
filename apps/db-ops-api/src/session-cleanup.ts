import { ChatRetentionDeniedError, ChatSessionNotFoundError, chatDatabaseService } from './chat-database-service.js';
import { parseSessionRetentionDays } from './session-retention.js';

const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const DEFAULT_MAX_MESSAGES_PER_SESSION = 2000;

let cleanupTimer: ReturnType<typeof setInterval> | null = null;
let cleanupController: AbortController | null = null;

/**
 * Start automatic session cleanup and message cap enforcement.
 */
export function startSessionCleanup(intervalMs: number = DEFAULT_INTERVAL_MS): void {
  if (cleanupTimer) {
    console.log('[SessionCleanup] Already running');
    return;
  }

  const retentionDays = parseSessionRetentionDays(process.env.SESSION_RETENTION_DAYS);
  const maxMessages = parseInt(process.env.SESSION_MAX_MESSAGES || String(DEFAULT_MAX_MESSAGES_PER_SESSION), 10);

  console.log(`[SessionCleanup] Starting (retention: ${retentionDays}d, maxMsgs: ${maxMessages}, interval: ${intervalMs}ms)`);

  const batchSize = parseBatchSize(process.env.SESSION_CLEANUP_BATCH_SIZE);
  const controller = new AbortController();
  cleanupController = controller;
  let running = false;
  // Observe failures at the scheduler boundary; the worker propagates fatal errors.
  const cleanup = async () => {
    if (running || controller.signal.aborted) return;
    running = true;
    try {
      await runCleanup(retentionDays, maxMessages, { batchSize, signal: controller.signal });
    } catch (err) {
      if (!controller.signal.aborted) console.error('[SessionCleanup] Error during cleanup:', err);
    } finally {
      running = false;
    }
  };
  cleanup();

  // Schedule periodic cleanup
  cleanupTimer = setInterval(() => {
    cleanup();
  }, intervalMs);
}

/**
 * Stop automatic session cleanup.
 */
export function stopSessionCleanup(): void {
  cleanupController?.abort();
  cleanupController = null;
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
    console.log('[SessionCleanup] Stopped');
  }
}

function parseBatchSize(value: string | undefined): number {
  if (value === undefined || value === '') return 1000;
  if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new TypeError('Maintenance batch size must be a positive integer');
  }
  return Number(value);
}

type MaintenanceStore = Pick<typeof chatDatabaseService,
  'deleteOldSessionsForMaintenance' | 'getSessionsForMaintenance' | 'enforceMessageCapForMaintenance'>;

export async function runCleanup(retentionDays: number, maxMessages: number, options: {
  store?: MaintenanceStore;
  batchSize?: number;
  signal?: AbortSignal;
} = {}): Promise<{ processed: number; skipped: number; deletedMessages: number }> {
  const { store = chatDatabaseService, batchSize = 1000, signal } = options;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1) throw new TypeError('Maintenance batch size must be a positive integer');
  signal?.throwIfAborted();
  const deleted = await store.deleteOldSessionsForMaintenance(retentionDays);
  if (deleted > 0) console.log(`[SessionCleanup] Deleted ${deleted} expired sessions`);

  const result = { processed: 0, skipped: 0, deletedMessages: 0 };
  let beforeId: number | undefined;
  while (true) {
    signal?.throwIfAborted();
    // IDs remain stable when capping changes last_message_at or sessions disappear.
    // Sessions inserted after the first page are handled by the next cleanup.
    const sessions = await store.getSessionsForMaintenance(batchSize, beforeId);
    for (const session of sessions) {
      signal?.throwIfAborted();
      try {
        result.deletedMessages += await store.enforceMessageCapForMaintenance(session.session_id, maxMessages);
        result.processed++;
      } catch (error) {
        signal?.throwIfAborted();
        if (!(error instanceof ChatRetentionDeniedError) && !(error instanceof ChatSessionNotFoundError)) throw error;
        result.skipped++;
      }
    }
    if (sessions.length < batchSize) break;
    beforeId = sessions[sessions.length - 1].id;
  }
  signal?.throwIfAborted();
  console.log(`[SessionCleanup] Message cap complete: processed=${result.processed}, skipped=${result.skipped}, deletedMessages=${result.deletedMessages}`);
  return result;
}
