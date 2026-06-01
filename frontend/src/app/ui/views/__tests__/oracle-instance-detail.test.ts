/**
 * Oracle Instance Detail -- source structure test (GAP-10 / CR-03)
 *
 * Verifies that instance-detail.ts uses null-safe checks for
 * tablespace_usage_percent: != null (not !== undefined) and ?? 0 guard.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const INSTANCE_DETAIL_PATH = path.resolve(__dirname, '../instance-detail.ts');
const source = fs.readFileSync(INSTANCE_DETAIL_PATH, 'utf-8');

describe('GAP-10 / CR-03: Null-safe tablespace_usage_percent rendering', () => {
  it('tablespace_usage_percent 检查应使用 != null（同时捕获 null 和 undefined）', () => {
    // != null catches both null and undefined
    const nullSafeMatch = source.match(/tablespace_usage_percent\s*!=\s*null/);
    expect(nullSafeMatch).not.toBeNull();
  });

  it('toFixed(1) 调用前应有 ?? 0 空值合并保护', () => {
    const nullishCoalesceMatch = source.match(/tablespace_usage_percent\s*\?\?\s*0/);
    expect(nullishCoalesceMatch).not.toBeNull();
  });

  it('不应使用 !== undefined（会漏掉 null 值）', () => {
    // Check that tablespace_usage_percent specifically does NOT use !== undefined
    const unsafeUndefined = source.match(/tablespace_usage_percent\s*!==\s*undefined/);
    expect(unsafeUndefined).toBeNull();
  });
});
