import { describe, expect, it } from 'vitest';
import { parseInlineDirectives } from './directive-tags.ts';
import { normalizeMessage } from '../../ui/chat/message-normalizer.ts';

describe('MAX-632 / #634 whitespace preservation', () => {
  it.each([
    'SELECT  *  FROM t;  \n\n\nnext  ',
    'use `SELECT  *` now  ',
    '```sql\nSELECT  *  FROM t;  \n\n\n',
    '~~~sql\nSELECT  *  FROM t;  \n',
    '    SELECT  *  \n\tFROM t  ',
    'unknown [[literal]]  \n\n\ntext  ',
    'a\r\n\r\n\r\nb  ',
    'use `media:`  \n\n\nnext  ',
    '```sql\nMEDIA: fixture.png  \n\n\n',
  ])('preserves ordinary text byte for byte: %j', text => {
    expect(parseInlineDirectives(text).text).toBe(text);
    expect(normalizeMessage({ role: 'assistant', content: text }).content).toEqual([{ type: 'text', text }]);
  });

  it('cleans only the space left by a reply tag', () => {
    const parsed = parseInlineDirectives('hello  [[reply_to:123]]  world  \n\n\n`SELECT  *`  ');
    expect(parsed.text).toBe('hello world  \n\n\n`SELECT  *`  ');
    expect(parsed.replyToId).toBe('123'); expect(parsed.hasReplyTag).toBe(true);
  });

  it('removes a directive-only line without rewriting other lines', () => {
    expect(parseInlineDirectives('[[reply_to_current]]\nSELECT  *  \n\n\n').text).toBe('SELECT  *  \n\n\n');
  });

  it('preserves whitespace when stripping is disabled', () => {
    const text = ' [[reply_to_current]]  `SELECT  *`  \n\n\n';
    expect(parseInlineDirectives(text, { stripReplyTags: false }).text).toBe(text);
  });
});
