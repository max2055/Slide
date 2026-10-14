import type { SystemFailure } from '../investigations/system-event-bridge.js';
import { randomUUID } from 'node:crypto';
import { platformLogs } from './structured-log-evidence-adapter.js';

export type SystemFailureRecorder = (failure: SystemFailure) => Promise<unknown>;

/** Bounded non-blocking producer. A failed SQL write is explicitly lost;
 * process-local logs are never presented as a durable fallback. */
export class SystemFailurePublisher {
  private readonly pending = new Set<Promise<void>>();
  private lostEvents = 0;
  private acceptedEvents = 0;
  constructor(private readonly record: SystemFailureRecorder, private readonly capacity = 64) {
    if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 1024) throw new Error('SYSTEM_PUBLISHER_INVALID');
  }
  publish(failure: SystemFailure): void {
    if (this.pending.size >= this.capacity) { this.lostEvents++; return; }
    let frozen: SystemFailure;
    try { frozen = structuredClone(failure); } catch { this.lostEvents++; return; }
    let task: Promise<void>;
    task = Promise.resolve().then(() => this.record(frozen))
      .then(() => { this.acceptedEvents++; }, () => { this.lostEvents++; })
      .finally(() => { this.pending.delete(task); });
    this.pending.add(task);
  }
  async drain(): Promise<void> { while (this.pending.size) await Promise.all([...this.pending]); }
  observation() {
    return { persistence: 'mysql' as const, pending: this.pending.size, acceptedEvents: this.acceptedEvents,
      lostEvents: this.lostEvents, quality: this.lostEvents ? 'degraded' as const : 'good' as const,
      gaps: this.lostEvents ? ['SYSTEM_EVENT_WRITE_LOST'] : [] };
  }
}

let publisher: SystemFailurePublisher | undefined;
/** Composition-root only; no producer/model chooses a recorder or identity. */
export function installSystemFailurePublisher(value: SystemFailurePublisher): () => void {
  if (publisher) throw new Error('SYSTEM_PUBLISHER_ALREADY_INSTALLED');
  publisher = value;
  return () => { if (publisher === value) publisher = undefined; };
}
export function publishSystemFailure(failure: SystemFailure): void { publisher?.publish(failure); }
export function publishCollectorFailure(stableErrorCode: string, callsite: string): void {
  const id = randomUUID();
  platformLogs.record({ component: 'collector', eventType: 'collection.failed', status: 'failed', errorCode: stableErrorCode, correlationId: id });
  publishSystemFailure({ component: 'collector', sourceEventId: id, correlationId: id, occurredAt: new Date().toISOString(),
    stableErrorCode, callsite, origin: 'collector', releaseId: process.env.SLIDE_RELEASE_ID,
    commitSha: /^[a-f0-9]{40}$/.test(process.env.SLIDE_COMMIT_SHA ?? '') ? process.env.SLIDE_COMMIT_SHA : undefined });
}
export function systemFailureObservation() {
  return publisher?.observation() ?? { persistence: 'mysql', quality: 'unknown', gaps: ['SYSTEM_EVENT_BRIDGE_NOT_INSTALLED'] };
}
