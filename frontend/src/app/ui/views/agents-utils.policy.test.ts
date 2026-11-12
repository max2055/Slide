import { describe, expect, it } from 'vitest';
import { expandToolGroups, normalizeToolName } from '../../src/agents/tool-policy-shared.ts';
import { isAllowedByPolicy, matchesList } from './agents-utils.ts';

describe('MAX-463 / #406 tool policy names', () => {
  it.each(['constructor', '__proto__', 'toString', 'hasOwnProperty', 'CONSTRUCTOR', 'unknown'])('keeps %s an exact string restriction', name => {
    expect(normalizeToolName(name)).toBe(name.toLowerCase());
    expect(expandToolGroups([name])).toEqual([name.toLowerCase()]);
    expect(isAllowedByPolicy('fixture-unlisted', { allow: [name] })).toBe(false);
    expect(isAllowedByPolicy(name, { allow: [name] })).toBe(true);
    expect(isAllowedByPolicy(name, { deny: [name] })).toBe(false);
    expect(matchesList(name, [name])).toBe(true);
  });

  it('does not turn invalid nonempty allow lists into unrestricted access', () => {
    for (const allow of [[' '], [''], [null], [{}], [' ', null]]) {
      expect(isAllowedByPolicy('exec', { allow: allow as string[] })).toBe(false);
    }
    expect(isAllowedByPolicy('exec', { allow: [] })).toBe(true);
    expect(isAllowedByPolicy('exec', {})).toBe(true);
  });

  it('preserves aliases, groups, deny precedence and exec/apply_patch compatibility', () => {
    expect(normalizeToolName(' BASH ')).toBe('exec');
    expect(normalizeToolName('Apply-Patch')).toBe('apply_patch');
    expect(expandToolGroups(['GROUP:RUNTIME', 'bash'])).toEqual(['exec', 'process', 'code_execution']);
    expect(isAllowedByPolicy('apply-patch', { allow: ['BASH'] })).toBe(true);
    expect(isAllowedByPolicy('exec', { allow: ['GROUP:RUNTIME'], deny: ['bash'] })).toBe(false);
    expect(isAllowedByPolicy('read', { allow: ['group:fs'] })).toBe(true);
    expect(isAllowedByPolicy('exec', { allow: ['group:fs'] })).toBe(false);
  });
});
