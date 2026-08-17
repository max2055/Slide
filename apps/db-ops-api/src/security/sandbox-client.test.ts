import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SandboxClient } from './sandbox-client.js';

describe('SandboxClient status', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('signs the empty status request body and returns controller status', async () => {
    const secret = 's'.repeat(32);
    const fetchMock = vi.fn(async (_url: URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      const timestamp = headers.get('x-slide-timestamp') ?? '';
      const nonce = headers.get('x-slide-nonce') ?? '';
      const expected = createHmac('sha256', secret)
        .update(timestamp).update('.').update(nonce).update('.').update(Buffer.alloc(0)).digest('hex');
      expect(headers.get('x-slide-signature')).toBe(expected);
      expect(init?.body).toBeUndefined();
      return new Response(JSON.stringify({ status: 'ok', activeJobs: 0 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new SandboxClient('http://sandbox-controller:3010', secret);
    await expect(client.status()).resolves.toEqual({ status: 'ok', activeJobs: 0 });
    expect(String(fetchMock.mock.calls[0][0])).toBe('http://sandbox-controller:3010/v1/status');
  });

  it('fails closed when the controller is not configured', async () => {
    const client = new SandboxClient('', 'short');
    expect(client.configured()).toBe(false);
    await expect(client.status()).rejects.toThrow('SANDBOX_CLIENT_NOT_CONFIGURED');
  });

  it('normalizes non-JSON controller responses without leaking their body', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('internal proxy detail', { status: 502 })));
    const client = new SandboxClient('http://sandbox-controller:3010', 's'.repeat(32));

    await expect(client.execute({ runtime: 'node', command: ['node', 'main.mjs'] }))
      .rejects.toThrow('SANDBOX_RESPONSE_INVALID');
  });

  it('returns only the status code for rejected JSON responses', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'secret detail' }), {
      status: 429,
      headers: { 'content-type': 'application/json' },
    })));
    const client = new SandboxClient('http://sandbox-controller:3010', 's'.repeat(32));

    await expect(client.execute({ runtime: 'node', command: ['node', 'main.mjs'] }))
      .rejects.toThrow('SANDBOX_REQUEST_FAILED:429');
  });

  it('preserves abort errors for fail-closed timeout mapping', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new DOMException('aborted', 'AbortError')));
    const client = new SandboxClient('http://sandbox-controller:3010', 's'.repeat(32));

    await expect(client.execute({ runtime: 'node', command: ['node', 'main.mjs'] }))
      .rejects.toMatchObject({ name: 'AbortError' });
  });
});
