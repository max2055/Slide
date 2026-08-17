import { SkillsLoader, type Skill as CoreSkill } from '@slide/agent-core';
import type { SkillEntry } from './types.js';

/** Bridges verified Slide SkillEntry objects into agent-core prompt assembly. */
export class TrustedSkillsLoader extends SkillsLoader {
  constructor(private readonly entriesProvider: () => readonly SkillEntry[]) {
    super('/nonexistent-slide-trusted-skill-root');
  }

  override listSkills(): CoreSkill[] {
    return this.entriesProvider().map((entry) => ({
      name: entry.skill.name,
      description: entry.skill.description,
      always: entry.metadata?.always === true,
      content: entry.skill.source ?? '',
      path: entry.skill.filePath,
      requires: entry.metadata?.requires as Record<string, string[]> | undefined,
      metadata: {
        ...(entry.frontmatter as Record<string, unknown>),
        security: entry.security,
      },
    }));
  }

  override invalidateCache(): void {
    // entriesProvider is live; there is no independent filesystem cache.
  }
}
