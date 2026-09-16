import { expect, it } from 'vitest';
import { sourceOrigin, sourceRef } from './source-policy.js';

it('allows only the explicitly approved scheme, host and port', () => {
  const approved = ['http://gitlab.internal:8080', 'https://github.com'];
  expect(sourceOrigin(approved[0], approved).origin).toBe(approved[0]);
  expect(sourceOrigin(approved[1], approved).protocol).toBe('https:');
  for (const denied of ['https://gitlab.internal:8080', 'http://gitlab.internal', 'http://gitlab.internal:8080.evil.test',
    'http://user:secret@gitlab.internal:8080', 'http://gitlab.internal:8080/group', 'file:///tmp/repo',
    'http://gitlab.internal:8080?token=secret', 'http://gitlab.internal:8080#fragment']) {
    expect(() => sourceOrigin(denied, approved)).toThrow('SOURCE_ORIGIN_DENIED');
  }
});

it('accepts literal refs including Unicode but rejects revision expressions and refspecs', () => {
  for (const ref of ['main', 'refs/heads/release', 'v1.0', 'a'.repeat(40), '修复/内部同步', 'feature+test']) expect(sourceRef(ref)).toBe(ref);
  expect(sourceRef()).toBe('HEAD'); expect(sourceRef('')).toBe('HEAD');
  for (const ref of ['--upload-pack=evil', '+main', 'main:refs/heads/evil', 'HEAD~1', 'main..next', 'main@{1}', 'a b', 'a\nb',
    '/main', 'main/', '.hidden', 'a/.hidden', 'main.lock', 'main^{}', 'a\\b', 'main*', '@']) {
    expect(() => sourceRef(ref), ref).toThrow('SOURCE_REF_INVALID');
  }
});
