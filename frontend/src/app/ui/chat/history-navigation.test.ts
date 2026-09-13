import { describe, expect, it } from 'vitest';
import { buildHistoryTurns, historyWindow } from './history-navigation.ts';

const keyFor = (message: any, index: number) => message.id ?? String(index);

describe('history turn navigation', () => {
  it('keeps consecutive user requests separate and excludes tool results and private reasoning', () => {
    const messages = [
      { role: 'system', content: 'policy' },
      { role: 'user', id: 'a', content: 'First question' },
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'private' }, { type: 'text', text: 'Visible answer' }] },
      { role: 'toolResult', content: 'secret tool output' },
      { role: 'user', id: 'b', content: 'Second question' },
      { role: 'user', id: 'c', content: [{ type: 'image', source: {} }] },
      { role: 'assistant', content: 'NO_REPLY' },
    ];
    const turns = buildHistoryTurns(messages, keyFor);
    expect(turns).toEqual([
      { key: 'a', index: 1, question: 'First question', answer: 'Visible answer' },
      { key: 'b', index: 4, question: 'Second question', answer: '' },
      { key: 'c', index: 5, question: '附件消息', answer: '' },
    ]);
    expect(buildHistoryTurns(messages, keyFor)).toBe(turns);
    messages.push({ role: 'user', id: 'd', content: 'New turn' });
    expect(buildHistoryTurns(messages, keyFor)).toHaveLength(4);
  });

  it('indexes all turns but renders complete bounded segments around old targets', () => {
    const messages = Array.from({ length: 1200 }, (_, index) => ({
      id: String(index), role: index % 2 ? 'assistant' : 'user', content: `Message ${index}`,
    }));
    const turns = buildHistoryTurns(messages, keyFor);
    expect(turns).toHaveLength(600);
    expect(historyWindow(turns, messages.length, null)).toMatchObject({ start: 1000, end: 1200 });
    expect(historyWindow(turns, messages.length, '10')).toMatchObject({ start: 10, end: 210, next: { key: '210' } });
    expect(historyWindow(turns, messages.length, '0')).toMatchObject({ start: 0, end: 200, previous: undefined });
    messages.push({ id: '1200', role: 'user', content: 'new unanswered question' });
    expect(historyWindow(buildHistoryTurns(messages, keyFor), 1201, null)).toMatchObject({ start: 1000, end: 1201 });
  });
});
