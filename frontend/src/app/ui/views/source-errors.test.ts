import { expect, it } from 'vitest';
import { sourceErrorCodes } from '../../../../../apps/db-ops-api/src/platform/source-error-codes.js';
import { readSourceResponse, sourceError, sourceErrors } from './source-errors.js';

it.each(Object.keys(sourceErrors))('maps %s to Chinese guidance and controlled details', code => {
  const error = sourceError(code, 'github');
  expect(error.code).toBe(code);
  expect(error.message).toMatch(/[\u4e00-\u9fff]/);
  expect(error.message).not.toMatch(/SOURCE_|Error:|\{platform\}/);
});
it.each(['<html>Authorization: secret</html>', 'SOURCE_SECRET_TOKEN', new Error('https://user:secret@host'), undefined, '__proto__'])('does not expose unknown error %s', raw => {
  expect(sourceError(raw)).toEqual(sourceError('SOURCE_UNAVAILABLE'));
});
it('keeps signing configuration separate from platform authentication', () => {
  expect(sourceError('SOURCE_SIGNING_KEY_INVALID')).toMatchObject({ recovery: 'admin', detail: expect.stringContaining('至少 32 字节') });
  expect(sourceError('SOURCE_SIGNING_KEY_INVALID').message).not.toContain('令牌');
  expect(sourceError('SOURCE_CREDENTIAL_INVALID', 'gitlab').message).toContain('GitLab');
  expect(sourceError('SOURCE_UPSTREAM_FORBIDDEN', 'github').message).toContain('可能');
  expect(sourceError('SOURCE_REPOSITORY_NOT_FOUND').message).toContain('读取权限');
});
it.each([
  [new Response('<html>secret</html>', { status: 502 }), 'SOURCE_RESPONSE_INVALID'],
  [new Response(JSON.stringify({ error: 'Authorization: secret' }), { status: 500 }), 'SOURCE_UNAVAILABLE'],
  [new Response(JSON.stringify({ error: 'SOURCE_SIGNING_KEY_INVALID' }), { status: 503 }), 'SOURCE_SIGNING_KEY_INVALID'],
  [new Response('{}', { status: 429 }), 'SOURCE_RATE_LIMITED'],
  [new Response('{}', { status: 401 }), 'SOURCE_SESSION_REQUIRED'],
  [new Response('null'), 'SOURCE_RESPONSE_INVALID'],
])('parses unsafe or failed responses without arbitrary text', async (response, code) => {
  await expect(readSourceResponse(response as Response)).rejects.toThrow(code as string);
});

it('covers every controlled error emitted by the active source backend', () => {
  expect([...sourceErrorCodes].filter(code => !Object.hasOwn(sourceErrors, code))).toEqual([]);
});

it('classifies a failed response body transfer as a network failure', async () => {
  await expect(readSourceResponse({ text: async () => { throw new TypeError('network fixture-secret'); } } as unknown as Response)).rejects.toThrow('SOURCE_NETWORK_ERROR');
});
