import { describe, expect, it } from 'vitest';
import { stripReasoningTagsFromText } from './reasoning-tags.js';
import { stripThinkingTags } from '../../../ui/format.ts';
import { extractText } from '../../../ui/chat/message-extract.ts';

describe('#704 assistant final wrappers', () => {
  it.each(['final', 'antml:final', 'ANTML:FINAL'])('strips %s through the assistant display entry', tag => {
    const text = `<${tag}>可见答案</${tag}>`;
    expect(stripReasoningTagsFromText(text)).toBe('可见答案');
    expect(stripThinkingTags(text)).toBe('可见答案');
    expect(extractText({ role: 'assistant', content: text })).toBe('可见答案');
    expect(extractText({ role: 'assistant', content: [{ type: 'text', text }] })).toBe('可见答案');
  });

  it('removes prefixed reasoning and final wrappers together', () => {
    expect(extractText({ role: 'assistant', content: '<antml:think>私密推理</antml:think><antml:final>答案</antml:final>' })).toBe('答案');
  });

  it.each(['final', 'antml:final', 'antml:think'])('preserves %s inside fenced and inline code', tag => {
    const code = `\`<${tag}>示例</${tag}>\`\n\n\`\`\`xml\n<${tag}>示例</${tag}>\n\`\`\``;
    const text = `<antml:final>\n${code}\n</antml:final>`;
    expect(stripReasoningTagsFromText(text)).toBe(code);
    // The display entry preserves the newline after a fenced code block.
    expect(extractText({ role: 'assistant', content: text })?.trimEnd()).toBe(code);
    expect(extractText({ role: 'assistant', content: text })).toBe(
      extractText({ role: 'assistant', content: `<final>\n${code}\n</final>` }),
    );
  });

  it('keeps attributes, whitespace and trim options consistent with bare final', () => {
    for (const tag of ['final', 'antml:final']) {
      expect(stripReasoningTagsFromText(` < ${tag} kind="answer">答案< / ${tag}> `, { trim: 'none' })).toBe(' 答案 ');
    }
  });
});
