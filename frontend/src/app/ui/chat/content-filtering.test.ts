import { describe, expect, it } from 'vitest';
import { stripEnvelope } from '../../src/shared/chat-envelope.ts';
import { stripModelSpecialTokens } from '../../src/shared/text/model-special-tokens.ts';
import { sanitizeAssistantVisibleTextWithProfile } from '../../src/shared/text/assistant-visible-text.ts';
import { parseFenceSpans } from '../../src/markdown/fences.ts';
import { splitMediaFromOutput } from '../../src/media/parse.ts';
import { extractText } from './message-extract.ts';
import { normalizeMessage } from './message-normalizer.ts';
import { migrateMessageParts } from '../../../../../packages/agent-core/src/message-parts.ts';

// MAX-624: #408/#409/#632/#633 share the actual chat display entry points.
describe('#408 envelope recognition', () => {
  it.each([
    '[会议 2024-01-01 12:00 提醒] 保留正文',
    '[日志 2024-01-01T12:00Z] 保留正文',
    '[引用 2024-01-01 12:00] 保留正文',
    '[2024-01-01 12:00 提醒] 保留正文',
    '普通无头部文本',
    '前文 [2024-01-01 12:00] 正文',
  ])('preserves ordinary text: %s', text => {
    expect(stripEnvelope(text)).toBe(text);
    expect(extractText({ role: 'user', content: text })).toBe(text);
  });
  it.each(['2024-01-01T12:00Z', '2024-01-01 12:00', '2024-01-01 12:00 GMT+8', 'WebChat user', 'Telegram user id:42'])('strips supported header %s', header => {
    expect(stripEnvelope(`[${header}] 正文`)).toBe('正文');
  });
  it('strips consecutive supported headers and stops at ordinary brackets', () => {
    expect(stripEnvelope('[2024-01-01T12:00Z] [WebChat user] [会议 2024-01-01 12:00] 正文'))
      .toBe('[会议 2024-01-01 12:00] 正文');
  });
});

describe('#409 bounded model tokens', () => {
  it.each(['<|assistant|>', '<｜begin▁of▁sentence｜>', '<|tool_call_result_begin|>', '<｜end▁of▁sentence｜>'])('removes known %s with separation', token => {
    expect(stripModelSpecialTokens(`前${token}后`)).toBe('前 后');
    expect(extractText({ role: 'assistant', content: `前${token}后` })).toBe('前 后');
    expect(stripModelSpecialTokens(`${token}正文${token}`)).toBe('正文');
  });
  it.each([
    '前文 <|这是未闭合示例\n第一行重要正文\n第二行重要正文 |> 后文',
    '<|unknown_control|>', '<｜未知｜>', '<|assistant｜>', '<|assistant', '|> 正文 <|',
    '<|assistant\n|>', '<|assistant\r|>', '<|' + 'x'.repeat(1000) + '|>',
    '`<|assistant|>`', '``<｜begin▁of▁sentence｜>``',
    '```text\n<|assistant|>\n```', '~~~text\n<｜begin▁of▁sentence｜>\n~~~',
  ])('preserves unknown, unclosed and code text: %s', text => {
    expect(stripModelSpecialTokens(text)).toBe(text);
  });
  it.each(['````', '  ```', '~~~'])('protects tokens after code info strings inside %s', marker => {
    const text = `${marker}text\n${marker}js\n<|assistant|>\n${marker}`;
    expect(stripModelSpecialTokens(text)).toBe(text);
  });
  it('does not concatenate words across adjacent known tokens', () => {
    expect(stripModelSpecialTokens('left<|assistant|><|im_end|>right')).toMatch(/^left +right$/);
    expect(stripModelSpecialTokens('left <|assistant|> right')).toBe('left  right');
  });
});

describe('#632 fenced MEDIA', () => {
  it.each(['```', '~~~'])('keeps an information string inside %s', marker => {
    const text = `${marker}text\n${marker}js\nMEDIA: https://example.com/inside.png\n${marker} \t\nMEDIA: https://example.com/outside.png`;
    const spans = parseFenceSpans(text);
    expect(spans).toHaveLength(1);
    expect(spans[0].end).toBe(text.indexOf('\nMEDIA: https://example.com/outside.png'));
    const parsed = splitMediaFromOutput(text);
    expect(parsed.mediaUrls).toEqual(['https://example.com/outside.png']);
    expect(parsed.text).toContain('MEDIA: https://example.com/inside.png');
    const normalized = normalizeMessage({ role: 'assistant', content: text });
    const attachments = normalized.content.filter(p => p.type === 'attachment');
    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toMatchObject({ attachment: { url: 'https://example.com/outside.png' } });
  });
  it.each(['\n', '\r\n'])('protects longer, unclosed fences with %j lines', newline => {
    const text = ['````text', '```', '````js', 'MEDIA: https://example.com/literal.png'].join(newline);
    expect(splitMediaFromOutput(text).mediaUrls).toBeUndefined();
    expect(splitMediaFromOutput(text).text).toBe(text);
  });
});

describe('#633 memory tag pairing', () => {
  it.each(['```', '~~~', '`'])('ignores code-contained closing tag in %s', marker => {
    const code = marker === '`' ? '`</relevant_memories>`' : `${marker}text\n</relevant_memories>\n${marker}`;
    const text = `hello <relevant_memories>\n${code}\nworld`;
    const expected = `hello \n${code}\nworld`;
    expect(extractText({ role: 'assistant', content: text })).toBe(expected);
  });
  it('removes paired outside tags and hidden content', () => {
    expect(extractText({ role: 'assistant', content: 'hello <relevant_memories>private</relevant_memories> world' })).toBe('hello  world');
  });
  it('code tags do not close an outside pair', () => {
    const text = 'hello <relevant_memories>private\n```text\n</relevant_memories>\n```\nprivate too</relevant_memories> world';
    expect(extractText({ role: 'assistant', content: text })).toBe('hello  world');
  });
  it('handles multiple outside pairs without letting code-only openers pair with outside closers', () => {
    const text = 'a<relevant_memories>x</relevant_memories>b<relevant-memories>y</relevant-memories>c';
    expect(extractText({ role: 'assistant', content: text })).toBe('abc');
    const code = '```xml\n<relevant_memories>\n```';
    expect(extractText({ role: 'assistant', content: `${code}\nvisible</relevant_memories>after` }))
      .toBe(`${code}\nvisibleafter`);
  });
  it('keeps unmatched body and code literals, while removing scaffolding tags', () => {
    expect(extractText({ role: 'assistant', content: 'hello <relevant_memories>partial reply' })).toBe('hello partial reply');
    const text = 'hello\n```xml\n<relevant_memories>literal</relevant_memories>\n```\nworld';
    expect(extractText({ role: 'assistant', content: text })).toBe(text);
  });
  it.each(['delivery', 'history', 'internal-scaffolding'] as const)('preserves code and later body in %s profile', profile => {
    const text = 'hello <relevant-memories>\n```xml\n</relevant-memories>\n```\nworld';
    expect(sanitizeAssistantVisibleTextWithProfile(text, profile)).toContain('world');
  });
});

it.each(['user', 'assistant'] as const)('display filtering leaves %s legacy and canonical records unchanged', role => {
  const content = role === 'user' ? '[会议 2024-01-01 12:00] 正文' : '前<|assistant|>后\n```\nMEDIA: https://example.com/code.png\n```';
  for (const message of [{ id: role, role, content }, migrateMessageParts({ id: role, role, content })]) {
    const before = structuredClone(message);
    extractText(message);
    normalizeMessage(message);
    expect(message).toEqual(before);
  }
});
