import { afterEach, describe, expect, it } from 'vitest';
import { filterRuntimeSkills, setSkillEnabled } from './runtime-policy.js';
import type { SkillEntry } from './types.js';

function entry(name: string, trusted: boolean): SkillEntry {
  return {
    skill: { name, description: name, filePath: `/skills/${name}/SKILL.md`, source: 'body' },
    frontmatter: { name },
    security: { source: trusted ? 'bundled' : 'temporary', digest: 'a'.repeat(64), trusted, root: '/skills' },
  };
}

afterEach(() => {
  delete process.env.AGENT_SKILL_ALLOWLISTS;
  setSkillEnabled('one', true);
  setSkillEnabled('two', true);
});

describe('per-agent Skill policy', () => {
  it('intersects trust, per-agent allowlist, and runtime enabled state', () => {
    process.env.AGENT_SKILL_ALLOWLISTS = JSON.stringify({ 'slide-db-ops': ['one', 'untrusted'] });
    const entries = [entry('one', true), entry('two', true), entry('untrusted', false)];

    expect(filterRuntimeSkills('slide-db-ops', entries).map((item) => item.skill.name)).toEqual(['one']);
    setSkillEnabled('one', false);
    expect(filterRuntimeSkills('slide-db-ops', entries)).toEqual([]);
  });

  it('fails closed when the configured allowlist JSON is malformed', () => {
    process.env.AGENT_SKILL_ALLOWLISTS = '{not-json';
    expect(filterRuntimeSkills('slide-db-ops', [entry('one', true)])).toEqual([]);
  });
});
