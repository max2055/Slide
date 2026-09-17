import { randomUUID } from 'node:crypto';
import { dbConnection } from '../db-connection.js';
import { AgentToolApprovalService, type ApprovalConsumeOptions, type ApprovalConsumeResult } from './agent-tool-approval-service.js';
import type { AuditExecutor } from './agent-tool-audit-service.js';

interface Transaction extends AuditExecutor {
  beginTransaction(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  release(): void;
  destroy(): void;
}
interface Pool { getConnection(): Promise<Transaction> }

export interface ApprovalExecution extends ApprovalConsumeResult {
  executionId?: string;
  /** Only the dispatch owner may refund, and only before calling the handler. */
  releaseBeforeHandler?: () => Promise<void>;
  finish?: () => Promise<void>;
}

/** Consumption, durable dispatch intent and decision audit commit together. */
export class AgentToolApprovalExecution {
  constructor(private readonly pool: Pool = dbConnection.getPool() as Pool) {}

  private async transaction<T>(action: (connection: Transaction) => Promise<T>): Promise<T> {
    if (!this.pool) throw new Error('AGENT_APPROVAL_STORE_UNAVAILABLE');
    const connection = await this.pool.getConnection();
    let discarded = false;
    try {
      await connection.beginTransaction();
      const result = await action(connection);
      await connection.commit();
      return result;
    } catch (error) {
      try {
        await connection.rollback();
      } catch (rollbackError) {
        discarded = true;
        connection.destroy();
        throw rollbackError;
      }
      throw error;
    } finally {
      if (!discarded) connection.release();
    }
  }

  async authorize(
    id: string, bindingHash: string, requesterId: number, requestId: string,
    options: ApprovalConsumeOptions | undefined,
    audit: (outcome: ApprovalConsumeResult, connection: AuditExecutor) => Promise<void>,
    signal?: AbortSignal,
  ): Promise<ApprovalExecution> {
    const executionId = randomUUID();
    const outcome = await this.transaction(async (connection) => {
      // Serialize against revocation and concurrent consumers before reading scope.
      await connection.execute('SELECT id FROM agent_tool_approvals WHERE id = ? FOR UPDATE', [id]);
      const service = new AgentToolApprovalService(() => connection, 'transaction-only-unused-key');
      const result = await service.consumeApprovedDetailed(id, bindingHash, requesterId, options);
      if (result.approved) {
        await connection.execute(
          "INSERT INTO agent_tool_execution_intents (id, approval_id, request_id, state) VALUES (?, ?, ?, 'dispatching')",
          [executionId, id, requestId],
        );
      }
      await audit(result, connection);
      if (signal?.aborted) throw new Error('TOOL_EXECUTION_CANCELLED');
      return result;
    });
    if (!outcome.approved) return outcome;
    return {
      ...outcome,
      executionId,
      releaseBeforeHandler: () => this.transaction(async (connection) => {
        // Always lock approval before intent, as in authorize. Each receipt refunds once.
        await connection.execute('SELECT id FROM agent_tool_approvals WHERE id = ? FOR UPDATE', [id]);
        const [released] = await connection.execute(
          "UPDATE agent_tool_execution_intents SET state = 'released' WHERE id = ? AND state = 'dispatching'",
          [executionId],
        );
        if (Number(released.affectedRows) !== 1) return;
        await connection.execute(
          `UPDATE agent_tool_approvals SET
             status = CASE WHEN scope = 'once' AND status = 'consumed' THEN 'approved' ELSE status END,
             used_count = CASE WHEN scope <> 'once' THEN GREATEST(used_count, 1) - 1 ELSE used_count END
           WHERE id = ?`, [id],
        );
      }),
      finish: () => this.transaction(async (connection) => {
        await connection.execute(
          "UPDATE agent_tool_execution_intents SET state = 'finished' WHERE id = ? AND state = 'dispatching'",
          [executionId],
        );
      }),
    };
  }
}
