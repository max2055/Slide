import { dbConnection } from '../db-connection.js';
import type { ToolEffect } from '../tools/security-catalog.js';
import type { ToolPolicyResource } from '../tools/types.js';

export const DEFAULT_AGENT_ID = 'slide-db-ops';
export const AGENT_TOOL_EFFECTS = Object.freeze<ToolEffect[]>(['read', 'write', 'execute', 'secret', 'delegate']);

interface PolicyExecutor {
  execute(sql: string, values?: unknown[]): Promise<[any, unknown?]>;
  getConnection?(): Promise<PolicyConnection>;
}

interface PolicyConnection extends PolicyExecutor {
  beginTransaction(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  release(): void;
}

interface PolicyRow {
  agent_id: string;
  tool_allowlist: unknown;
  skill_allowlist: unknown;
  allowed_effects: unknown;
  resource_scope: unknown;
  version: number;
  updated_by: number | null;
  updated_at: Date | string;
}

export interface AgentResourceScope {
  instanceIds: number[] | null;
  serverIds: number[] | null;
}

export interface AgentSecurityPolicy {
  agentId: string;
  toolAllowlist: string[] | null;
  skillAllowlist: string[] | null;
  allowedEffects: ToolEffect[];
  resourceScope: AgentResourceScope;
  version: number;
  updatedBy: number | null;
  updatedAt: string | null;
}

export interface AgentSecurityPolicyUpdate {
  toolAllowlist: string[] | null;
  skillAllowlist: string[] | null;
  allowedEffects: ToolEffect[];
  resourceScope: AgentResourceScope;
  changeNote: string;
}

export interface AgentPolicyDecision {
  allowed: boolean;
  reasonCode?: 'AGENT_TOOL_DENIED' | 'AGENT_EFFECT_DENIED' | 'AGENT_RESOURCE_DENIED';
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return undefined; }
}

function stringList(value: unknown, nullable: boolean): string[] | null {
  const parsed = parseJson(value);
  if (nullable && (parsed === null || parsed === undefined)) return null;
  if (!Array.isArray(parsed)) return [];
  return [...new Set(parsed.filter((item): item is string => typeof item === 'string'))].sort();
}

function idList(value: unknown): number[] | null {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is number => Number.isSafeInteger(item) && item > 0))].sort((a, b) => a - b);
}

function normalizeRow(row: PolicyRow): AgentSecurityPolicy {
  const scope = parseJson(row.resource_scope) as Record<string, unknown> | undefined;
  const effects = stringList(row.allowed_effects, false) ?? [];
  return Object.freeze({
    agentId: row.agent_id,
    toolAllowlist: stringList(row.tool_allowlist, true),
    skillAllowlist: stringList(row.skill_allowlist, true),
    allowedEffects: effects.filter((effect): effect is ToolEffect => AGENT_TOOL_EFFECTS.includes(effect as ToolEffect)),
    resourceScope: Object.freeze({
      instanceIds: idList(scope?.instanceIds),
      serverIds: idList(scope?.serverIds),
    }),
    version: Number(row.version),
    updatedBy: row.updated_by === null ? null : Number(row.updated_by),
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
  });
}

function validateNames(value: string[] | null, field: string): string[] | null {
  if (value === null) return null;
  if (!Array.isArray(value) || value.length > 256) throw new Error(`${field}_INVALID`);
  const result = [...new Set(value.map((name) => String(name).trim()))].sort();
  if (result.some((name) => !/^[a-zA-Z0-9._-]{1,128}$/.test(name))) throw new Error(`${field}_INVALID`);
  return result;
}

function validateIds(value: number[] | null, field: string): number[] | null {
  if (value === null) return null;
  if (!Array.isArray(value) || value.length > 1000 || value.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
    throw new Error(`${field}_INVALID`);
  }
  return [...new Set(value)].sort((a, b) => a - b);
}

export function validateAgentSecurityPolicyUpdate(input: AgentSecurityPolicyUpdate): AgentSecurityPolicyUpdate {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || !input.resourceScope || typeof input.resourceScope !== 'object' || Array.isArray(input.resourceScope)
    || !Object.hasOwn(input.resourceScope, 'instanceIds') || !Object.hasOwn(input.resourceScope, 'serverIds')) {
    throw new Error('AGENT_RESOURCE_SCOPE_INVALID');
  }
  const effects = [...new Set(input.allowedEffects ?? [])];
  if (effects.length === 0 || effects.some((effect) => !AGENT_TOOL_EFFECTS.includes(effect))) {
    throw new Error('AGENT_ALLOWED_EFFECTS_INVALID');
  }
  const changeNote = String(input.changeNote ?? '').trim();
  if (!changeNote || changeNote.length > 500) throw new Error('AGENT_POLICY_CHANGE_NOTE_INVALID');
  return {
    toolAllowlist: validateNames(input.toolAllowlist, 'AGENT_TOOL_ALLOWLIST'),
    skillAllowlist: validateNames(input.skillAllowlist, 'AGENT_SKILL_ALLOWLIST'),
    allowedEffects: AGENT_TOOL_EFFECTS.filter((effect) => effects.includes(effect)),
    resourceScope: {
      instanceIds: validateIds(input.resourceScope?.instanceIds, 'AGENT_INSTANCE_SCOPE'),
      serverIds: validateIds(input.resourceScope?.serverIds, 'AGENT_SERVER_SCOPE'),
    },
    changeNote,
  };
}

function inheritedPolicy(agentId: string): AgentSecurityPolicy {
  return Object.freeze({
    agentId,
    toolAllowlist: null,
    skillAllowlist: null,
    allowedEffects: [...AGENT_TOOL_EFFECTS],
    resourceScope: Object.freeze({ instanceIds: null, serverIds: null }),
    version: 0,
    updatedBy: null,
    updatedAt: null,
  });
}

export class AgentSecurityPolicyService {
  private readonly cache = new Map<string, AgentSecurityPolicy>();

  constructor(private readonly executorProvider: () => PolicyExecutor | null = () => dbConnection.getPool() as PolicyExecutor | null) {}

  async initialize(): Promise<void> {
    const executor = this.executorProvider();
    if (!executor) throw new Error('AGENT_POLICY_STORE_UNAVAILABLE');
    const [rows] = await executor.execute('SELECT * FROM agent_security_policies ORDER BY agent_id');
    this.cache.clear();
    for (const row of rows as PolicyRow[]) this.cache.set(row.agent_id, normalizeRow(row));
  }

  get(agentId: string): AgentSecurityPolicy {
    return this.cache.get(agentId) ?? inheritedPolicy(agentId);
  }

  list(): AgentSecurityPolicy[] {
    return [...this.cache.values()].sort((a, b) => a.agentId.localeCompare(b.agentId));
  }

  async history(agentId: string, limit = 50): Promise<Record<string, unknown>[]> {
    const executor = this.executorProvider();
    if (!executor) throw new Error('AGENT_POLICY_STORE_UNAVAILABLE');
    const bounded = Number.isSafeInteger(limit) ? Math.min(Math.max(limit, 1), 100) : 50;
    const [rows] = await executor.execute(
      `SELECT h.id, h.agent_id, h.version, h.policy_json, h.change_note, h.changed_by,
              u.username AS changed_by_username, h.created_at
       FROM agent_security_policy_history h LEFT JOIN users u ON u.id = h.changed_by
       WHERE h.agent_id = ? ORDER BY h.version DESC LIMIT ${bounded}`,
      [agentId],
    );
    return (rows as Array<Record<string, unknown>>).map((row) => ({
      id: Number(row.id),
      agentId: String(row.agent_id),
      version: Number(row.version),
      policy: parseJson(row.policy_json),
      changeNote: String(row.change_note),
      changedBy: Number(row.changed_by),
      changedByUsername: row.changed_by_username ? String(row.changed_by_username) : null,
      createdAt: new Date(row.created_at as Date | string).toISOString(),
    }));
  }

  skillAllowlist(agentId: string): ReadonlySet<string> | null {
    const names = this.get(agentId).skillAllowlist;
    return names === null ? null : new Set(names);
  }

  evaluateTool(agentId: string, toolName: string, effect: ToolEffect, resource?: ToolPolicyResource): AgentPolicyDecision {
    const policy = this.get(agentId);
    if (policy.toolAllowlist !== null && !policy.toolAllowlist.includes(toolName)) return { allowed: false, reasonCode: 'AGENT_TOOL_DENIED' };
    if (!policy.allowedEffects.includes(effect)) return { allowed: false, reasonCode: 'AGENT_EFFECT_DENIED' };
    if (resource?.instanceId !== undefined && policy.resourceScope.instanceIds !== null
      && !policy.resourceScope.instanceIds.includes(resource.instanceId)) return { allowed: false, reasonCode: 'AGENT_RESOURCE_DENIED' };
    if (resource?.serverId !== undefined && policy.resourceScope.serverIds !== null
      && !policy.resourceScope.serverIds.includes(resource.serverId)) return { allowed: false, reasonCode: 'AGENT_RESOURCE_DENIED' };
    return { allowed: true };
  }

  async update(agentId: string, raw: AgentSecurityPolicyUpdate, actorId: number): Promise<AgentSecurityPolicy> {
    if (!/^[a-zA-Z0-9._-]{1,64}$/.test(agentId) || !Number.isSafeInteger(actorId) || actorId <= 0) {
      throw new Error('AGENT_POLICY_ID_INVALID');
    }
    const input = validateAgentSecurityPolicyUpdate(raw);
    const executor = this.executorProvider();
    if (!executor?.getConnection) throw new Error('AGENT_POLICY_STORE_UNAVAILABLE');
    const connection = await executor.getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.execute('SELECT version FROM agent_security_policies WHERE agent_id = ? FOR UPDATE', [agentId]);
      const version = Number((rows as Array<{ version: number }>)[0]?.version ?? 0) + 1;
      const policyJson = {
        toolAllowlist: input.toolAllowlist,
        skillAllowlist: input.skillAllowlist,
        allowedEffects: input.allowedEffects,
        resourceScope: input.resourceScope,
      };
      await connection.execute(
        `INSERT INTO agent_security_policies
         (agent_id, tool_allowlist, skill_allowlist, allowed_effects, resource_scope, version, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE tool_allowlist = VALUES(tool_allowlist), skill_allowlist = VALUES(skill_allowlist),
           allowed_effects = VALUES(allowed_effects), resource_scope = VALUES(resource_scope),
           version = VALUES(version), updated_by = VALUES(updated_by)`,
        [agentId, input.toolAllowlist === null ? null : JSON.stringify(input.toolAllowlist),
          input.skillAllowlist === null ? null : JSON.stringify(input.skillAllowlist),
          JSON.stringify(input.allowedEffects), JSON.stringify(input.resourceScope), version, actorId],
      );
      await connection.execute(
        `INSERT INTO agent_security_policy_history (agent_id, version, policy_json, change_note, changed_by)
         VALUES (?, ?, ?, ?, ?)`,
        [agentId, version, JSON.stringify(policyJson), input.changeNote, actorId],
      );
      await connection.commit();
      const policy: AgentSecurityPolicy = Object.freeze({
        agentId,
        ...policyJson,
        resourceScope: Object.freeze(policyJson.resourceScope),
        version,
        updatedBy: actorId,
        updatedAt: new Date().toISOString(),
      });
      this.cache.set(agentId, policy);
      return policy;
    } catch (error) {
      await connection.rollback().catch(() => undefined);
      throw error;
    } finally {
      connection.release();
    }
  }
}

export const agentSecurityPolicyService = new AgentSecurityPolicyService();
