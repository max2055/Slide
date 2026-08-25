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
import { isSkillEnabled, setSkillEnabled } from './skills/runtime-policy.js';
import { getToolSecurityDefinition, type ToolSecurityDefinition } from './tools/security-catalog.js';

export interface SkillInfo {
  name: string;
  description: string;
  filePath: string;
  enabled: boolean;
  frontmatter: Record<string, unknown>;
  source: string;
  digest: string;
  trusted: boolean;
}

export interface ToolInfo {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  security: ToolSecurityDefinition | null;
  metadata: {
    readOnly?: boolean;
    scope?: string[];
    ownerOnly?: boolean;
    group?: string;
    pluginId?: string;
    requiresApproval?: boolean;
    dangerLevel?: number;
  };
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
      enabled: isSkillEnabled(entry.skill.name),
      frontmatter: (entry.frontmatter as Record<string, unknown>) || {},
      source: entry.security?.source ?? 'temporary',
      digest: entry.security?.digest ?? '',
      trusted: entry.security?.trusted === true,
    }));
  }

  /**
   * Toggle a skill's enabled/disabled state
   * @returns true if skill exists and was toggled, false if skill not found
   */
  toggleSkill(name: string, enabled: boolean): boolean {
    if (!skillRegistry.has(name)) return false;
    setSkillEnabled(name, enabled);
    return true;
  }

  /**
   * Check if a skill is currently enabled
   */
  isSkillEnabled(name: string): boolean {
    return isSkillEnabled(name);
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
      security: getToolSecurityDefinition(t.name) ?? null,
      metadata: {
        readOnly: t.metadata?.readOnly,
        scope: t.metadata?.scope,
        ownerOnly: t.metadata?.ownerOnly,
        group: t.metadata?.group,
        pluginId: t.metadata?.pluginId,
        requiresApproval: t.metadata?.requiresApproval,
        dangerLevel: t.metadata?.dangerLevel,
      },
    }));
  }
}

export const agentManagementService = new AgentManagementService();
