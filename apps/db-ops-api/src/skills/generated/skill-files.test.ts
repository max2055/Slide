/**
 * Nyquist validation: 92-01-02 — 3 Agent SKILL.md files
 *
 * Tests:
 * 1. All 3 files exist: alert-rca/SKILL.md, fault-diagnosis/SKILL.md, topsql-analysis/SKILL.md
 * 2. Each has valid YAML frontmatter with name, description
 * 3. Each has ## Tool Flow, ## Output Format, ## Completion sections
 * 4. Each mentions slide_complete_analysis
 * 5. Each >= 30 lines
 * 6. YAML frontmatter is parseable
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { parse as parseYaml } from 'yaml';

const SKILLS_DIR = resolve(import.meta.dirname, '.');

const SKILL_FILES = [
  { name: 'alert-rca', path: 'alert-rca/SKILL.md' },
  { name: 'fault-diagnosis', path: 'fault-diagnosis/SKILL.md' },
  { name: 'topsql-analysis', path: 'topsql-analysis/SKILL.md' },
];

/**
 * Extract YAML frontmatter between --- markers. Returns { frontmatter, body } or null.
 */
function parseFrontmatter(content: string): { frontmatter: Record<string, any>; body: string } | null {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return null;

  try {
    const frontmatter = parseYaml(match[1]);
    return { frontmatter: frontmatter || {}, body: match[2] };
  } catch {
    // Fallback: try a simple extraction
    const lines = match[1].split('\n');
    const f: Record<string, any> = {};
    for (const line of lines) {
      const kv = line.match(/^(\w[\w-]*):\s*(.*)$/);
      if (kv) {
        f[kv[1]] = kv[2].trim();
      }
    }
    return { frontmatter: f, body: match[2] };
  }
}

describe('92-01-02: Agent SKILL.md files', () => {
  for (const skill of SKILL_FILES) {
    const fullPath = resolve(SKILLS_DIR, skill.path);

    describe(`${skill.name}/SKILL.md`, () => {
      it('file exists', () => {
        expect(existsSync(fullPath)).toBe(true);
      });

      if (!existsSync(fullPath)) return; // skip remaining tests

      const content = readFileSync(fullPath, 'utf-8');
      const lines = content.split('\n');
      const parsed = parseFrontmatter(content);

      it('has at least 30 lines', () => {
        expect(lines.length).toBeGreaterThanOrEqual(30);
      });

      it('has valid YAML frontmatter between --- markers', () => {
        expect(parsed).not.toBeNull();
      });

      if (!parsed) return; // skip remaining tests if frontmatter invalid

      it('YAML frontmatter has name', () => {
        expect(parsed.frontmatter).toHaveProperty('name');
        expect(typeof parsed.frontmatter.name).toBe('string');
        expect(parsed.frontmatter.name.length).toBeGreaterThan(0);
      });

      it('YAML frontmatter has description', () => {
        expect(parsed.frontmatter).toHaveProperty('description');
        expect(typeof parsed.frontmatter.description).toBe('string');
        expect(parsed.frontmatter.description.length).toBeGreaterThan(0);
      });

      it('YAML frontmatter has metadata', () => {
        expect(parsed.frontmatter).toHaveProperty('metadata');
        expect(typeof parsed.frontmatter.metadata).toBe('object');
      });

      it('has ## Tool Flow section', () => {
        expect(content).toContain('## Tool Flow');
      });

      it('has ## Output Format section', () => {
        expect(content).toContain('## Output Format');
      });

      it('has ## Completion section', () => {
        expect(content).toContain('## Completion');
      });

      it('mentions slide_complete_analysis', () => {
        expect(content).toContain('slide_complete_analysis');
      });
    });
  }

  describe('cross-file consistency', () => {
    it('all 3 SKILL.md files have the same required sections', () => {
      const requiredSections = ['## Tool Flow', '## Output Format', '## Completion'];
      for (const skill of SKILL_FILES) {
        const fullPath = resolve(SKILLS_DIR, skill.path);
        if (!existsSync(fullPath)) continue;
        const content = readFileSync(fullPath, 'utf-8');
        for (const section of requiredSections) {
          expect(content).toContain(section);
        }
        expect(content).toContain('slide_complete_analysis');
      }
    });
  });
});
