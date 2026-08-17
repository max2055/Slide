import { dbConnection } from '../db-connection.js';
import type { ActorContext } from '../auth/actor-context.js';
import { getToolSecurityDefinition } from '../tools/security-catalog.js';
import type { PolicyDecision, ToolResult } from '../tools/types.js';
import { redactSensitiveData } from './sensitive-data.js';
import type { AgentSecurityPolicy } from './agent-security-policy-service.js';

interface AuditExecutor {
  execute(sql: string, values?: unknown[]): Promise<[any, unknown?]>;
}

interface AuditRow {
  id: number | string;
  phase: 'decision' | 'result';
  actor_id: number;
  actor_username?: string;
  agent_id: string;
  request_id: string;
  tool_name: string;
  allowed: number | boolean;
  reason_code: string;
  resource_json: unknown;
  policy_snapshot?: unknown;
  args_redacted?: unknown;
  result_redacted?: unknown;
  approval_id: number | string | null;
  created_at: Date | string;
}

export interface AgentToolAuditFilters {
  agentId?: string;
  actorId?: number;
  toolName?: string;
  phase?: 'decision' | 'result';
  allowed?: boolean;
  reasonCode?: string;
  from?: Date;
  to?: Date;
  cursor?: number;
  limit?: number;
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return null; }
}

function publicRow(row: AuditRow, detail = false): Record<string, unknown> {
  return {
    id: Number(row.id),
    phase: row.phase,
    actorId: Number(row.actor_id),
    actorUsername: row.actor_username ?? null,
    agentId: row.agent_id,
    requestId: row.request_id,
    toolName: row.tool_name,
    allowed: Boolean(row.allowed),
    reasonCode: row.reason_code,
    resource: parseJson(row.resource_json),
    approvalId: row.approval_id === null ? null : Number(row.approval_id),
    createdAt: new Date(row.created_at).toISOString(),
    ...(detail ? {
      policySnapshot: parseJson(row.policy_snapshot),
      args: parseJson(row.args_redacted),
      result: parseJson(row.result_redacted),
    } : {}),
  };
}

function codeExecutionAuditArgs(args: Record<string, unknown>): Record<string, unknown> {
  const files = Array.isArray(args.files) ? args.files : [];
  return {
    runtime: typeof args.runtime === 'string' ? args.runtime : 'invalid',
    codeBytes: typeof args.code === 'string' ? Buffer.byteLength(args.code, 'utf8') : 0,
    fileCount: files.length,
    filesBytes: files.reduce((total, file) => total + (
      file && typeof file === 'object' && typeof (file as Record<string, unknown>).content === 'string'
        ? Buffer.byteLength((file as Record<string, string>).content, 'utf8') : 0
    ), 0),
    timeoutMs: typeof args.timeoutMs === 'number' ? args.timeoutMs : null,
  };
}

function codeExecutionAuditResult(result: ToolResult | undefined): unknown {
  if (!result) return null;
  if (!result.success || !result.data || typeof result.data !== 'object') {
    return { success: false, errorCode: result.errorCode ?? 'SANDBOX_EXECUTION_FAILED' };
  }
  const data = result.data as Record<string, unknown>;
  return {
    success: true,
    data: {
      jobId: typeof data.jobId === 'string' ? data.jobId : null,
      exitCode: typeof data.exitCode === 'number' || data.exitCode === null ? data.exitCode : null,
      timedOut: data.timedOut === true,
      outputTruncated: data.outputTruncated === true,
      stdoutBytes: typeof data.stdout === 'string' ? Buffer.byteLength(data.stdout, 'utf8') : 0,
      stderrBytes: typeof data.stderr === 'string' ? Buffer.byteLength(data.stderr, 'utf8') : 0,
    },
  };
}

export interface AgentToolAuditRecord {
  phase: 'decision' | 'result';
  actor: ActorContext;
  decision: PolicyDecision;
  args: Record<string, unknown>;
  result?: ToolResult;
  agentId?: string;
  agentPolicy?: AgentSecurityPolicy;
}

export class AgentToolAuditService {
  constructor(
    private readonly executorProvider: () => AuditExecutor | null = () => dbConnection.getPool() as AuditExecutor | null,
  ) {}

  async record(record: AgentToolAuditRecord): Promise<void> {
    const executor = this.executorProvider();
    if (!executor) throw new Error('AGENT_TOOL_AUDIT_STORE_UNAVAILABLE');
    const security = getToolSecurityDefinition(record.decision.tool);
    const auditArgs = record.decision.tool === 'execute_code'
      ? codeExecutionAuditArgs(record.args)
      : redactSensitiveData(record.args);
    const auditResult = record.decision.tool === 'execute_code'
      ? codeExecutionAuditResult(record.result)
      : record.result === undefined ? null : redactSensitiveData(record.result);
    const [result] = await executor.execute(
      `INSERT INTO agent_tool_audit
       (phase, actor_id, agent_id, request_id, tool_name, allowed, reason_code, resource_json,
        policy_snapshot, args_redacted, result_redacted, approval_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        record.phase,
        record.actor.userId,
        record.agentId ?? 'slide-db-ops',
        record.actor.requestId,
        record.decision.tool,
        record.decision.allow,
        record.decision.reasonCode,
        JSON.stringify(record.decision.resource),
        JSON.stringify({
          actorSessionVersion: record.actor.sessionVersion,
          roles: record.actor.roles,
          permissions: record.actor.permissions,
          security,
          agentPolicy: record.agentPolicy ?? null,
        }),
        JSON.stringify(auditArgs),
        auditResult === null ? null : JSON.stringify(auditResult),
        record.decision.approvalId ?? null,
      ],
    );
    if (!result?.insertId && Number(result?.affectedRows) !== 1) {
      throw new Error('AGENT_TOOL_AUDIT_WRITE_FAILED');
    }
  }

  async list(filters: AgentToolAuditFilters = {}): Promise<{ records: Record<string, unknown>[]; nextCursor: number | null }> {
    const executor = this.executorProvider();
    if (!executor) throw new Error('AGENT_TOOL_AUDIT_STORE_UNAVAILABLE');
    const limit = Number.isSafeInteger(filters.limit) ? Math.min(Math.max(Number(filters.limit), 1), 100) : 50;
    const clauses: string[] = [];
    const values: unknown[] = [];
    const add = (sql: string, value: unknown) => { clauses.push(sql); values.push(value); };
    if (filters.agentId) add('a.agent_id = ?', filters.agentId);
    if (filters.actorId) add('a.actor_id = ?', filters.actorId);
    if (filters.toolName) add('a.tool_name = ?', filters.toolName);
    if (filters.phase) add('a.phase = ?', filters.phase);
    if (filters.allowed !== undefined) add('a.allowed = ?', filters.allowed);
    if (filters.reasonCode) add('a.reason_code = ?', filters.reasonCode);
    if (filters.from) add('a.created_at >= ?', filters.from);
    if (filters.to) add('a.created_at <= ?', filters.to);
    if (filters.cursor) add('a.id < ?', filters.cursor);
    const [rows] = await executor.execute(
      `SELECT a.id, a.phase, a.actor_id, u.username AS actor_username, a.agent_id, a.request_id,
              a.tool_name, a.allowed, a.reason_code, a.resource_json, a.approval_id, a.created_at
       FROM agent_tool_audit a
       LEFT JOIN users u ON u.id = a.actor_id
       ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
       ORDER BY a.id DESC LIMIT ${limit + 1}`,
      values,
    );
    const page = rows as AuditRow[];
    const hasMore = page.length > limit;
    const selected = page.slice(0, limit);
    return {
      records: selected.map((row) => publicRow(row)),
      nextCursor: hasMore ? Number(selected[selected.length - 1]?.id) : null,
    };
  }

  async detail(id: number): Promise<Record<string, unknown> | null> {
    const executor = this.executorProvider();
    if (!executor) throw new Error('AGENT_TOOL_AUDIT_STORE_UNAVAILABLE');
    if (!Number.isSafeInteger(id) || id <= 0) return null;
    const [rows] = await executor.execute(
      `SELECT a.*, u.username AS actor_username
       FROM agent_tool_audit a LEFT JOIN users u ON u.id = a.actor_id WHERE a.id = ? LIMIT 1`,
      [id],
    );
    const row = (rows as AuditRow[])[0];
    return row ? publicRow(row, true) : null;
  }
}

export const agentToolAuditService = new AgentToolAuditService();
