import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { en } from './en.ts';
import { zh_CN } from './zh-CN.ts';

function flatten(value: unknown, prefix = ''): Map<string, string> {
  const result = new Map<string, string>();
  if (!value || typeof value !== 'object') return result;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof child === 'string') result.set(path, child);
    else for (const [nestedKey, text] of flatten(child, path)) result.set(nestedKey, text);
  }
  return result;
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = resolve(directory, entry);
    if (entry === 'node_modules' || entry.endsWith('.test.ts')) return [];
    return statSync(path).isDirectory() ? sourceFiles(path) : entry.endsWith('.ts') ? [path] : [];
  });
}

function placeholders(text: string): string[] {
  return [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
}

describe('i18n locale contract', () => {
  const english = flatten(en);
  const chinese = flatten(zh_CN);

  it('keeps English and Chinese leaf keys in exact parity', () => {
    expect([...chinese.keys()].sort()).toEqual([...english.keys()].sort());
  });

  it('keeps interpolation placeholders compatible across locales', () => {
    for (const [key, englishText] of english) {
      expect(placeholders(chinese.get(key) ?? ''), key).toEqual(placeholders(englishText));
    }
  });

  it('defines every statically referenced translation key', () => {
    const appRoot = resolve(process.cwd(), 'src/app');
    const missing = sourceFiles(appRoot).flatMap((file) => {
      const source = readFileSync(file, 'utf8');
      return [...source.matchAll(/\bt\(\s*["']([^"']+)["']/g)]
        .map((match) => match[1])
        .filter((key) => !english.has(key));
    });
    expect([...new Set(missing)].sort()).toEqual([]);
  });
});
