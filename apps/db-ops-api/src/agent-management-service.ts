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
import { dbConnection } from './db-connection.js';
import { createHash } from 'node:crypto';

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

export type AgentExtensionKind = 'tool' | 'skill';
export type AgentExtensionStatus = 'draft' | 'published' | 'archived';
export interface AgentExtensionInput {
  kind: AgentExtensionKind;
  name: string;
  description?: string;
  definition?: Record<string, unknown>;
  sourceText?: string | null;
}
export interface AgentExtensionRecord extends AgentExtensionInput {
  id: number;
  description: string;
  definition: Record<string, unknown>;
  sourceText: string | null;
  status: AgentExtensionStatus;
  version: number;
  digest: string;
  createdBy: number;
  updatedBy: number;
  publishedBy: number | null;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

function extensionName(name: unknown): name is string {
  return typeof name === 'string' && /^[a-zA-Z][a-zA-Z0-9._-]{0,127}$/.test(name);
}

function extensionDefinition(kind: AgentExtensionKind, definition: Record<string, unknown>): void {
  if (kind === 'tool') {
    if (typeof definition.parameters !== 'object' || !definition.parameters || Array.isArray(definition.parameters)) {
      throw new Error('AGENT_EXTENSION_SCHEMA_INVALID');
    }
    if (definition.handler !== undefined || definition.code !== undefined) {
      throw new Error('AGENT_EXTENSION_EXECUTION_FORBIDDEN');
    }
  } else if (definition.frontmatter !== undefined && (typeof definition.frontmatter !== 'object' || !definition.frontmatter)) {
    throw new Error('AGENT_EXTENSION_FRONTMATTER_INVALID');
  }
}

function mapExtension(row: any): AgentExtensionRecord {
  const parse = (value: unknown): Record<string, unknown> => {
    if (typeof value === 'string') { try { return JSON.parse(value) as Record<string, unknown>; } catch { return {}; } }
    return (value && typeof value === 'object' && !Array.isArray(value)) ? value as Record<string, unknown> : {};
  };
  return {
    id: Number(row.id), kind: row.kind, name: row.name, description: row.description || '',
    definition: parse(row.definition_json), sourceText: row.source_text ?? null, status: row.status,
    version: Number(row.version), digest: row.digest, createdBy: Number(row.created_by), updatedBy: Number(row.updated_by),
    publishedBy: row.published_by == null ? null : Number(row.published_by), publishedAt: row.published_at ?? null,
    createdAt: row.created_at, updatedAt: row.updated_at,
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

  async listExtensions(kind?: AgentExtensionKind, includeArchived = false): Promise<AgentExtensionRecord[]> {
    const pool = dbConnection.getPool();
    if (!pool) throw new Error('AGENT_EXTENSION_STORE_UNAVAILABLE');
    const where = [includeArchived ? '1=1' : "status <> 'archived'"];
    const values: any[] = [];
    if (kind) { where.push('kind = ?'); values.push(kind); }
    const [rows] = await pool.execute(`SELECT * FROM agent_extensions WHERE ${where.join(' AND ')} ORDER BY kind, name, version DESC`, values);
    return (rows as any[]).map(mapExtension);
  }

  async createExtension(input: AgentExtensionInput, actorId: number): Promise<AgentExtensionRecord> {
    if (!['tool', 'skill'].includes(input.kind) || !extensionName(input.name)) throw new Error('AGENT_EXTENSION_INPUT_INVALID');
    const definition = input.definition && typeof input.definition === 'object' && !Array.isArray(input.definition) ? input.definition : {};
    extensionDefinition(input.kind, definition);
    const description = String(input.description ?? '').slice(0, 2000);
    const sourceText = input.sourceText == null ? null : String(input.sourceText).slice(0, 256 * 1024);
    const digest = createHash('sha256').update(JSON.stringify({ kind: input.kind, name: input.name, description, definition, sourceText })).digest('hex');
    const pool = dbConnection.getPool();
    if (!pool) throw new Error('AGENT_EXTENSION_STORE_UNAVAILABLE');
    const [result] = await pool.execute(
      `INSERT INTO agent_extensions (kind, name, description, definition_json, source_text, status, version, digest, created_by, updated_by)
       SELECT ?, ?, ?, ?, ?, 'draft', COALESCE(MAX(version), 0) + 1, ?, ?, ? FROM agent_extensions WHERE kind = ? AND name = ?`,
      [input.kind, input.name, description, JSON.stringify(definition), sourceText, digest, actorId, actorId, input.kind, input.name],
    );
    const id = Number((result as any).insertId);
    const [rows] = await pool.execute('SELECT * FROM agent_extensions WHERE id = ?', [id]);
    return mapExtension((rows as any[])[0]);
  }

  async updateExtension(id: number, input: Partial<AgentExtensionInput>, actorId: number): Promise<AgentExtensionRecord | null> {
    const pool = dbConnection.getPool();
    if (!pool) throw new Error('AGENT_EXTENSION_STORE_UNAVAILABLE');
    const [existingRows] = await pool.execute('SELECT * FROM agent_extensions WHERE id = ? AND status = \'draft\'', [id]);
    const existing = (existingRows as any[])[0];
    if (!existing) return null;
    const current = mapExtension(existing);
    const next: AgentExtensionInput = { kind: current.kind, name: input.name ?? current.name, description: input.description ?? current.description, definition: input.definition ?? current.definition, sourceText: input.sourceText === undefined ? current.sourceText : input.sourceText };
    if (!extensionName(next.name)) throw new Error('AGENT_EXTENSION_INPUT_INVALID');
    extensionDefinition(next.kind, next.definition ?? {});
    const definition = next.definition ?? {};
    const sourceText = next.sourceText == null ? null : String(next.sourceText).slice(0, 256 * 1024);
    const digest = createHash('sha256').update(JSON.stringify({ kind: next.kind, name: next.name, description: next.description ?? '', definition, sourceText })).digest('hex');
    await pool.execute('UPDATE agent_extensions SET name = ?, description = ?, definition_json = ?, source_text = ?, digest = ?, updated_by = ? WHERE id = ? AND status = \'draft\'', [next.name, String(next.description ?? '').slice(0, 2000), JSON.stringify(definition), sourceText, digest, actorId, id]);
    const [rows] = await pool.execute('SELECT * FROM agent_extensions WHERE id = ?', [id]);
    return mapExtension((rows as any[])[0]);
  }

  async setExtensionStatus(id: number, status: 'published' | 'archived', actorId: number): Promise<AgentExtensionRecord | null> {
    const pool = dbConnection.getPool();
    if (!pool) throw new Error('AGENT_EXTENSION_STORE_UNAVAILABLE');
    const [result] = await pool.execute(
      status === 'published'
        ? "UPDATE agent_extensions SET status = 'published', published_by = ?, published_at = NOW(), updated_by = ? WHERE id = ? AND status = 'draft'"
        : "UPDATE agent_extensions SET status = 'archived', updated_by = ? WHERE id = ? AND status <> 'archived'",
      status === 'published' ? [actorId, actorId, id] : [actorId, id],
    );
    if (Number((result as any).affectedRows) !== 1) return null;
    const [rows] = await pool.execute('SELECT * FROM agent_extensions WHERE id = ?', [id]);
    return mapExtension((rows as any[])[0]);
  }
}

export const agentManagementService = new AgentManagementService();
