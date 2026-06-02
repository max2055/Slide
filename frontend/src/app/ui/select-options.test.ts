/**
 * Nyquist validation: Phase 98 — select-options.ts
 *
 * Tests pushUniqueTrimmedSelectOption behavior:
 * - Adds unique trimmed values to the array
 * - Skips empty/falsy values
 * - Skips duplicates (case-insensitive)
 * - Calls labelForValue callback for each new value
 */
import { describe, it, expect, vi } from 'vitest';
import { pushUniqueTrimmedSelectOption, type SelectOption } from './select-options.ts';

describe('98-T1-REQ-A: pushUniqueTrimmedSelectOption', () => {
  it('adds a trimmed value with label from callback and returns true', () => {
    const options: SelectOption[] = [];
    const seen = new Set<string>();
    pushUniqueTrimmedSelectOption(options, seen, '  hello  ', (v) => v.toUpperCase());
    expect(options).toEqual([{ value: 'hello', label: 'HELLO' }]);
    expect(seen.has('hello')).toBe(true);
  });

  it('skips empty string after trimming', () => {
    const options: SelectOption[] = [];
    const seen = new Set<string>();
    pushUniqueTrimmedSelectOption(options, seen, '  ', (v) => v);
    expect(options).toEqual([]);
    expect(seen.size).toBe(0);
  });

  it('skips empty string directly', () => {
    const options: SelectOption[] = [];
    const seen = new Set<string>();
    pushUniqueTrimmedSelectOption(options, seen, '', (v) => v);
    expect(options).toEqual([]);
    expect(seen.size).toBe(0);
  });

  it('skips duplicate values case-insensitively', () => {
    const options: SelectOption[] = [];
    const seen = new Set<string>();
    pushUniqueTrimmedSelectOption(options, seen, 'Hello', (v) => v);
    pushUniqueTrimmedSelectOption(options, seen, 'hello', (v) => v);
    expect(options).toHaveLength(1);
    expect(options[0]).toEqual({ value: 'Hello', label: 'Hello' });
  });

  it('handles multiple unique values', () => {
    const options: SelectOption[] = [];
    const seen = new Set<string>();
    pushUniqueTrimmedSelectOption(options, seen, 'alpha', (v) => `label-${v}`);
    pushUniqueTrimmedSelectOption(options, seen, 'beta', (v) => `label-${v}`);
    pushUniqueTrimmedSelectOption(options, seen, 'gamma', (v) => `label-${v}`);
    expect(options).toHaveLength(3);
    expect(options[0]).toEqual({ value: 'alpha', label: 'label-alpha' });
    expect(options[1]).toEqual({ value: 'beta', label: 'label-beta' });
    expect(options[2]).toEqual({ value: 'gamma', label: 'label-gamma' });
  });

  it('calls labelForValue with the trimmed value', () => {
    const options: SelectOption[] = [];
    const seen = new Set<string>();
    const labelForValue = vi.fn((v: string) => `processed:${v}`);
    pushUniqueTrimmedSelectOption(options, seen, '  test-value  ', labelForValue);
    expect(labelForValue).toHaveBeenCalledWith('test-value');
    expect(options[0].label).toBe('processed:test-value');
  });

  it('normalizes whitespace-heavy values before dedup', () => {
    const options: SelectOption[] = [];
    const seen = new Set<string>();
    pushUniqueTrimmedSelectOption(options, seen, '  Hello World  ', (v) => v);
    pushUniqueTrimmedSelectOption(options, seen, 'hello world', (v) => v);
    expect(options).toHaveLength(1);
  });
});
