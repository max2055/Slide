import { chatDatabaseService } from './chat-database-service.js';

const DEFAULT_RETENTION_DAYS = 30;
const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const DEFAULT_MAX_MESSAGES_PER_SESSION = 2000;

let cleanupTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Start automatic session cleanup and message cap enforcement.
 */
export function startSessionCleanup(intervalMs: number = DEFAULT_INTERVAL_MS): void {
  if (cleanupTimer) {
    console.log('[SessionCleanup] Already running');
    return;
  }

  const retentionDays = parseInt(process.env.SESSION_RETENTION_DAYS || String(DEFAULT_RETENTION_DAYS), 10);
  const maxMessages = parseInt(process.env.SESSION_MAX_MESSAGES || String(DEFAULT_MAX_MESSAGES_PER_SESSION), 10);

  console.log(`[SessionCleanup] Starting (retention: ${retentionDays}d, maxMsgs: ${maxMessages}, interval: ${intervalMs}ms)`);

  // Run cleanup immediately on startup
  runCleanup(retentionDays, maxMessages);

  // Schedule periodic cleanup
  cleanupTimer = setInterval(() => {
    runCleanup(retentionDays, maxMessages);
  }, intervalMs);
}

/**
 * Stop automatic session cleanup.
 */
export function stopSessionCleanup(): void {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
    console.log('[SessionCleanup] Stopped');
  }
}

async function runCleanup(retentionDays: number, maxMessages: number): Promise<void> {
  try {
    // 1. Delete expired sessions
    const deleted = await chatDatabaseService.deleteOldSessions(retentionDays);
    if (deleted > 0) {
      console.log(`[SessionCleanup] Deleted ${deleted} expired sessions`);
    }

    // 2. Enforce message cap on active sessions
    const activeSessions = await chatDatabaseService.getSessions(null, 100);
    for (const session of activeSessions) {
      const capDeleted = await chatDatabaseService.enforceMessageCap(session.session_id, maxMessages);
      if (capDeleted > 0) {
        console.log(`[SessionCleanup] Capped ${capDeleted} old messages in session ${session.session_id}`);
      }
    }
  } catch (err) {
    console.error('[SessionCleanup] Error during cleanup:', err);
  }
}
