/**
 * SkillsLoader — ported from nanobot agent/skills.py
 *
 * Discovers, loads, and filters skills from workspace skills directories.
 * Supports SKILL.md frontmatter parsing, requirement checking, and context injection.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

// ── Constants ──

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;

// ── Types ──

export interface SkillMeta {
  name: string;
  description?: string;
  always?: boolean;
  requires?: Record<string, string[]>;
  [key: string]: unknown;
}

export interface Skill {
  name: string;
  description: string;
  always: boolean;
  content: string;
  path: string;
  requires?: Record<string, string[]>;
  metadata?: Record<string, unknown>;
}

// ── SkillsLoader ──

export class SkillsLoader {
  private workspace: string;
  private skillsDir: string;
  private _skillsCache: Skill[] | null = null;
  private disabledSkills: Set<string>;

  constructor(workspace: string, options?: { disabledSkills?: string[] }) {
    this.workspace = workspace;
    this.skillsDir = path.join(workspace, '.agents', 'skills');
    this.disabledSkills = new Set(options?.disabledSkills ?? []);
  }

  /** List all available skills (cached). Set filterUnavailable to exclude skills with unmet requirements. */
  listSkills(filterUnavailable?: boolean): Skill[] {
    if (this._skillsCache) {
      return filterUnavailable ? this._skillsCache.filter(s => !this._isUnavailable(s)) : this._skillsCache;
    }
    this._skillsCache = this._discoverSkills();
    return filterUnavailable ? this._skillsCache.filter(s => !this._isUnavailable(s)) : this._skillsCache;
  }

  /** Invalidate skill cache (force re-discovery on next call). */
  invalidateCache(): void {
    this._skillsCache = null;
  }

  /** Load a single skill's body content (frontmatter stripped). */
  loadSkill(skillName: string): string | undefined {
    const skills = this.listSkills();
    const skill = skills.find(s => s.name === skillName);
    return skill?.content;
  }

  /** Load content for named skills, formatted for system prompt context. */
  loadSkillsForContext(skillNames: string[]): string[] {
    const skills = this.listSkills();
    const contextParts: string[] = [];
    for (const skill of skills) {
      if (skill.always || skillNames.includes(skill.name)) {
        contextParts.push(`Skill: ${skill.name}`);
        contextParts.push(skill.content);
      }
    }
    return contextParts;
  }

  /** Build a skills summary string for system prompt injection. */
  buildSkillsSummary(): string {
    const skills = this.listSkills();
    if (skills.length === 0) return '';

    const lines: string[] = ['## Available Skills'];
    for (const skill of skills) {
      lines.push(`- ${skill.name}: ${skill.description || 'No description'}`);
    }
    return lines.join('\n');
  }

  /** Get names of skills marked as "always" active. */
  getAlwaysSkills(): string[] {
    return this.listSkills().filter(s => s.always).map(s => s.name);
  }

  /** Check if a skill's requirements are unavailable. */
  private _isUnavailable(skill: Skill): boolean {
    // Check requires field first (nested YAML), fall back to top-level metadata keys
    let reqs = skill.requires;
    if (!reqs || Object.keys(reqs).length === 0) {
      // Simple line-based parser flattens nested YAML; check metadata for bins/env
      const meta = skill.metadata || {};
      const topBins = meta.bins as string[] | undefined;
      const topEnv = meta.env as string[] | undefined;
      if (!topBins && !topEnv) return false;
      reqs = {};
      if (topBins) reqs.bins = topBins;
      if (topEnv) reqs.env = topEnv;
    }
    if (!reqs || Object.keys(reqs).length === 0) return false;
    return !this._checkRequirements(reqs);
  }

  /** Get metadata for a specific skill by name. */
  getSkillMetadata(name: string): SkillMeta | undefined {
    const raw = this._loadRawSkill(name);
    if (!raw) return undefined;
    return this._parseFrontmatterMeta(raw.fullContent);
  }

  // ── Private ──

  private _discoverSkills(): Skill[] {
    if (!fs.existsSync(this.skillsDir)) return [];

    const results: Skill[] = [];
    const entries = fs.readdirSync(this.skillsDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillPath = path.join(this.skillsDir, entry.name, 'SKILL.md');
      if (!fs.existsSync(skillPath)) continue;

      try {
        const fullContent = fs.readFileSync(skillPath, 'utf-8');
        const meta = this._parseFrontmatterMeta(fullContent);
        const content = this._stripFrontmatter(fullContent);

        if (!meta || !meta.name) continue;
        if (this.disabledSkills.has(meta.name)) continue;

        // Check requirements only when filterUnavailable is used (at listSkills level).
        // Discovery includes all skills regardless of availability.

        results.push({
          name: meta.name,
          description: meta.description || '',
          always: meta.always === true,
          content,
          path: skillPath,
          requires: meta.requires,
          metadata: meta,
        });
      } catch {
        // Skip malformed skills
        continue;
      }
    }

    return results;
  }

  /** Load raw skill file content (including frontmatter). */
  private _loadRawSkill(name: string): { fullContent: string; filePath: string } | undefined {
    const skillPath = path.join(this.skillsDir, name, 'SKILL.md');
    if (!fs.existsSync(skillPath)) return undefined;
    try {
      return { fullContent: fs.readFileSync(skillPath, 'utf-8'), filePath: skillPath };
    } catch {
      return undefined;
    }
  }

  /** Parse YAML frontmatter into metadata (simple line-based parser). */
  private _parseFrontmatterMeta(content: string): SkillMeta | undefined {
    const match = content.match(FRONTMATTER_RE);
    if (!match) return undefined;

    const yamlBlock = match[1];
    const meta: Record<string, unknown> = {};

    for (const line of yamlBlock.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      const colonIdx = trimmed.indexOf(':');
      if (colonIdx === -1) continue;

      const key = trimmed.slice(0, colonIdx).trim();
      let value: unknown = trimmed.slice(colonIdx + 1).trim();

      // Parse array values
      if (typeof value === 'string' && value.startsWith('[') && value.endsWith(']')) {
        value = value.slice(1, -1).split(',').map(v => v.trim().replace(/^['"]|['"]$/g, ''));
      }

      // Parse boolean/number
      if (value === 'true') value = true;
      else if (value === 'false') value = false;
      else if (/^\d+$/.test(value as string)) value = parseInt(value as string, 10);

      meta[key] = value;
    }

    // Merge nested metadata fields (desc, nanobot)
    const merged: Record<string, unknown> = { ...meta };
    for (const ns of ['desc', 'nanobot']) {
      const sub = meta[ns];
      if (sub && typeof sub === 'object') {
        Object.assign(merged, sub);
      }
    }

    return merged as unknown as SkillMeta;
  }

  /** Strip frontmatter from content, returning just the body. */
  private _stripFrontmatter(content: string): string {
    const match = content.match(FRONTMATTER_RE);
    return match ? match[2].trim() : content.trim();
  }

  /** Check if requirements (bins, env vars) are met. */
  private _checkRequirements(requires: Record<string, string[]>): boolean {
    for (const [key, values] of Object.entries(requires)) {
      if (key === 'bins') {
        for (const bin of values) {
          try {
            execFileSync('which', [bin], { stdio: 'ignore' });
          } catch {
            return false;
          }
        }
      } else if (key === 'env') {
        for (const envVar of values) {
          if (!process.env[envVar]) return false;
        }
      }
    }
    return true;
  }
}
