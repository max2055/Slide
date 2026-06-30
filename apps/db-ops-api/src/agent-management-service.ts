/**
 * Agent Management Service
 *
 * Provides unified API for frontend to query and manage:
 * - Skills (list, toggle enabled/disabled)
 * - Tools (list registered tools with schemas)
 */

import { skillRegistry } from './skills/loader.js';
import { getAgentEngine } from './adapter/get-agent-engine.js';
import type { SkillEntry } from './skills/types.js';
import type { ToolSchema } from '@slide/agent-core';

// In-memory set of disabled skill names
const disabledSkills = new Set<string>();

export interface SkillInfo {
  name: string;
  description: string;
  filePath: string;
  enabled: boolean;
  frontmatter: Record<string, unknown>;
}

export interface ToolInfo {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export class AgentManagementService {
  /**
   * List all registered skills with their enabled status
   */
  listSkills(): SkillInfo[] {
    const all = skillRegistry.getAll();
    return all.map((entry: SkillEntry) => ({
      name: entry.skill.name,
      description: entry.skill.description || '',
      filePath: entry.skill.filePath || '',
      enabled: !disabledSkills.has(entry.skill.name),
      frontmatter: (entry.frontmatter as Record<string, unknown>) || {},
    }));
  }

  /**
   * Toggle a skill's enabled/disabled state
   * @returns true if skill exists and was toggled, false if skill not found
   */
  toggleSkill(name: string, enabled: boolean): boolean {
    if (!skillRegistry.has(name)) return false;
    if (enabled) {
      disabledSkills.delete(name);
    } else {
      disabledSkills.add(name);
    }
    return true;
  }

  /**
   * Check if a skill is currently enabled
   */
  isSkillEnabled(name: string): boolean {
    return !disabledSkills.has(name);
  }

  /**
   * List all registered tools with their schemas
   */
  async listTools(): Promise<ToolInfo[]> {
    const engine = await getAgentEngine();
    const tools = engine.listTools();
    return tools.map((t: ToolSchema) => ({
      name: t.name,
      description: t.description || '',
      parameters: (t.parameters as Record<string, unknown>) || {},
    }));
  }
}

export const agentManagementService = new AgentManagementService();
