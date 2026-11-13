import { afterEach, expect, it, vi } from 'vitest';
import { ReportsPage } from './reports.js';

vi.mock('../../../api/index.js', () => ({ authFetch: vi.fn() }));
afterEach(() => vi.restoreAllMocks());

// #674: the same formatter serves next_run and report history.
const now = Date.parse('2026-11-13T04:00:00Z');
const hour = 3_600_000;
function format(value: string) {
  vi.spyOn(Date, 'now').mockReturnValue(now);
  return (new ReportsPage() as unknown as { _formatTime(value: string): string })._formatTime(value);
}

it.each([1, 3 * hour, 24 * hour, 30 * 24 * hour])('shows an absolute future date at +%i ms', offset => {
  const date = new Date(now + offset);
  const result = format(date.toISOString());
  expect(result).toBe(date.toLocaleString('zh-CN', { hour12: false }));
  expect(result).not.toMatch(/小时前|天前|NaN/);
});

it.each(['invalid', '', ' ', '2026-99-99', 'NaN'])('uses a placeholder for invalid date %j', value => {
  expect(format(value)).toBe('—');
});

it.each([
  [0, '0 小时前'],
  [1, '0 小时前'],
  [3 * hour, '3 小时前'],
  [24 * hour - 1, '23 小时前'],
  [24 * hour, '1 天前'],
  [72 * hour, '3 天前'],
])('preserves history display at -%i ms', (offset, expected) => {
  expect(format(new Date(now - offset).toISOString())).toBe(expected);
});

it('recognizes a future timestamp carrying an explicit timezone offset', () => {
  expect(format('2026-11-13T15:00:00+08:00')).toBe(
    new Date('2026-11-13T07:00:00Z').toLocaleString('zh-CN', { hour12: false }),
  );
});
