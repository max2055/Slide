import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import mysql from 'mysql2/promise';
import nodemailer from 'nodemailer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbConnection, decryptData, encryptData } from './db-connection.js';
import { notificationDatabaseService } from './notification-database-service.js';
import { NotificationService } from './notification-service.js';
import { exchangeMicrosoftSmtpRefreshToken } from './smtp-oauth2.js';
import * as smtpOAuth from './smtp-oauth2.js';
import { deferred, smtpRecipient } from './workflows/delivery-test-recipients.js';
import { JobRegistry } from './workflows/job-registry.js';
import { registerNotificationHandlers } from './workflows/notification-handlers.js';
import { testDeliveryGate } from './workflows/delivery-test-gate.js';
import * as maintenance from './maintenance-notification.js';

// MAX-592 / #383: real fetch, response streams and Nodemailer sockets. Only the
// Microsoft destination is redirected to a task-exclusive loopback OAuth server.
describe('MAX-592 OAuth cancellation through notification delivery', () => {
  const realFetch = globalThis.fetch;
  let oauth: Server;
  let smtp: Awaited<ReturnType<typeof smtpRecipient>>;
  let mode: 'success' | 'headers' | 'body' | 'error';
  let requested: ReturnType<typeof deferred<void>>;
  let disconnected: ReturnType<typeof deferred<void>>;
  let requests: URLSearchParams[];
  let channel: ReturnType<typeof oauthChannel>;
  let service: NotificationService;
  const message = { subject: 'MAX-592 isolated delivery', text: 'controlled protocol acceptance' };

  function oauthChannel() {
    return { ...smtp.channel, config: { ...smtp.channel.config, smtp_auth: 'oauth2' as const,
      oauth2_tenant: 'consumers', oauth2_client_id: 'max592-test-client',
      oauth2_refresh_token_encrypted: encryptData('test-refresh') } };
  }

  beforeEach(async () => {
    vi.stubEnv('ENCRYPTION_KEY', '0123456789abcdef0123456789abcdef');
    mode = 'success';
    requests = [];
    requested = deferred<void>();
    disconnected = deferred<void>();
    oauth = createServer((req, res) => {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        requests.push(new URLSearchParams(body));
        res.on('close', () => disconnected.resolve());
        if (mode === 'success') res.end(JSON.stringify({ access_token: 'test-access', refresh_token: 'test-rotated' }));
        if (mode === 'body') { res.writeHead(200, { 'content-type': 'application/json' }); res.write('{"access_token":'); }
        if (mode === 'error') { res.writeHead(400); res.end('remote error with test-refresh and test-access'); }
        requested.resolve();
      });
    });
    await new Promise<void>(resolve => oauth.listen(0, '127.0.0.1', resolve));
    const port = (oauth.address() as { port: number }).port;
    vi.stubGlobal('fetch', vi.fn((url, options) => {
      expect(String(url)).toBe('https://login.microsoftonline.com/consumers/oauth2/v2.0/token');
      return realFetch(`http://127.0.0.1:${port}/token`, options);
    }));
    smtp = await smtpRecipient();
    channel = oauthChannel();
    service = new NotificationService();
    vi.spyOn(notificationDatabaseService, 'updateOAuth2RefreshToken').mockImplementation(async (_id, token) => {
      channel.config.oauth2_refresh_token_encrypted = encryptData(token);
      return { success: true };
    });
  });

  afterEach(async () => {
    // All caller promises settle before fixture cleanup. Destroy remaining
    // keep-alive sockets so a failed assertion cannot strand the local server.
    await smtp?.close();
    oauth?.closeAllConnections();
    if (oauth?.listening) await new Promise<void>((resolve, reject) => oauth.close(error => error ? reject(error) : resolve()));
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('persists rotation before actual SMTP and uses the rotated refresh token next time', async () => {
    const close: ReturnType<typeof vi.fn>[] = [];
    const createTransport = nodemailer.createTransport.bind(nodemailer);
    vi.spyOn(nodemailer, 'createTransport').mockImplementation(((options: any) => {
      const transport = createTransport(options);
      close.push(vi.spyOn(transport, 'close'));
      return transport;
    }) as typeof nodemailer.createTransport);
    const mark = vi.fn(() => expect(notificationDatabaseService.updateOAuth2RefreshToken).toHaveBeenCalled());
    await expect(service.send(channel, message, undefined, 'max592-first', undefined, mark)).resolves.toEqual({ success: true });
    await expect(service.send(channel, message)).resolves.toEqual({ success: true });
    expect(requests.map(body => body.get('refresh_token'))).toEqual(['test-refresh', 'test-rotated']);
    expect(requests[0].get('scope')).toBe('offline_access https://outlook.office.com/SMTP.Send');
    expect(smtp.messages).toHaveLength(2);
    expect(smtp.messages[0]).toContain(message.subject);
    expect(mark).toHaveBeenCalledTimes(1);
    expect(close).toHaveLength(2);
    for (const spy of close) expect(spy).toHaveBeenCalledTimes(1);
  });

  it.each(['headers', 'body'] as const)('cancels an in-flight %s request, retains the reason and never starts SMTP', async phase => {
    mode = phase;
    const controller = new AbortController();
    const reason = new Error('workflow cancelled');
    const mark = vi.fn();
    const pending = service.send(channel, message, controller.signal, undefined, undefined, mark);
    const result = expect(pending).rejects.toBe(reason);
    await requested.promise;
    controller.abort(reason);
    await result;
    await disconnected.promise;
    expect(requests).toHaveLength(1);
    expect(mark).not.toHaveBeenCalled();
    expect(smtp.messages).toHaveLength(0);
    expect(notificationDatabaseService.updateOAuth2RefreshToken).not.toHaveBeenCalled();
  });

  it('enforces the default 10-second exchange deadline through send without retrying or marking SMTP started', async () => {
    mode = 'headers';
    const mark = vi.fn();
    const start = performance.now();
    await expect(service.send(channel, message, undefined, undefined, undefined, mark))
      .resolves.toEqual({ success: false, error: 'EMAIL_DELIVERY_FAILED' });
    const elapsed = performance.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(9_900);
    expect(elapsed).toBeLessThan(13_000);
    await disconnected.promise;
    expect(requests).toHaveLength(1);
    expect(mark).not.toHaveBeenCalled();
    expect(smtp.messages).toHaveLength(0);
  }, 15_000);

  it('bounds actual response body consumption and disconnects a stalled stream', async () => {
    mode = 'body';
    await expect(exchangeMicrosoftSmtpRefreshToken({ tenant: 'consumers', clientId: 'test-client',
      refreshToken: 'test-refresh', timeoutMs: 100 })).rejects.toThrow('MICROSOFT_OAUTH_TOKEN_EXCHANGE_TIMEOUT');
    await disconnected.promise;
    expect(requests).toHaveLength(1);
  });

  it('retains a returned rotation when cancelled during persistence, then prevents SMTP', async () => {
    const controller = new AbortController();
    const reason = new Error('cancel during persistence');
    vi.mocked(notificationDatabaseService.updateOAuth2RefreshToken).mockImplementationOnce(async (_id, token) => {
      channel.config.oauth2_refresh_token_encrypted = encryptData(token);
      controller.abort(reason);
      return { success: true };
    });
    const mark = vi.fn();
    await expect(service.send(channel, message, controller.signal, undefined, undefined, mark)).rejects.toBe(reason);
    expect(decryptData(channel.config.oauth2_refresh_token_encrypted)).toBe('test-rotated');
    expect(mark).not.toHaveBeenCalled();
    expect(smtp.messages).toHaveLength(0);
  });

  it('persists a rotation when cancellation arrives just after exchange returns', async () => {
    const controller = new AbortController();
    const reason = new Error('cancel after exchange');
    const exchange = smtpOAuth.exchangeMicrosoftSmtpRefreshToken;
    vi.spyOn(smtpOAuth, 'exchangeMicrosoftSmtpRefreshToken').mockImplementationOnce(async input => {
      const result = await exchange(input);
      controller.abort(reason);
      return result;
    });
    const mark = vi.fn();
    await expect(service.send(channel, message, controller.signal, undefined, undefined, mark)).rejects.toBe(reason);
    expect(notificationDatabaseService.updateOAuth2RefreshToken).toHaveBeenCalledWith(channel.id, 'test-rotated', expect.objectContaining({ oauth2_client_id: channel.config.oauth2_client_id }));
    expect(decryptData(channel.config.oauth2_refresh_token_encrypted)).toBe('test-rotated');
    expect(mark).not.toHaveBeenCalled();
    expect(smtp.messages).toHaveLength(0);
  });

  it('does not send if rotation persistence fails and returns only a safe failure', async () => {
    vi.mocked(notificationDatabaseService.updateOAuth2RefreshToken).mockResolvedValueOnce({ success: false, error: 'private db diagnostic' });
    const mark = vi.fn();
    await expect(service.send(channel, message, undefined, undefined, undefined, mark))
      .resolves.toEqual({ success: false, error: 'EMAIL_DELIVERY_FAILED' });
    expect(mark).not.toHaveBeenCalled();
    expect(smtp.messages).toHaveLength(0);
  });

  it('does not expose the OAuth error body or retry unknown remote token results', async () => {
    mode = 'error';
    const log = vi.spyOn(console, 'error');
    await expect(service.send(channel, message)).resolves.toEqual({ success: false, error: 'EMAIL_DELIVERY_FAILED' });
    expect(requests).toHaveLength(1);
    expect(smtp.messages).toHaveLength(0);
    expect(log).not.toHaveBeenCalled();
  });

  it('propagates cancellation through deliverAlertToChannel without writing a sent audit', async () => {
    mode = 'headers';
    const record = vi.spyOn(notificationDatabaseService, 'recordNotification');
    const controller = new AbortController();
    const reason = new Error('alert worker stopped');
    const pending = service.deliverAlertToChannel({ id: 1, level: 'warning', title: 'isolated', message: 'test', created_at: new Date() } as any,
      channel, controller.signal);
    const result = expect(pending).rejects.toBe(reason);
    await requested.promise;
    controller.abort(reason);
    await result;
    expect(record).not.toHaveBeenCalled();
    expect(requests).toHaveLength(1);
  });

  it.each(['notification.deliver', 'report.notify'])('keeps %s cancellation before SMTP retryable through the production handler', async type => {
    mode = 'headers';
    vi.spyOn(maintenance, 'maintenanceBlocksDelivery').mockResolvedValue(false);
    const controller = new AbortController();
    const gate = testDeliveryGate();
    const finish = vi.spyOn(gate, 'finish');
    const registry = new JobRegistry();
    registerNotificationHandlers(registry, {
      getAlertById: async () => ({ id: 1, level: 'warning', title: 'isolated', message: 'test', created_at: new Date() }) as any,
      getChannelById: async () => channel,
    }, service, { getReportById: async () => ({ id: 1, name: 'isolated' }) as any }, gate);
    const pending = registry.execute({ id: randomUUID(), type,
      payload: { reportId: 1, alertId: 1, channelId: channel.id }, attempts: 1, maxAttempts: 3, fencingToken: 1,
    }, { workerId: 'max592', fencingToken: 1, signal: controller.signal });
    const result = expect(pending).rejects.toThrow('WORKFLOW_CANCELLED');
    await requested.promise;
    controller.abort(new Error('WORKFLOW_CANCELLED'));
    await result;
    expect(finish).toHaveBeenCalledTimes(1);
    expect(finish.mock.calls[0][3]).toBe('retryable');
    expect(finish.mock.calls[0][4]).toBe('WORKFLOW_CANCELLED');
    expect(finish.mock.calls[0][1].signal.aborted).toBe(false);
    expect(smtp.messages).toHaveLength(0);
    expect(requests).toHaveLength(1);
  });

  it('keeps cancellation after SMTP acceptance as cancellation and never replays through sendWithRetry', async () => {
    await smtp.close();
    const acknowledge = deferred<void>();
    smtp = await smtpRecipient(acknowledge.promise);
    channel = oauthChannel();
    const controller = new AbortController();
    const reason = new Error('cancel after remote acceptance');
    const pending = service.sendWithRetry(channel, message, 0, controller.signal);
    const result = expect(pending).rejects.toBe(reason);
    await smtp.received.promise;
    controller.abort(reason);
    acknowledge.resolve();
    await result;
    expect(smtp.messages).toHaveLength(1);
    expect(requests).toHaveLength(1);
  });

  // Explicit opt-in credentials, never developer files or the application's DB.
  // This tests the production encrypted UPDATE with a task-exclusive schema.
  it.skipIf(!process.env.MAX592_MYSQL_CONFIG).each(['persistence', 'parsed-json'] as const)(
    'persists rotation encrypted in real MySQL before cancelled delivery exits (%s)', async phase => {
    const config = JSON.parse(process.env.MAX592_MYSQL_CONFIG!);
    const database = `max592_${randomUUID().replaceAll('-', '')}`;
    const admin = mysql.createPool({ ...config, database: undefined });
    let pool: mysql.Pool | undefined;
    let created = false;
    try {
      await admin.query(`CREATE DATABASE ${database}`);
      created = true;
      pool = mysql.createPool({ ...config, database });
      await pool.query('CREATE TABLE notification_channels (id INT PRIMARY KEY, type VARCHAR(20), config JSON, updated_at DATETIME)');
      await pool.execute('INSERT INTO notification_channels (id,type,config) VALUES (?, ?, ?)', [channel.id, 'email', JSON.stringify(channel.config)]);
      vi.spyOn(dbConnection, 'getPool').mockReturnValue(pool);
      vi.mocked(notificationDatabaseService.updateOAuth2RefreshToken).mockRestore();
      const update = notificationDatabaseService.updateOAuth2RefreshToken.bind(notificationDatabaseService);
      const controller = new AbortController();
      const reason = new Error('cancel while encrypted update commits');
      if (phase === 'parsed-json') {
        const fetchEndpoint = globalThis.fetch;
        vi.stubGlobal('fetch', vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
          const response = await fetchEndpoint(input, init);
          const parse = response.json.bind(response);
          vi.spyOn(response, 'json').mockImplementation(async () => {
            const payload = await parse();
            controller.abort(reason);
            return payload;
          });
          return response;
        }));
      }
      vi.spyOn(notificationDatabaseService, 'updateOAuth2RefreshToken').mockImplementation(async (id, token, expected) => {
        const result = await update(id, token, expected);
        if (phase === 'persistence') controller.abort(reason);
        return result;
      });
      await expect(service.send(channel, message, controller.signal)).rejects.toBe(reason);
      const [rows] = await pool.query<any[]>('SELECT config FROM notification_channels WHERE id = ?', [channel.id]);
      const encrypted = rows[0].config.oauth2_refresh_token_encrypted;
      expect(encrypted).not.toBe('test-rotated');
      expect(decryptData(encrypted)).toBe('test-rotated');
      expect(smtp.messages).toHaveLength(0);
      expect(requests).toHaveLength(1);
    } finally {
      await pool?.end();
      if (created) await admin.query(`DROP DATABASE ${database}`);
      await admin.end();
    }
  });
});
