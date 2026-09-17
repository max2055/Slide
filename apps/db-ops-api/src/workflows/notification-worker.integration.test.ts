import { createServer, type Socket } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { NotificationService } from '../notification-service.js';
import { notificationDatabaseService } from '../notification-database-service.js';
import { JobRegistry } from './job-registry.js';
import { registerNotificationHandlers } from './notification-handlers.js';
import { WorkerRuntime, type ClaimedJob, type WorkflowStore } from './worker-runtime.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

// A local SMTP recipient: no external recipients, and no mocked send/sendMail.
async function smtpRecipient(acknowledge?: Promise<void>) {
  const sockets = new Set<Socket>();
  const messages: string[] = [];
  const received = deferred<void>();
  const server = createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    socket.write('220 localhost ESMTP\r\n');
    let input = '';
    let data = false;
    let body = '';
    socket.on('data', chunk => {
      input += chunk.toString();
      while (input.includes('\r\n')) {
        const end = input.indexOf('\r\n');
        const line = input.slice(0, end);
        input = input.slice(end + 2);
        if (data) {
          if (line !== '.') { body += line + '\n'; continue; }
          messages.push(body);
          received.resolve();
          body = '';
          data = false;
          if (acknowledge) void acknowledge.then(() => socket.write('250 accepted\r\n'));
          else socket.write('250 accepted\r\n');
        } else if (/^EHLO|^HELO/.test(line)) socket.write('250-localhost\r\n250 AUTH PLAIN\r\n');
        else if (/^AUTH/.test(line)) socket.write('235 authenticated\r\n');
        else if (/^DATA/.test(line)) { data = true; socket.write('354 send message\r\n'); }
        else if (/^QUIT/.test(line)) socket.end('221 bye\r\n');
        else socket.write('250 ok\r\n');
      }
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  return {
    messages, received,
    channel: { id: 1, name: 'local SMTP', enabled: true, type: 'email' as const,
      created_at: new Date(), updated_at: new Date(),
      config: { smtp_host: '127.0.0.1', smtp_port: address.port, smtp_secure: false, smtp_require_tls: false,
        smtp_username: 'test', password: 'test', from: 'sender@example.test', to: 'recipient@example.test' } },
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}

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
  const recordAttempt = vi.fn(async () => {});
  const recordReport = vi.fn(async () => {});
  const registry = new JobRegistry();
  const service = new NotificationService();
  vi.spyOn(notificationDatabaseService, 'recordNotification').mockResolvedValue({ success: true } as any);
  registerNotificationHandlers(registry, {
    getAlertById: async () => alert,
    getChannelById: async () => { if (++reads === 1) { started.resolve(); return heldRead.promise; } return smtp.channel; },
    recordDeliveryAttempt: recordAttempt,
  }, service, { getReportById: async () => report, recordNotificationDelivery: recordReport });
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
    const writes = type === 'report.notify' ? recordReport.mock.calls : recordAttempt.mock.calls;
    expect(writes).toHaveLength(2); // only B's started + sent
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
  const recordReport = vi.fn(async () => {});
  registerNotificationHandlers(registry, {
    getAlertById: async () => null,
    getChannelById: async () => smtp.channel,
    recordDeliveryAttempt: vi.fn(async () => {}),
  }, service, {
    getReportById: async () => ({ id: 1, name: 'report', type: 'health', format: 'html', status: 'completed' }) as any,
    recordNotificationDelivery: recordReport,
  });
  const store = new LeaseStore('report.notify');
  const worker = new WorkerRuntime(store, 'b', 3);
  const run = worker.runOnce((job, context) => registry.execute(job, context));
  try {
    await smtp.received.promise;
    expect(await worker.shutdown(10)).toBe(false);
    expect(smtp.messages).toHaveLength(1); // Cancellation cannot retract recipient acceptance.
    acknowledgement.resolve();
    expect(await run).toBe('cancelled');
    expect(recordReport).toHaveBeenCalledTimes(1); // started remains uncertain; no false sent/failed.
    expect(store.terminalOwners).toEqual([]);
    expect(await worker.shutdown()).toBe(true);
  } finally {
    acknowledgement.resolve();
    await run;
    await worker.shutdown();
    await smtp.close();
  }
}, 10000);
