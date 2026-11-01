import { describe, it, expect } from 'vitest';
import { parseEntryContext } from './entry-contracts.js';
const context = () => ({ schemaVersion: 1, resourceRefs: [{ type: 'instance', id: 1, role: 'primary' }],
  from: '2026-10-30T00:00:00.000Z', to: '2026-10-30T01:00:00.000Z',
  metric: { id: 'db.uptime_seconds', semantic_version: '1.0.0' }, dimensions: {}, sourceEventIds: [10], returnTo: '/instances-db?id=1' });
describe('strict Investigation entry context', () => {
  it('retains exact window, semantic identity, event and return location with a detached snapshot', () => {
    const c = context(), result = parseEntryContext(c);
    expect(parseEntryContext({ ...c, returnTo: '/slide/instance-detail?id=1' }).returnTo).toBe('/slide/instance-detail?id=1');
    expect(result).toEqual(c); c.resourceRefs[0].id = 4; expect(result.resourceRefs[0].id).toBe(1);
  });
  it.each([
    { resourceRefs: [] }, { resourceRefs: [{ type: 'instance', id: 0, role: 'primary' }] },
    { resourceRefs: [{ type: 'instance', id: 1, role: 'related' }] },
    { from: '2026-02-30T00:00:00.000Z' }, { from: '2026-10-30' },
    { from: '2026-10-30T01:00:00.000Z' }, { from: '2026-09-01T00:00:00.000Z' },
    { to: '2099-01-01T00:00:00.000Z' }, { actor: { id: 1 } }, { sourceEventIds: [1, 1] },
    { metric: { id: 'unknown', semantic_version: '' } }, { metric: undefined, dimensions: { fs: '/' } },
    { returnTo: '//evil.invalid' }, { returnTo: '/servers\\evil' }, { returnTo: '/servers/%2f%2fevil' },
    { returnTo: '/servers\n' }, { returnTo: 'https://evil.invalid' },
  ])('rejects invalid or widening input %j', patch => expect(() => parseEntryContext({ ...context(), ...patch })).toThrow('INVESTIGATION_INPUT_INVALID'));
});
