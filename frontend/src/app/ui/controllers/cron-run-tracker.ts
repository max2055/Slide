import type { CronRunStatus } from '../../../api/generated/public-api.js';
import { authFetch } from '../../../api/index.js';

export interface TrackedCronRun { jobId: number; requestKey: string; runId?: string; status: CronRunStatus | 'unconfirmed'; summary?: string; }
const active = (status: string) => ['queued', 'running', 'unconfirmed'].includes(status);

/** One timer and abort controller per request/run; persists identifiers only. */
export class CronRunTracker {
  readonly runs = new Map<number, TrackedCronRun>();
  private timers = new Map<number, ReturnType<typeof setTimeout>>();
  private controllers = new Map<number, AbortController>();
  private stopped = true;
  private storageKey = '';
  constructor(private readonly changed: () => void) {}
  start(): void {
    this.stopped = false;
    let user: any;
    try { user = JSON.parse(localStorage.getItem('user') || 'null'); } catch { /* absent user */ }
    this.storageKey = `slide:cron-runs:${user?.id ?? user?.userId ?? user?.username ?? 'session'}`;
    try {
      const saved = JSON.parse(localStorage.getItem(this.storageKey) || '[]');
      for (const entry of saved) if (Number.isSafeInteger(entry.jobId) && typeof entry.requestKey === 'string') this.runs.set(entry.jobId, { ...entry, status: 'unconfirmed' });
    } catch { /* ignore malformed cache */ }
    for (const run of this.runs.values()) if (active(run.status)) this.schedule(run.jobId);
    this.changed();
  }
  stop(): void {
    this.stopped = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    for (const controller of this.controllers.values()) controller.abort();
    this.timers.clear(); this.controllers.clear();
  }
  private publish(): void {
    try { localStorage.setItem(this.storageKey, JSON.stringify([...this.runs.values()].map(({ jobId, requestKey, runId, status }) => ({ jobId, requestKey, runId, status })))); } catch { /* storage unavailable */ }
    if (!this.stopped) this.changed();
  }
  async trigger(jobId: number): Promise<void> {
    if (this.stopped || this.controllers.has(jobId) || this.runs.get(jobId)?.runId && active(this.runs.get(jobId)!.status)) return;
    const previous = this.runs.get(jobId);
    const run: TrackedCronRun = previous && active(previous.status) ? previous : { jobId, requestKey: crypto.randomUUID(), status: 'unconfirmed' };
    this.runs.set(jobId, run); this.publish();
    const controller = new AbortController(); this.controllers.set(jobId, controller);
    try {
      const response = await authFetch(`/api/cron/jobs/${jobId}/run`, { method: 'POST', headers: { 'Idempotency-Key': run.requestKey }, signal: controller.signal });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        if (response.status < 500) { this.runs.delete(jobId); this.publish(); }
        throw new Error(body.error || '触发失败');
      }
      const body = await response.json();
      if (body.jobId !== jobId || typeof body.runId !== 'string') throw new Error('运行状态待确认');
      Object.assign(run, { runId: body.runId, status: body.status });
      this.publish();
    } finally {
      this.controllers.delete(jobId);
      if (!this.stopped && this.runs.has(jobId)) this.schedule(jobId);
    }
  }
  private schedule(jobId: number): void {
    if (this.stopped || this.timers.has(jobId)) return;
    this.timers.set(jobId, setTimeout(() => { this.timers.delete(jobId); void this.poll(jobId); }, 3000));
  }
  private async poll(jobId: number): Promise<void> {
    const run = this.runs.get(jobId);
    if (!run || this.stopped || !active(run.status)) return;
    const controller = new AbortController(); this.controllers.set(jobId, controller);
    try {
      const url = run.runId ? `/api/cron/jobs/${jobId}/runs/${run.runId}` : `/api/cron/jobs/${jobId}/runs?requestKey=${encodeURIComponent(run.requestKey)}`;
      const response = await authFetch(url, { signal: controller.signal });
      if (!response.ok) throw new Error('状态待确认');
      const body = await response.json();
      if (body.jobId !== jobId || (run.runId && body.runId !== run.runId)) throw new Error('状态待确认');
      if (this.stopped) return;
      Object.assign(run, { runId: body.runId, status: body.status, summary: body.completion?.summary });
    } catch {
      if (!this.stopped) run.status = 'unconfirmed';
    } finally {
      this.controllers.delete(jobId);
      if (!this.stopped) { this.publish(); if (active(run.status)) this.schedule(jobId); }
    }
  }
}
