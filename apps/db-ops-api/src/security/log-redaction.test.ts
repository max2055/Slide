import { describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { installConsoleRedaction, redactLogValue, redactSensitiveText } from './log-redaction.js';
import { boundedToolValue, buildToolPreview } from '@slide/agent-core/tool-stream';

describe('exact replacement output (MAX-323 / #376)', () => {
  const cases = [
    ['Bearer synthetic.bearer.secret', '[REDACTED]'],
    ['bEaReR synthetic_bearer-secret==', '[REDACTED]'],
    ['sk-synthetic_api_secret', '[REDACTED]'],
    ['Bearer synthetic.first.secret; sk-synthetic_second_secret', '[REDACTED]; [REDACTED]'],
    ['password=synthetic password value', 'password=[REDACTED]'],
    ['API-KEY : synthetic key value', 'API-KEY : [REDACTED]'],
    ['Authorization: Bearer synthetic.header.secret', 'Authorization: [REDACTED]'],
    ['https://example.invalid/open-apis/bot/v2/hook/synthetic-webhook?status=ok', 'https://example.invalid/open-apis/bot/v2/hook/[REDACTED]?status=ok'],
  ] as const;

  it.each(cases)('preserves only the intended prefix: %s', (input, expected) => {
    expect(redactSensitiveText(input)).toBe(expected);
    expect(redactSensitiveText(input)).not.toContain('$1');
    expect(redactSensitiveText(input)).not.toContain('synthetic');
    expect(redactLogValue({ detail: input, error: new Error(input) })).toEqual({
      detail: expected, error: { name: 'Error', message: expected },
    });
  });

  it.each(['error', 'warn'] as const)('emits exact sanitized values through console.%s', (level) => {
    const target = { error: vi.fn(), warn: vi.fn() };
    const sink = target[level];
    installConsoleRedaction(target);
    for (const [input, expected] of cases) {
      target[level](input, new Error(input));
      expect(sink).toHaveBeenLastCalledWith(expected, { name: 'Error', message: expected });
    }
    expect(JSON.stringify(sink.mock.calls)).not.toContain('$1');
    expect(JSON.stringify(sink.mock.calls)).not.toContain('synthetic');
  });

  it('redacts actual process stderr without replacing the console sink', () => {
    const moduleUrl = new URL('./log-redaction.ts', import.meta.url).href;
    const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
      import { installConsoleRedaction } from ${JSON.stringify(moduleUrl)};
      installConsoleRedaction();
      for (const level of ['warn', 'error']) {
        for (const [input] of ${JSON.stringify(cases)}) console[level](input);
      }
    `], { encoding: 'utf8' });
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(0);
    expect(child.stdout).toBe('');
    expect(child.stderr).toBe([...cases, ...cases].map(([, expected]) => `${expected}\n`).join(''));
    expect(child.stderr).not.toContain('$1');
    expect(child.stderr).not.toContain('synthetic');
  });
});

describe('shared references and cycles (MAX-324 / #584)', () => {
  const sharedValue = () => ({
    host: 'db.invalid',
    API_KEY: 'synthetic-key',
    detail: 'token=synthetic spaced value',
    json: '{"password":["synthetic-json"],"status":"ok"}',
  });
  const redactedValue = {
    host: 'db.invalid',
    API_KEY: '[REDACTED]',
    detail: 'token=[REDACTED]',
    json: '{"password":"[REDACTED]","status":"ok"}',
  };

  it('preserves shared objects in sibling fields, nested fields and arrays without mutating input', () => {
    const shared = Object.freeze(sharedValue());
    const input = { left: shared, right: shared, nested: { value: shared }, items: [shared, shared] };
    expect(redactLogValue(input)).toEqual({
      left: redactedValue, right: redactedValue, nested: { value: redactedValue }, items: [redactedValue, redactedValue],
    });
    expect(shared).toEqual(sharedValue());
    expect(input.left).toBe(input.right);
  });

  it('preserves a shared array on every acyclic path', () => {
    const shared = Object.freeze([sharedValue(), 'status=ok']);
    expect(redactLogValue({ left: shared, right: shared, items: [shared, shared] })).toEqual({
      left: [redactedValue, 'status=ok'], right: [redactedValue, 'status=ok'],
      items: [[redactedValue, 'status=ok'], [redactedValue, 'status=ok']],
    });
  });

  it('marks self and mutual object cycles while preserving repeated cyclic branches', () => {
    const self: Record<string, unknown> = { status: 'ok' };
    self.self = self;
    expect(redactLogValue(self)).toEqual({ status: 'ok', self: '[CIRCULAR]' });
    const left: Record<string, unknown> = { password: 'synthetic' };
    const right = { left, status: 'ok' };
    left.right = right;
    const expected = { password: '[REDACTED]', right: { left: '[CIRCULAR]', status: 'ok' } };
    expect(redactLogValue({ first: left, second: left })).toEqual({ first: expected, second: expected });
  });

  it('terminates array self-cycles and mixed object/array cycles', () => {
    const array: unknown[] = [];
    array.push(array);
    expect(redactLogValue(array)).toEqual(['[CIRCULAR]']);
    const root = { items: [] as unknown[], private_key: 'synthetic' };
    root.items.push(root, root.items);
    expect(redactLogValue(root)).toEqual({ items: ['[CIRCULAR]', '[CIRCULAR]'], private_key: '[REDACTED]' });
  });

  it.each(['error', 'warn'] as const)('preserves shared content and redacts each argument at console.%s', (level) => {
    const target = { error: vi.fn(), warn: vi.fn() };
    const sink = target[level];
    installConsoleRedaction(target);
    const shared = sharedValue();
    const cycle: Record<string, unknown> = { status: 'ok' };
    cycle.self = cycle;
    const input = { left: shared, right: shared, items: [shared, shared], cycle };
    target[level](input, input, new Error('password=synthetic error value'));
    const expected = {
      left: redactedValue, right: redactedValue, items: [redactedValue, redactedValue],
      cycle: { status: 'ok', self: '[CIRCULAR]' },
    };
    expect(sink).toHaveBeenCalledExactlyOnceWith(expected, expected, { name: 'Error', message: 'password=[REDACTED]' });
    expect(JSON.stringify(sink.mock.calls)).not.toContain('synthetic');
  });
});

describe('JSON string redaction (MAX-321 / #693)', () => {
  it.each([739182641, -73.918, true, false, null, ['SYNTHETIC_7f3a'], { value: 'SYNTHETIC_7f3a' }, [{ value: ['quote"tail', 'brace} ]tail'] }], [], {}])('redacts non-string sensitive values at all five boundaries after Chief review: %j', (secret) => {
    const input = JSON.stringify({ token: secret, status: 'ok', ordinary: [1, { value: 'visible' }] });
    const expected = JSON.stringify({ token: '[REDACTED]', status: 'ok', ordinary: [1, { value: 'visible' }] });
    expect(redactSensitiveText(input)).toBe(expected);
    expect(boundedToolValue(input)).toBe(expected);
    expect(redactLogValue({ detail: input })).toEqual({ detail: expected });
    const target = { warn: vi.fn(), error: vi.fn() };
    const warn = target.warn;
    installConsoleRedaction(target);
    target.warn(input);
    expect(warn).toHaveBeenCalledWith(expected);
    expect(buildToolPreview(input, 'review-json', redactSensitiveText).text).toBe(expected);
    expect(redactLogValue({ token: secret, status: 'ok' })).toEqual({ token: '[REDACTED]', status: 'ok' });
  });

  it.each(['\n', '\r\n'])('preserves pretty JSON and ordinary non-string fields: %j', (newline) => {
    const input = `{${newline}  "token": [1, {"value":"synthetic"}],${newline}  "nested": {"api_key": {"value": [2,3]}, "count": 4},${newline}  "status": true${newline}}`;
    const expected = `{${newline}  "token": "[REDACTED]",${newline}  "nested": {"api_key": "[REDACTED]", "count": 4},${newline}  "status": true${newline}}`;
    expect(redactSensitiveText(input)).toBe(expected);
  });

  it.each(['password', 'passwd', 'pwd', 'secret', 'token', 'api_key', 'API-KEY', 'authorization', 'cookie', 'accessToken', 'private_key', 'connection_string', 'credential'])('redacts quoted %s at log and preview boundaries', (key) => {
    const input = JSON.stringify({ [key]: 'synthetic secret, with; delimiters', status: 'ok' });
    const expected = JSON.stringify({ [key]: '[REDACTED]', status: 'ok' });
    expect(redactSensitiveText(input)).toBe(expected);
    expect(redactLogValue({ detail: input })).toEqual({ detail: expected });
    expect(boundedToolValue(input, redactSensitiveText)).toBe(expected);
    expect(buildToolPreview(input, 'call-json', redactSensitiveText).text).toBe(expected);
  });

  it.each(['quote"secret', 'slash\\secret', 'line\nsecret', 'tab\tsecret', '', 'literal\\"tail'])('redacts complete escaped JSON values: %j', (secret) => {
    const input = `prefix ${JSON.stringify({ token: secret, visible: 'kept' })} suffix`;
    expect(redactSensitiveText(input)).toBe('prefix {"token":"[REDACTED]","visible":"kept"} suffix');
  });

  it('preserves ordinary token words, formatting, and multiple JSON fields', () => {
    const ordinary = 'The token is expired. {"message":"token expired", "status":"ok"}';
    expect(redactSensitiveText(ordinary)).toBe(ordinary);
    expect(redactSensitiveText('{ "token" : "first", "api_key": "second", "status": "ok" }'))
      .toBe('{ "token" : "[REDACTED]", "api_key": "[REDACTED]", "status": "ok" }');
  });

  it('redacts before console emission and preview truncation', () => {
    const target = { error: vi.fn(), warn: vi.fn() };
    const warn = target.warn;
    installConsoleRedaction(target);
    target.warn(new Error('{"password":"synthetic\\\"tail"}'));
    expect(warn).toHaveBeenCalledWith({ name: 'Error', message: '{"password":"[REDACTED]"}' });
    const preview = buildToolPreview(JSON.stringify({ token: 'synthetic'.repeat(2000) }), 'long-json', redactSensitiveText);
    expect(preview.text).toBe('{"token":"[REDACTED]"}');
    expect(preview.truncated).toBe(false);
  });
});

describe('log redaction', () => {
  it('redacts common credentials and webhook secrets from text', () => {
    const value = redactSensitiveText('Bearer abc.def password=hunter2 sk-secretvalue /open-apis/bot/v2/hook/tenant-secret');
    expect(value).not.toContain('abc.def');
    expect(value).not.toContain('hunter2');
    expect(value).not.toContain('secretvalue');
    expect(value).not.toContain('tenant-secret');
    expect(redactSensitiveText('Bearer abc.def')).not.toContain('abc.def');
    expect(redactSensitiveText('sk-secretvalue')).not.toContain('secretvalue');
    expect(redactSensitiveText('/open-apis/bot/v2/hook/tenant-secret')).toBe('/open-apis/bot/v2/hook/[REDACTED]');
  });

  it('redacts sensitive object keys and removes error stacks', () => {
    const result = redactLogValue({ username: 'admin', password: 'secret', nested: new Error('token=abc') });
    expect(result).toEqual({ username: 'admin', password: '[REDACTED]', nested: { name: 'Error', message: 'token=[REDACTED]' } });
  });

  it('wraps warning and error output at the process boundary', () => {
    const target = { error: vi.fn(), warn: vi.fn() } as unknown as Pick<Console, 'error' | 'warn'>;
    const error = target.error;
    installConsoleRedaction(target);
    target.error('password=secret');
    expect(error).toHaveBeenCalledWith('password=[REDACTED]');
  });

  it('redacts spaced secrets, Digest challenges, and cookie headers (MAX-315)', () => {
    const cases = [
      ['Authorization: Digest abc123xyz', 'Authorization: [REDACTED]', ['abc123xyz', 'Digest']],
      ['password=ab cd', 'password=[REDACTED]', ['ab', 'cd']],
      ['PASSWORD = ab cd', 'PASSWORD = [REDACTED]', ['ab', 'cd']],
      ['token: hello world', 'token: [REDACTED]', ['hello', 'world']],
      ['Token:hello world', 'Token:[REDACTED]', ['hello', 'world']],
      ['api_key: hello world', 'api_key: [REDACTED]', ['hello', 'world']],
      ['api-key=ab cd', 'api-key=[REDACTED]', ['ab', 'cd']],
      ['authorization: digest abc123xyz', 'authorization: [REDACTED]', ['abc123xyz', 'digest']],
      ['Cookie: session=abc123', 'Cookie: [REDACTED]', ['session=abc123', 'abc123']],
      ['cookie: SESSION=abc123', 'cookie: [REDACTED]', ['SESSION=abc123', 'abc123']],
      ['Set-Cookie: sid=abc123; HttpOnly', 'Set-Cookie: [REDACTED]', ['sid=abc123', 'abc123']],
      ['set-cookie: sid=abc 123; Secure', 'set-cookie: [REDACTED]', ['sid=abc 123', 'abc']],
      ['Cookie: a=secret1; b=secret2', 'Cookie: [REDACTED]', ['secret1', 'secret2']],
      ['cookie=abc123', 'cookie=[REDACTED]', ['abc123']],
      ['cookie=ab cd', 'cookie=[REDACTED]', ['ab', 'cd']],
      ['password=ab cd, keep-visible', 'password=[REDACTED], keep-visible', ['ab', 'cd']],
      ['token: hello world; next-field', 'token: [REDACTED]; next-field', ['hello', 'world']],
    ] as const;
    for (const [input, expected, forbidden] of cases) {
      const value = redactSensitiveText(input);
      expect(value).toBe(expected);
      expect(value).not.toContain('$1');
      for (const fragment of forbidden) expect(value).not.toContain(fragment);
    }
    const ordinary = redactSensitiveText('host=db.internal port=3306 status=ok');
    expect(ordinary).toBe('host=db.internal port=3306 status=ok');
  });

  it('redacts spaced secrets inside ordinary log object fields (MAX-315)', () => {
    expect(redactLogValue({
      note: 'Authorization: Digest abc123xyz',
      message: 'Cookie: session=abc123',
      warning: 'Set-Cookie: sid=abc123; HttpOnly',
      password: 'ab cd',
    })).toEqual({
      note: 'Authorization: [REDACTED]',
      message: 'Cookie: [REDACTED]',
      warning: 'Set-Cookie: [REDACTED]',
      password: '[REDACTED]',
    });
  });

  it.each([
    ['Authorization: Digest username=alice, response=synthetic_digest_secret', 'Authorization: [REDACTED]'],
    ['authorization: digest username=alice,response=synthetic_digest_secret', 'authorization: [REDACTED]'],
    ['AUTHORIZATION: DIGEST username="alice", realm="synthetic realm", response="synthetic_digest_secret", qop=auth', 'AUTHORIZATION: [REDACTED]'],
    ['aUtHoRiZaTiOn\t:\tDigest username=alice, nonce=synthetic_nonce; response=synthetic_digest_secret', 'aUtHoRiZaTiOn\t:\t[REDACTED]'],
    ['request failed: Authorization: Digest username=alice, response=synthetic_digest_secret\r\nhost=db.internal', 'request failed: Authorization: [REDACTED]\r\nhost=db.internal'],
    ['Authorization: Basic synthetic_basic_secret\nstatus=ok', 'Authorization: [REDACTED]\nstatus=ok'],
    ['Authorization: Bearer synthetic.bearer.secret', 'Authorization: [REDACTED]'],
  ])('redacts complete Authorization header values after Digest comma regression (MAX-315): %s', (input, expected) => {
    expect(redactSensitiveText(input)).toBe(expected);
    expect(redactLogValue({ detail: input })).toEqual({ detail: expected });
  });

  it.each(['\n', '\r\n'])(
    'preserves following lines after ordinary assignments (MAX-315 CI regression): %j',
    (newline) => {
      for (const key of ['password', 'passwd', 'secret', 'token', 'api_key', 'api-key', 'cookie', 'authorization']) {
        const input = `${key}=synthetic spaced value${newline}mysql://db.invalid/db`;
        const expected = `${key}=[REDACTED]${newline}mysql://db.invalid/db`;
        expect(redactSensitiveText(input)).toBe(expected);
        expect(redactLogValue({ detail: input })).toEqual({ detail: expected });
        expect(redactSensitiveText(`${key}=synthetic \t${newline}status=ok`))
          .toBe(`${key}=[REDACTED] \t${newline}status=ok`);
        expect(redactSensitiveText(`${key}=${newline}mysql://db.invalid/db`))
          .toBe(`${key}=${newline}mysql://db.invalid/db`);
      }
      expect(redactSensitiveText(`api_key=synthetic${newline}token=hello world${newline}status=ok`))
        .toBe(`api_key=[REDACTED]${newline}token=[REDACTED]${newline}status=ok`);
    },
  );
});
