import { afterEach, describe, expect, it, vi } from 'vitest';
import { exchangeMicrosoftSmtpRefreshToken } from './smtp-oauth2.js';

describe('Microsoft SMTP OAuth2', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); vi.restoreAllMocks(); });

  it('exchanges a refresh token using the Outlook SMTP.Send scope', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ access_token: 'access-token', expires_in: 3600 }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(exchangeMicrosoftSmtpRefreshToken({
      tenant: 'consumers', clientId: 'client-id', refreshToken: 'refresh-token',
    })).resolves.toEqual({ accessToken: 'access-token' });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://login.microsoftonline.com/consumers/oauth2/v2.0/token',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(String(fetchMock.mock.calls[0][1].body)).toContain('scope=offline_access+https%3A%2F%2Foutlook.office.com%2FSMTP.Send');
  });

  it('returns a rotated refresh token so the caller can persist it', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      access_token: 'access-token', refresh_token: 'rotated-refresh-token',
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(exchangeMicrosoftSmtpRefreshToken({
      tenant: 'consumers', clientId: 'client-id', refreshToken: 'refresh-token',
    })).resolves.toEqual({
      accessToken: 'access-token', refreshToken: 'rotated-refresh-token',
    });
  });

  const input = { tenant: 'consumers', clientId: 'client-id', refreshToken: 'refresh-token' };

  it('MAX-592: rejects a pre-aborted caller without starting a request', async () => {
    const controller = new AbortController();
    const reason = new Error('caller stopped');
    controller.abort(reason);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(exchangeMicrosoftSmtpRefreshToken({ ...input, signal: controller.signal })).rejects.toBe(reason);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('MAX-592: forwards in-flight cancellation and removes the listener and deadline', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    let requestSignal!: AbortSignal;
    vi.stubGlobal('fetch', vi.fn((_url, options) => new Promise((_resolve, reject) => {
      requestSignal = options.signal;
      requestSignal.addEventListener('abort', () => reject(requestSignal.reason), { once: true });
    })));
    const reason = { code: 'workflow-cancelled' };
    const pending = exchangeMicrosoftSmtpRefreshToken({ ...input, signal: controller.signal });
    const assertion = expect(pending).rejects.toBe(reason);
    controller.abort(reason);
    await assertion;
    expect(requestSignal.aborted).toBe(true);
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['headers', 'body'])('MAX-592: bounds stalled %s and never retries', async phase => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((_url, options) => {
      const wait = () => new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
      });
      return phase === 'headers' ? wait() : Promise.resolve({ ok: true, json: wait });
    });
    vi.stubGlobal('fetch', fetchMock);
    const pending = exchangeMicrosoftSmtpRefreshToken({ ...input, timeoutMs: 25 });
    const assertion = expect(pending).rejects.toThrow('MICROSOFT_OAUTH_TOKEN_EXCHANGE_TIMEOUT');
    await vi.advanceTimersByTimeAsync(25);
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([0, -1, NaN, Infinity, 10_001, 0.5])('MAX-592: refuses an unbounded/invalid deadline %s', async timeoutMs => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(exchangeMicrosoftSmtpRefreshToken({ ...input, timeoutMs })).rejects.toThrow('MICROSOFT_OAUTH_TIMEOUT_INVALID');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('MAX-592: releases unread error bodies and hides remote credential-bearing errors', async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ cancel }), { status: 400 });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
    await expect(exchangeMicrosoftSmtpRefreshToken(input)).rejects.toThrow('MICROSOFT_OAUTH_TOKEN_EXCHANGE_FAILED');
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it.each([{}, { access_token: '' }, { access_token: 7 }])('MAX-592: rejects invalid token payloads', async payload => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(payload))));
    await expect(exchangeMicrosoftSmtpRefreshToken(input)).rejects.toThrow('MICROSOFT_OAUTH_TOKEN_INVALID');
  });

  it('MAX-592: success clears the deadline and caller listener', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    let requestSignal!: AbortSignal;
    vi.stubGlobal('fetch', vi.fn((_url, options) => {
      requestSignal = options.signal;
      return Promise.resolve(new Response(JSON.stringify({ access_token: 'test-access' })));
    }));
    await exchangeMicrosoftSmtpRefreshToken({ ...input, signal: controller.signal });
    expect(vi.getTimerCount()).toBe(0);
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    controller.abort();
    expect(requestSignal.aborted).toBe(false);
  });
});
