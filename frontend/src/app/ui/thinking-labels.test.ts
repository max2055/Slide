/**
 * Nyquist validation: Phase 98 — thinking-labels.ts
 *
 * Tests thinking level label formatters:
 * - normalizeThinkingOptionValue normalizes thinking level values
 * - formatInheritedThinkingLabel formats inherited labels
 * - formatThinkingOverrideLabel formats override labels
 * - All handle null/undefined/empty/off edges
 */
import { describe, it, expect } from 'vitest';
import {
  normalizeThinkingOptionValue,
  formatInheritedThinkingLabel,
  formatThinkingOverrideLabel,
} from './thinking-labels.ts';

describe('98-T1-REQ-B: normalizeThinkingOptionValue', () => {
  it('returns normalized value for known thinking level', () => {
    const result = normalizeThinkingOptionValue('low');
    expect(result).toBeTypeOf('string');
    expect(result.length).toBeGreaterThan(0);
  });

  it('returns normalized empty for unknown value', () => {
    const result = normalizeThinkingOptionValue('some-random-value');
    expect(result).toBeTypeOf('string');
  });

  it('returns empty string for null', () => {
    const result = normalizeThinkingOptionValue(null as unknown as string);
    expect(result).toBeTypeOf('string');
  });

  it('returns empty string for undefined', () => {
    const result = normalizeThinkingOptionValue(undefined as unknown as string);
    expect(result).toBeTypeOf('string');
  });
});

describe('98-T1-REQ-B: formatInheritedThinkingLabel', () => {
  it('returns "Off" for null/undefined/empty input', () => {
    expect(formatInheritedThinkingLabel(null)).toBe('Off');
    expect(formatInheritedThinkingLabel(undefined)).toBe('Off');
    expect(formatInheritedThinkingLabel('')).toBe('Off');
  });

  it('returns "Off" when normalized value is "off"', () => {
    expect(formatInheritedThinkingLabel('off')).toBe('Off');
    expect(formatInheritedThinkingLabel('OFF')).toBe('Off');
    expect(formatInheritedThinkingLabel('  off  ')).toBe('Off');
  });

  it('returns "Inherited: {value}" for valid non-off level', () => {
    const result = formatInheritedThinkingLabel('low');
    expect(result).toBe('Inherited: low');
  });

  it('normalizes the value before formatting', () => {
    const result = formatInheritedThinkingLabel('  Low  ');
    expect(result).toBe('Inherited: low');
  });
});

describe('98-T1-REQ-B: formatThinkingOverrideLabel', () => {
  it('returns "Off" for empty/off value regardless of label', () => {
    expect(formatThinkingOverrideLabel('')).toBe('Off');
    expect(formatThinkingOverrideLabel('off')).toBe('Off');
    expect(formatThinkingOverrideLabel('OFF')).toBe('Off');
  });

  it('returns "Override: {label}" when label is provided and non-empty', () => {
    const result = formatThinkingOverrideLabel('medium', 'Medium thinks');
    expect(result).toBe('Override: Medium thinks');
  });

  it('returns "Override: {value}" when label is null/undefined/empty', () => {
    expect(formatThinkingOverrideLabel('high', null)).toBe('Override: high');
    expect(formatThinkingOverrideLabel('high', undefined)).toBe('Override: high');
    expect(formatThinkingOverrideLabel('high', '')).toBe('Override: high');
  });

  it('trims the label before using it', () => {
    const result = formatThinkingOverrideLabel('low', '  Low Thinks  ');
    expect(result).toBe('Override: Low Thinks');
  });

  it('normalizes the value before comparing to off', () => {
    const result = formatThinkingOverrideLabel('  OFF  ');
    expect(result).toBe('Off');
  });
});
