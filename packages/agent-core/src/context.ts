/**
 * ContextBuilder — TypeScript context assembly implemented for Slide.
 *
 * Assembles system prompts and message arrays from bootstrap files,
 * memory context, skills summaries, and runtime info.
 */

import fs from 'node:fs';
import path from 'node:path';
import { MemoryStore } from './memory.js';
import { SkillsLoader } from './skills.js';
import type { SessionEntry } from './session.js';
import type { Message } from './types.js';
import { currentTime, projectContextBlocks, runtimeBlock, type ContextBlock } from './context-block.js';

// ── Constants ──

const BOOTSTRAP_FILES = ['SOUL.md', 'AGENTS.md', 'HEARTBEAT.md'] as const;

// ── ContextBuilder ──

export class ContextBuilder {
  private workspace: string;
  private memoryStore: MemoryStore;
  private skillsLoader: SkillsLoader;
  private disabledSkills: Set<string>;

  constructor(
    workspace: string,
    options?: {
      memoryStore?: MemoryStore;
      skillsLoader?: SkillsLoader;
      disabledSkills?: string[];
    },
  ) {
    this.workspace = workspace;
    this.memoryStore = options?.memoryStore ?? new MemoryStore(workspace);
    this.skillsLoader = options?.skillsLoader ?? new SkillsLoader(workspace, {
      disabledSkills: options?.disabledSkills,
    });
    this.disabledSkills = new Set(options?.disabledSkills ?? []);
  }

  /** Build the system prompt from bootstrap files, memory, and skills. */
  async buildSystemPrompt(skillNames?: string[]): Promise<string> {
    const parts: string[] = [];

    // Bootstrap files (identity)
    for (const file of BOOTSTRAP_FILES) {
      const content = await this._readBootstrapFile(file);
      if (content) {
        parts.push(`## ${file.replace('.md', '')}\n\n${content.trim()}`);
      }
    }

    // Skills content (when skillNames provided, include full body)
    if (skillNames && skillNames.length > 0) {
      const skillParts = this.skillsLoader.loadSkillsForContext(skillNames);
      if (skillParts.length > 0) {
        parts.push(skillParts.join('\n\n'));
      }
    } else {
      // Skills summary (compact list for general prompt)
      const skillsSummary = this.skillsLoader.buildSkillsSummary();
      if (skillsSummary) {
        parts.push(skillsSummary);
      }
    }

    return parts.join('\n\n') || 'You are a helpful database operations assistant.';
  }

  /** Build a complete message array: system prompt + history + user message. */
  async buildBlocks(history: SessionEntry[], userMessage: string, skillNames?: string[]): Promise<ContextBlock[]> {
    const policy = await this.buildSystemPrompt(skillNames);
    const memory = await this.memoryStore.getMemoryContext();
    return [
      { kind: 'policy', sourceIds: [...BOOTSTRAP_FILES], authority: 'policy', lifetime: 'session', priority: 100, tokenPolicy: 'protected', messages: [{ role: 'system', content: policy }] },
      ...(memory ? [{ kind: 'memory' as const, sourceIds: ['MEMORY.md'], authority: 'reference' as const, lifetime: 'request' as const, priority: 40, tokenPolicy: 'bounded' as const, value: memory }] : []),
      { kind: 'history', sourceIds: history.flatMap(m => m.id ? [m.id] : []), authority: 'user', lifetime: 'session', priority: 50, tokenPolicy: 'bounded', messages: history as Message[] },
      runtimeBlock('runtime', currentTime()),
      { kind: 'current_user', sourceIds: [], authority: 'user', lifetime: 'session', priority: 100, tokenPolicy: 'protected', messages: [{ role: 'user', content: userMessage }] },
    ];
  }

  async buildMessages(history: SessionEntry[], userMessage: string, skillNames?: string[]): Promise<Message[]> {
    return projectContextBlocks(await this.buildBlocks(history, userMessage, skillNames));
  }

  /** Get the workspace path used by this builder. */
  getWorkspace(): string {
    return this.workspace;
  }

  /** Get the set of disabled skill names. */
  getDisabledSkills(): string[] {
    return [...this.disabledSkills];
  }

  /** Force skills cache invalidation (picks up newly installed skills). */
  invalidateSkillsCache(): void {
    this.skillsLoader.invalidateCache();
  }

  /** Build a minimal system prompt with runtime context only (no bootstrap, memory, or skills). */
  async buildMinimalSystemPrompt(): Promise<string> {
    return ContextBuilder._buildRuntimeContext();
  }

  /** Build runtime context string (time-based info). */
  static _buildRuntimeContext(): string {
    return currentTime();
  }

  // ── Private ──

  private async _readBootstrapFile(filename: string): Promise<string | null> {
    const filePath = path.join(this.workspace, filename);
    if (!fs.existsSync(filePath)) return null;
    try {
      const content = await fs.promises.readFile(filePath, 'utf-8');
      return content.trim();
    } catch {
      return null;
    }
  }
}
