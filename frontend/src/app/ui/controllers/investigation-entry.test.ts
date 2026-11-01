import { describe, it, expect } from 'vitest';
import { investigationEntryHref, readInvestigationEntry, type InvestigationEntryContext } from './investigation-entry.ts';
const c: InvestigationEntryContext = { schemaVersion: 1, resourceRefs: [{ type: 'server', id: 7, role: 'primary' }],
  from: '2026-10-30T00:00:00.000Z', to: '2026-10-30T01:00:00.000Z', metric: { id: 'host.filesystem.used_bytes', semantic_version: '1.0.0' },
  dimensions: { filesystem: '/', mountpoint: '数据' }, sourceEventIds: [5], returnTo: '/servers?id=7&tab=metrics' };
describe('public entry link producer example', () => {
  it('round trips resource/metric history/event context without rebasing time or losing dimensions', () => {
    const url = new URL(investigationEntryHref(c, '/slide'), 'https://example.invalid');
    expect(url.pathname).toBe('/slide/investigations'); expect(readInvestigationEntry(url.search)).toEqual(c);
  });
  it('does not treat malformed or duplicate contexts as a manual empty draft', () => {
    expect(readInvestigationEntry('?query=x')).toBeNull();
    expect(() => readInvestigationEntry('?entry={}')).toThrow('调查上下文无效');
    expect(() => readInvestigationEntry('?entry={}&entry={}')).toThrow('调查上下文无效');
    for (const base of ['//evil?', '//evil', '/slide//x', 'https://evil'])
      expect(() => investigationEntryHref(c, base)).toThrow('INVALID_BASE_PATH');
  });
});
