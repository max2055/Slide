import { deferred, smtpRecipient } from './delivery-test-recipients.js';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { testDeliveryGate } from './delivery-test-gate.js';
import { NotificationService } from '../notification-service.js';
import { JobRegistry } from './job-registry.js';
import { registerNotificationHandlers } from './notification-handlers.js';
import { WorkerRuntime, type ClaimedJob, type WorkflowStore } from './worker-runtime.js';


class LeaseStore implements WorkflowStore {
  owner = '';
  token = 0;
  expires = 0;
  done = false;
  terminalOwners: string[] = [];
  constructor(readonly type: string) {}
  async claim(owner: string, seconds: number): Promise<ClaimedJob | null> {
    if (this.done || this.expires > Date.now()) return null;
    this.owner = owner;
    this.expires = Date.now() + seconds * 1000;
    return { id: 'delivery', type: this.type, payload: { alertId: 1, reportId: 1, channelId: 1 }, attempts: ++this.token, maxAttempts: 3, fencingToken: this.token };
  }
  async heartbeat(_id: string, owner: string, token: number, seconds: number) {
    if (owner === 'a' || owner !== this.owner || token !== this.token || this.expires <= Date.now()) return false;
    this.expires = Date.now() + seconds * 1000;
    return true;
  }
  async complete(_id: string, owner: string, token: number) {
    this.terminalOwners.push(owner);
    if (owner !== this.owner || token !== this.token || this.expires <= Date.now()) return false;
    this.done = true;
    return true;
  }
  async fail(_job: ClaimedJob, owner: string) { this.terminalOwners.push(owner); return false; }
}

afterEach(() => vi.restoreAllMocks());
it.each(['notification.deliver', 'report.notify'])('cancels stale %s before SMTP, lets the second worker deliver once', async (type) => {
  const smtp = await smtpRecipient();
  const heldRead = deferred<any>();
  const started = deferred<void>();
  const cancelled = deferred<void>();
  const alert = { id: 1, level: 'warning', title: 'test', message: 'test', created_at: new Date() } as any;
  const report = { id: 1, name: 'test', type: 'health', format: 'html', status: 'completed' } as any;
  let reads = 0;
  const gate = testDeliveryGate();
  const finish = vi.spyOn(gate, 'finish');
  const registry = new JobRegistry();
  const service = new NotificationService();
  registerNotificationHandlers(registry, {
    getAlertById: async () => alert,
    getChannelById: async () => { if (++reads === 1) { started.resolve(); return heldRead.promise; } return smtp.channel; },
  }, service, { getReportById: async () => report }, gate);
  const store = new LeaseStore(type);
  const a = new WorkerRuntime(store, 'a', 0.09);
  const b = new WorkerRuntime(store, 'b', 3);
  const first = a.runOnce((job, context) => {
    context.signal.addEventListener('abort', () => cancelled.resolve(), { once: true });
    return registry.execute(job, context);
  });
  try {
    await started.promise;
    await cancelled.promise;
    expect(await a.runOnce(async () => {})).toBe('running');
    await delay(Math.max(0, store.expires - Date.now() + 5));
    expect(await b.runOnce((job, context) => registry.execute(job, context))).toBe('completed');
    heldRead.resolve(smtp.channel);
    expect(await first).toBe('retry');
    expect(smtp.messages).toHaveLength(1);
    expect(store.terminalOwners).toEqual(['b']);
    expect(await a.runOnce((job, context) => registry.execute(job, context))).toBe('idle');
    expect(finish).toHaveBeenCalledTimes(1); // Only worker B can finish.
  } finally {
    heldRead.resolve(smtp.channel);
    await first;
    await a.shutdown();
    await b.shutdown();
    await smtp.close();
  }
}, 10000);

it('treats SMTP already accepted before cancellation as in flight, without new audit writes or retries', async () => {
  const acknowledgement = deferred<void>();
  const smtp = await smtpRecipient(acknowledgement.promise);
  const registry = new JobRegistry();
  const service = new NotificationService();
  const gate = testDeliveryGate();
  const finish = vi.spyOn(gate, 'finish');
  registerNotificationHandlers(registry, {
    getAlertById: async () => null,
    getChannelById: async () => smtp.channel,
  }, service, {
    getReportById: async () => ({ id: 1, name: 'report', type: 'health', format: 'html', status: 'completed' }) as any,
  }, gate);
  const store = new LeaseStore('report.notify');
  const worker = new WorkerRuntime(store, 'b', 3);
  const run = worker.runOnce((job, context) => registry.execute(job, context));
  try {
    await smtp.received.promise;
    expect(await worker.shutdown(10)).toBe(false);
    expect(smtp.messages).toHaveLength(1); // Cancellation cannot retract recipient acceptance.
    acknowledgement.resolve();
    expect(await run).toBe('cancelled');
    expect(finish).not.toHaveBeenCalled(); // Gate remains sending; no false sent summary.
    expect(store.terminalOwners).toEqual([]);
    expect(await worker.shutdown()).toBe(true);
  } finally {
    acknowledgement.resolve();
    await run;
    await worker.shutdown();
    await smtp.close();
  }
}, 10000);
