import { describe, expect, it } from 'vitest';
import samples from './fixtures/text-repetition.json' with { type: 'json' };
import { detectTextRepetition, MAX_ANALYZED_CHARS } from '../runtime/text-repetition.js';
import { AnomalyGuard } from '../runtime/anomaly-guard.js';

describe('frozen labeled repetition corpus', () => {
  it.each(samples)('$id', sample => {
    expect(detectTextRepetition(sample.text, sample.request).repeated).toBe(sample.reject);
  });
  it('has at least 200 normal examples and meets A2 by category', () => {
    expect(samples.filter(s => !s.reject).length).toBeGreaterThanOrEqual(200);
    const table = [...new Set(samples.map(s => s.category))].map(category => {
      const rows = samples.filter(s => s.category === category);
      return { category, count: rows.length,
        falseReject: rows.filter(s => !s.reject && detectTextRepetition(s.text, s.request).repeated).length,
        missed: rows.filter(s => s.reject && !detectTextRepetition(s.text, s.request).repeated).length };
    });
    console.table(table);
    expect(table.reduce((n, r) => n + r.falseReject, 0) / samples.filter(s => !s.reject).length).toBeLessThanOrEqual(0.01);
    expect(table.reduce((n, r) => n + r.missed, 0)).toBe(0);
  });
});
it('bounds long output analysis and handles blank, short Chinese and fenced code', () => {
  expect(detectTextRepetition('正常文本'.repeat(100_000)).analyzedChars).toBeLessThanOrEqual(MAX_ANALYZED_CHARS);
  for (const text of ['  \n\t', '好好好', '```sql\n' + 'SELECT 1;\n'.repeat(30) + '```']) {
    expect(detectTextRepetition(text).repeated).toBe(false);
  }
});
it('does not reject equal current-run answers when evidence advanced', () => {
  const guard = new AnomalyGuard();
  const text = samples.find(s => s.category === 'prose')!.text;
  expect(guard.inspect(text, '', 0).repeated).toBe(false);
  expect(guard.inspect(text, '', 1).repeated).toBe(false);
  expect(guard.inspect(text, '', 1).stalled).toBe(true);
});
it('repeated and alternating identical tool results do not advance progress', () => {
  const guard = new AnomalyGuard();
  expect(guard.progress([{ cpu: 1 }])).toBe(1);
  expect(guard.progress([{ disk: 2 }])).toBe(2);
  expect(guard.progress([{ cpu: 1 }])).toBe(2);
  expect(guard.progress([{ disk: 2 }])).toBe(2);
  expect(guard.progress([{ cpu: 3 }])).toBe(3);
});

it('does not exempt prose just because a code block precedes it', () => {
  expect(detectTextRepetition('```sql\nSELECT 1;\n```\n' + '正在分析数据库状态……\n'.repeat(20)).repeated).toBe(true);
});
it('numeric evidence changes do not become fuzzy repetition', () => {
  const guard = new AnomalyGuard();
  const text = samples.find(s => s.category === 'prose')!.text;
  guard.inspect(text, '', 0);
  expect(guard.inspect(text.replace('17', '18'), '', 0).stalled).toBe(false);
});

it('detects three long adjacent blocks and long degenerate text without rejecting short Chinese', () => {
  expect(detectTextRepetition('abcdefghijklmnopqrstuvwxyz0123456789ABCD'.repeat(3)).repeated).toBe(true);
  expect(detectTextRepetition('好'.repeat(120)).repeated).toBe(true);
  expect(detectTextRepetition('好好好')).toMatchObject({ repeated: false });
});
