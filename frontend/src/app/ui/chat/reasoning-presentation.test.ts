import { render } from 'lit';
import { describe, expect, it } from 'vitest';
import { stripThinkingTags } from '../format.ts';
import { stripReasoningTagsFromText } from '../../src/shared/text/reasoning-tags.ts';
import { extractText } from './message-extract.ts';
import { renderMessageGroup, renderStreamingGroup } from './grouped-render.ts';

describe('#635 nested reasoning', () => {
  it.each(['think', 'thinking', 'thought', 'antml:thinking', 'antthinking'])('hides all nested %s content', tag => {
    const text = `前文<${tag}>外层<think>内层</think>不能泄露</${tag}>正文`;
    expect(stripThinkingTags(text)).toBe('前文正文');
    expect(extractText({ role: 'assistant', content: text })).toBe('前文正文');
  });
  it.each(['`<think>示例</think>`', '```xml\n<think>示例</think>\n```', '~~~xml\n<think>示例</think>\n~~~'])('preserves code literals: %s', code => {
    expect(stripThinkingTags(code)).toBe(code);
    expect(stripThinkingTags(`<think>隐藏\n${code}\n仍隐藏</think>正文`)).toBe('正文');
  });
  it('retains existing preserve/strict handling for unclosed starts and stray closes', () => {
    expect(stripThinkingTags('前文<think>未闭合正文')).toBe('前文未闭合正文');
    expect(stripReasoningTagsFromText('前文<think>未闭合正文')).toBe('前文');
    expect(stripThinkingTags('前文</think>正文')).toBe('前文正文');
  });
  it('filters the actual message group body and preserves user literals', () => {
    for (const role of ['assistant', 'user']) {
      const host = document.createElement('div');
      const text = '<think>outer<think>inner</think>hidden</think>正文';
      render(renderMessageGroup({ kind: 'group', key: role, role, timestamp: Date.now(), isStreaming: false,
        messages: [{ key: 'm', message: { role, content: text } }] }, { showReasoning: false }), host);
      expect(host.querySelector('.chat-text')?.textContent?.trim()).toBe(role === 'assistant' ? '正文' : text);
    }
  });
});

describe('#710 literal reasoning presentation', () => {
  const thinking = 'field_name __raw__ *stars* `ticks`\n\n  保留缩进\n```sql\nselect a_b;\n```\n<img src=x onerror=alert(1)>';
  it.each([false, true])('keeps reasoning literal (streaming=%s) and answer Markdown active', async streaming => {
    const host = document.createElement('div');
    const answer = '**正常粗体** `code`';
    render(streaming
      ? renderStreamingGroup(answer, Date.now(), undefined, { name: 'Assistant', avatar: null }, undefined, thinking, false)
      : renderMessageGroup({ kind: 'group', key: 'a', role: 'assistant', timestamp: Date.now(), isStreaming: false,
        messages: [{ key: 'm', message: { role: 'assistant', content: [{ type: 'thinking', thinking }, { type: 'text', text: answer }] } }] }, { showReasoning: true }), host);
    await Promise.resolve();
    expect(host.querySelector('.chat-thinking-disclosure__body')?.textContent?.trim()).toBe(thinking);
    expect(host.querySelector('.chat-thinking-disclosure__body')?.children).toHaveLength(0);
    expect(host.querySelector('.chat-text strong')?.textContent).toBe('正常粗体');
    expect(host.querySelector('.chat-text code')?.textContent).toBe('code');
  });
});
