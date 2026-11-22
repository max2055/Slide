import { describe, expect, it } from 'vitest';
import { parseInlineDirectives } from './directive-tags.ts';
import { normalizeMessage } from '../../ui/chat/message-normalizer.ts';
import { toSanitizedMarkdownHtml } from "../../ui/markdown.ts";


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

describe('MAX-705 / #1030 literal reply tags in code', () => {
  it.each([
    '示例 `  [[reply_to_current]]  [[reply_to:literal]]  `  \n\n',
    '``  [[reply_to_current]]  `one`  [[reply_to:literal]]  ``',
    '```text\r\n  [[reply_to_current]]  \r\n\r\n  [[reply_to:literal]]\t\r\n```  \r\n',
    '~~~text\n\t[[reply_to_current]]  \n  [[reply_to:literal]]  \n~~~\n',
    '```text\n  [[reply_to:literal]]  \n\n  [[reply_to_current]]\t',
    '~~~~text\n~~~\n  [[reply_to:literal]]  \n\n  [[reply_to_current]]\t',
  ])('preserves text and leaves reply metadata unset: %j', text => {
    expect(parseInlineDirectives(text, { currentMessageId: 'current' })).toMatchObject({
      text,
      hasReplyTag: false,
      replyToCurrent: false,
    });
    expect(parseInlineDirectives(text).replyToId).toBeUndefined();
    const message = normalizeMessage({ role: 'assistant', content: text });
    expect(message.content).toEqual([{ type: 'text', text }]);
    expect(message.replyTarget).toBeUndefined();
  });

  it('handles real directives between and beside code regions', () => {
    const closed = '```text\r\n  [[reply_to_current]]\t\r\n```  \r\n';
    const prose = '说明  `  [[reply_to:example]]  `  \n\n';
    const open = '~~~text\n  [[reply_to:open]]\t';
    const text = `[[reply_to:first]]\r\n${closed}[[reply_to:last]]\r\n${prose}${open}`;
    const cleaned = closed + prose + open;

    expect(parseInlineDirectives(text)).toMatchObject({
      text: cleaned,
      hasReplyTag: true,
      replyToId: 'last',
      replyToExplicitId: 'last',
      replyToCurrent: false,
    });
    expect(parseInlineDirectives(text, { stripReplyTags: false })).toMatchObject({
      text,
      replyToExplicitId: 'last',
      replyToCurrent: false,
    });
    expect(normalizeMessage({ role: 'assistant', content: [{ type: 'text', text }] })).toMatchObject({
      content: [{ type: 'text', text: cleaned }],
      replyTarget: { kind: 'id', id: 'last' },
    });
  });

  it('resolves the current message when the explicit ID is a code example', () => {
    const example = '`[[reply_to:example]]`';
    const text = `说明  [[reply_to_current]]  ${example}  `;
    expect(parseInlineDirectives(text, { currentMessageId: ' current ' })).toMatchObject({
      text: `说明 ${example}  `,
      hasReplyTag: true,
      replyToId: 'current',
      replyToCurrent: true,
    });
    expect(normalizeMessage({ role: 'assistant', content: text })).toMatchObject({
      replyTarget: { kind: 'current' },
    });
  });

  it('keeps a real directive between unmatched backtick runs', () => {
    expect(parseInlineDirectives('开头 `` [[reply_to:real]] `  结尾')).toMatchObject({
      text: '开头 `` `  结尾',
      replyToId: 'real',
    });
  });

  it('handles a triple-backtick inline span at the start of a line', () => {
    const example = '```  [[reply_to:example]]  ```';
    expect(parseInlineDirectives(`${example}  [[reply_to:real]]  说明`)).toMatchObject({
      text: `${example} 说明`,
      replyToId: 'real',
    });
  });

  it('keeps a real directive after an escaped backtick or a paragraph break', () => {
    for (const prefix of ['\\`', '`开头\r\n\r\n']) {
      expect(parseInlineDirectives(`${prefix}说明 [[reply_to:real]] 结尾\``)).toMatchObject({
        text: `${prefix}说明 结尾\``,
        replyToId: 'real',
      });
    }
  });
});

describe('MAX-705 reply tags follow Markdown code boundaries', () => {
  const example = '[[reply_to:example]]';
  const wanted = { kind: 'id', id: 'wanted' };
  const normalize = (content: string) => normalizeMessage({ role: 'assistant', content });

  it('parses a reply between unmatched backticks in a heading and a paragraph', () => {
    const source = '# 标题 `\n正文 [[reply_to:wanted]] `  ';
    expect(toSanitizedMarkdownHtml(source)).not.toContain('<code>');
    expect(normalize(source)).toMatchObject({
      content: [{ type: 'text', text: '# 标题 `\n正文 `  ' }],
      replyTarget: wanted,
    });
  });

  it('protects a multiline inline code span within a single paragraph', () => {
    const code = '讲义 `示例\r\n' + example + '`';
    const source = code + ' [[reply_to:wanted]] 正文';
    expect(toSanitizedMarkdownHtml(source)).toContain('<code>示例 ' + example + '</code>');
    expect(normalize(source)).toMatchObject({
      content: [{ type: 'text', text: code + ' 正文' }],
      replyTarget: wanted,
    });
  });

  it('matches inline backticks within each rendered table cell', () => {
    const source = '| ` | [[reply_to:wanted]] ` | `' + example + '` |\n| --- | --- | --- |';
    expect(toSanitizedMarkdownHtml(source).match(/<code>/g)).toHaveLength(1);
    expect(normalize(source)).toMatchObject({
      content: [{ type: 'text', text: '| ` | ` | `' + example + '` |\n| --- | --- | --- |' }],
      replyTarget: wanted,
    });
  });

  it('preserves the source of a closed quoted fence and filters a later directive', () => {
    const quote = '> ~~~text\r\n>   ' + example + '\t  \r\n> ~~~\r\n\r\n';
    const source = quote + '[[reply_to:wanted]]\r\n正文';
    expect(toSanitizedMarkdownHtml(source)).toContain('  ' + example + '\t  ');
    expect(normalize(source)).toMatchObject({
      content: [{ type: 'text', text: quote + '正文' }],
      replyTarget: wanted,
    });
  });

  it('preserves an unclosed quoted fence including trailing whitespace', () => {
    const quote = '> ~~~text\n>   ' + example + '\t  \n';
    expect(toSanitizedMarkdownHtml(quote)).toContain(example + '</code>');
    const message = normalize(quote);
    expect(message.content).toEqual([{ type: 'text', text: quote }]);
    expect(message.replyTarget).toBeUndefined();
  });
});
