import { describe, expect, it } from 'vitest';
import { rejectSourceHttp } from './http-receipt.js';

describe('bounded HTTP rejection evidence', () => {
  it.each([
    [403, { error: 'INVESTIGATION_OPERATION_FORBIDDEN', token: 'never-retain-secret' }, 'INVESTIGATION_OPERATION_FORBIDDEN'],
    [503, { error: 'arbitrary secret never-retain-secret' }, undefined],
    [401, { error: '无效的认证令牌' }, undefined],
  ])('retains only status and allowlisted product code: %s', async (status, body, code) => {
    try { await rejectSourceHttp(Response.json(body, { status, headers: { 'X-Secret': 'never-retain-secret' } }), 'CONTINUATION_HTTP_REJECTED'); }
    catch (e: any) {
      expect(e.message).toBe('V23_SOURCE_CONTINUATION_HTTP_REJECTED');
      expect(e.receipt).toEqual({ status, ...(code ? { code } : {}) });
      expect(JSON.stringify(e)).not.toContain('never-retain-secret'); return;
    }
    throw Error('expected rejection');
  });
  it('does not accept inherited object keys as known codes', async () => {
    await expect(rejectSourceHttp(Response.json({ error: 'toString' }, { status: 403 }), 'HTTP_REJECTED'))
      .rejects.toMatchObject({ receipt: { status: 403 } });
  });
  it('keeps received status even if response body is invalid/oversize/unavailable', async () => {
    for (const body of ['not json', JSON.stringify({ error: 'INVESTIGATION_OPERATION_FORBIDDEN', extra: 'x'.repeat(5000) })]) {
      await expect(rejectSourceHttp(new Response(body, { status: 403 }), 'HTTP_REJECTED'))
        .rejects.toMatchObject({ receipt: { status: 403 } });
    }
    const stream = new ReadableStream({ start(c) { c.error(Error('private transport text')); } });
    await expect(rejectSourceHttp(new Response(stream, { status: 503 }), 'HTTP_REJECTED')).rejects.toMatchObject({ receipt: { status: 503 } });
  });
});
