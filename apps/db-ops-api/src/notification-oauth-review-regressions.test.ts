import { createServer, type Socket } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import nodemailer from 'nodemailer';
import { NotificationService } from './notification-service.js';
import { encryptData } from './db-connection.js';
import { notificationDatabaseService } from './notification-database-service.js';
import { exchangeMicrosoftSmtpRefreshToken } from './smtp-oauth2.js';

beforeEach(() => vi.stubEnv('ENCRYPTION_KEY', '0123456789abcdef0123456789abcdef'));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers(); });

const channel = (port: number) => ({ id: 1, name: 'MAX-592 isolated', type: 'email' as const, enabled: true,
  created_at: new Date(), updated_at: new Date(), config: { smtp_host: '127.0.0.1', smtp_port: port, smtp_require_tls: false,
    smtp_auth: 'oauth2' as const, smtp_username: 'test', from: 'sender@example.test', to: 'recipient@example.test',
    oauth2_tenant: 'consumers', oauth2_client_id: 'test', oauth2_refresh_token_encrypted: encryptData('synthetic-old') } });

function cancelAtJsonBoundary(payload: unknown, cancel: () => void) {
  const response = new Response(JSON.stringify(payload));
  const parse = response.json.bind(response);
  vi.spyOn(response, 'json').mockImplementation(async () => {
    const parsed = await parse();
    cancel();
    return parsed;
  });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
}

describe('MAX-592 independent review F1 regression', () => {
  it('saves a fully parsed validated rotation before propagating cancellation at the json continuation', async () => {
    const controller = new AbortController();
    const reason = { code: 'caller-cancel' };
    cancelAtJsonBoundary({ access_token: 'synthetic-access', refresh_token: 'synthetic-rotated' }, () => controller.abort(reason));
    const save = vi.spyOn(notificationDatabaseService, 'updateOAuth2RefreshToken').mockResolvedValue({ success: true });
    const transport = vi.spyOn(nodemailer, 'createTransport');
    const mark = vi.fn();
    await expect(new NotificationService().send(channel(12345), {}, controller.signal, undefined, undefined, mark)).rejects.toBe(reason);
    expect(save).toHaveBeenCalledExactlyOnceWith(1, 'synthetic-rotated', expect.objectContaining({ oauth2_client_id: 'test' }));
    expect(transport).not.toHaveBeenCalled();
    expect(mark).not.toHaveBeenCalled();
  });

  it('keeps caller cancellation if persisting the parsed rotation fails', async () => {
    const controller = new AbortController();
    const reason = new Error('cancel before persistence');
    cancelAtJsonBoundary({ access_token: 'synthetic-access', refresh_token: 'synthetic-rotated' }, () => controller.abort(reason));
    const save = vi.spyOn(notificationDatabaseService, 'updateOAuth2RefreshToken').mockRejectedValue(new Error('synthetic save failure'));
    const transport = vi.spyOn(nodemailer, 'createTransport');
    await expect(new NotificationService().send(channel(12345), {}, controller.signal)).rejects.toBe(reason);
    expect(save).toHaveBeenCalledTimes(1);
    expect(transport).not.toHaveBeenCalled();
  });

  it.each([{ refresh_token: 'synthetic-rotated' }, { access_token: '' }, { access_token: 1 }])(
    'does not persist an invalid parsed payload after cancellation: %s', async payload => {
      const controller = new AbortController();
      const reason = new Error('cancel invalid payload');
      cancelAtJsonBoundary(payload, () => controller.abort(reason));
      const save = vi.spyOn(notificationDatabaseService, 'updateOAuth2RefreshToken');
      const transport = vi.spyOn(nodemailer, 'createTransport');
      await expect(new NotificationService().send(channel(12345), {}, controller.signal)).rejects.toBe(reason);
      expect(save).not.toHaveBeenCalled();
      expect(transport).not.toHaveBeenCalled();
    });

  it('carries an exchange deadline that wins after full JSON parsing so it cannot permit SMTP', async () => {
    vi.useFakeTimers();
    cancelAtJsonBoundary({ access_token: 'synthetic-access', refresh_token: 'synthetic-rotated' }, () => vi.advanceTimersByTime(10_000));
    const save = vi.spyOn(notificationDatabaseService, 'updateOAuth2RefreshToken').mockResolvedValue({ success: true });
    const transport = vi.spyOn(nodemailer, 'createTransport');
    await expect(new NotificationService().send(channel(12345), {})).resolves.toEqual({ success: false, error: 'EMAIL_DELIVERY_FAILED' });
    expect(save).toHaveBeenCalledExactlyOnceWith(1, 'synthetic-rotated', expect.objectContaining({ oauth2_client_id: 'test' }));
    expect(transport).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('returns only validated rotation data plus the original interruption for its sole production caller', async () => {
    const controller = new AbortController();
    const reason = new Error('cancel parsed token');
    cancelAtJsonBoundary({ access_token: 'synthetic-access', refresh_token: 'synthetic-rotated' }, () => controller.abort(reason));
    await expect(exchangeMicrosoftSmtpRefreshToken({ tenant: 'consumers', clientId: 'test', refreshToken: 'synthetic-old', signal: controller.signal }))
      .resolves.toEqual({ accessToken: 'synthetic-access', refreshToken: 'synthetic-rotated', interruption: { reason } });
  });
});

// The endpoint counts complete DATA terminators. A dropped final response means
// unknown acceptance. It acknowledges any later attempt to expose unsafe replay.
async function recipient(dropFirstReply: boolean) {
  let received = 0;
  const sockets = new Set<Socket>();
  const server = createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    socket.write('220 local ESMTP\r\n');
    let input = '';
    let data = false;
    socket.on('data', chunk => {
      input += chunk.toString();
      while (input.includes('\r\n')) {
        const end = input.indexOf('\r\n');
        const line = input.slice(0, end);
        input = input.slice(end + 2);
        if (data) {
          if (line !== '.') continue;
          data = false;
          received++;
          if (dropFirstReply && received === 1) { socket.destroy(); return; }
          socket.write('250 accepted\r\n');
        } else if (line.startsWith('EHLO') || line.startsWith('HELO')) socket.write('250-local\r\n250 AUTH PLAIN\r\n');
        else if (line.startsWith('AUTH')) socket.write('235 ok\r\n');
        else if (line.startsWith('DATA')) { data = true; socket.write('354 go\r\n'); }
        else if (line.startsWith('QUIT')) socket.end('221 bye\r\n');
        else socket.write('250 ok\r\n');
      }
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { port: (server.address() as { port: number }).port, count: () => received,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    } };
}

describe('MAX-592 independent review F2 production sendWithRetry regression', () => {
  it.each(['oauth2', 'password'] as const)('never replays complete SMTP DATA without final 250 (%s)', async auth => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ access_token: 'synthetic-access' })));
    vi.stubGlobal('fetch', fetch);
    const smtp = await recipient(true);
    try {
      const target = { ...channel(smtp.port), config: { ...channel(smtp.port).config, smtp_auth: auth, password: 'synthetic-password' } };
      const result = await new NotificationService().sendWithRetry(target, { subject: 'synthetic', text: 'isolated' });
      expect(smtp.count()).toBe(1);
      expect(result).toEqual({ success: false, error: 'DELIVERY_OUTCOME_UNCERTAIN' });
      expect(fetch).toHaveBeenCalledTimes(auth === 'oauth2' ? 1 : 0);
    } finally { await smtp.close(); }
  }, 12_000);

  it('still retries OAuth preparation failure and performs exactly one successful SMTP send', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response('synthetic preparation failure', { status: 400 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'synthetic-access' }))));
    const smtp = await recipient(false);
    try {
      await expect(new NotificationService().sendWithRetry(channel(smtp.port), { text: 'isolated' })).resolves.toEqual({ success: true });
      expect(smtp.count()).toBe(1);
      expect(fetch).toHaveBeenCalledTimes(2);
    } finally { await smtp.close(); }
  }, 12_000);
});
