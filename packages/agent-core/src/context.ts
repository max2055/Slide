/**
 * ContextBuilder — ported from nanobot agent/context.py
 *
 * Assembles system prompts and message arrays from bootstrap files,
 * memory context, skills summaries, and runtime info.
 */

import fs from 'node:fs';
import path from 'node:path';
import { MemoryStore } from './memory.js';
import { SkillsLoader } from './skills.js';
import type { SessionEntry } from './session.js';

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

    // Memory context
    const memoryContext = await this.memoryStore.getMemoryContext();
    if (memoryContext) {
      parts.push(memoryContext);
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

    // Runtime context
    const runtimeCtx = ContextBuilder._buildRuntimeContext();
    parts.push(runtimeCtx);

    return parts.join('\n\n');
  }

  /** Build a complete message array: system prompt + history + user message. */
  async buildMessages(
    history: SessionEntry[],
    userMessage: string,
    skillNames?: string[],
  ): Promise<Array<{ role: string; content: string; reasoning_content?: string | null; tool_calls?: any; tool_call_id?: string; name?: string }>> {
    const systemPrompt = await this.buildSystemPrompt(skillNames);
    const messages: Array<{ role: string; content: string; reasoning_content?: string | null; tool_calls?: any; tool_call_id?: string; name?: string }> = [
      { role: 'system', content: systemPrompt },
    ];

    // Add history
    for (const entry of history) {
      const msg: any = { role: entry.role, content: entry.content ?? '' };
      if (entry.reasoning_content) msg.reasoning_content = entry.reasoning_content;
      if (entry.tool_calls) msg.tool_calls = entry.tool_calls;
      if (entry.tool_call_id) msg.tool_call_id = entry.tool_call_id;
      if (entry.name) msg.name = entry.name;
      messages.push(msg);
    }

    // Build user message with runtime context and skill context appended
    let userContent = userMessage;
    const runtime = ContextBuilder._buildRuntimeContext();
    userContent += `\n\n${runtime}`;

    // Append available skills info
    if (skillNames && skillNames.length > 0) {
      userContent += `\n\nAvailable skills: ${skillNames.join(', ')}`;
    }

    messages.push({ role: 'user', content: userContent });

    return messages;
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
    const now = new Date();
    const dateStr = now.toISOString().split('T')[0];
    const timeStr = now.toTimeString().split(' ')[0];
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const weekday = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][now.getDay()];

    return `Current Time: ${dateStr} ${timeStr} ${tz} (${weekday})`;
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
