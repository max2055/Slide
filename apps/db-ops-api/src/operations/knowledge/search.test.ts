import { describe, expect, it } from 'vitest';
import { CaseCursorCodec, caseTokens } from './search.js';

describe('case search protocol', () => {
  it('matches Chinese phrases with bigrams, English versions and single characters', () => {
    expect(caseTokens('数据库连接池耗尽 MySQL 8.0')).toEqual(expect.arrayContaining(['数据库'.slice(0, 2), '连接', '接池', '耗尽', 'mysql', '8', '0']));
    expect(caseTokens('连接池', true)).toEqual(['接池', '连接']);
    expect(caseTokens('池', true)).toEqual(['池']);
    expect(caseTokens('ＭｙＳＱＬ', true)).toEqual(['mysql']);
    expect(() => caseTokens('a '.repeat(5000))).not.toThrow();
    expect(() => caseTokens(Array.from({ length: 81 }, (_, n) => `t${n}`).join(' '), true)).toThrow();
  });
  it('hides and binds cursor positions to query, live authority and lifetime', () => {
    const codec = new CaseCursorCodec(Buffer.alloc(32, 4));
    const input = { after: '99999999-9999-4999-8999-999999999999', asOf: '2026-10-16T00:00:00.000Z',
      filter: 'f'.repeat(64), authority: 'a'.repeat(64), expires: Date.parse('2026-10-16T00:10:00.000Z') };
    const encoded = codec.encode(input), now = Date.parse(input.asOf);
    expect(Buffer.from(encoded, 'base64url').toString()).not.toContain(input.after);
    expect(codec.decode(encoded, input.filter, input.authority, now)).toEqual(input);
    for (const [cursor, filter, authority, time] of [[encoded.slice(0, -4) + 'xxxx', input.filter, input.authority, now],
      [encoded, 'e'.repeat(64), input.authority, now], [encoded, input.filter, 'b'.repeat(64), now],
      [encoded, input.filter, input.authority, input.expires]] as const) {
      expect(() => codec.decode(cursor, filter, authority, time)).toThrow();
    }
  });
});
