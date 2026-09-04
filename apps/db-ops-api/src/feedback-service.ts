import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import type { ActorContext } from './auth/actor-context.js';
import { dbConnection } from './db-connection.js';

export type FeedbackSource = 'manual' | 'agent';
export type FeedbackStatus = 'pending' | 'accepted' | 'resolved';

export interface FeedbackItem {
  id: number;
  title: string;
  description: string;
  source: FeedbackSource;
  status: FeedbackStatus;
  createdBy: number | null;
  createdByUsername: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface FeedbackInput {
  title: string;
  description: string;
  source: FeedbackSource;
  status?: FeedbackStatus;
  idempotencyKey?: string;
}

interface FeedbackRow extends RowDataPacket {
  id: number;
  title: string;
  description: string;
  source: FeedbackSource;
  status: FeedbackStatus;
  created_by: number | null;
  created_by_username: string | null;
  created_at: Date;
  updated_at: Date;
}

interface FeedbackExecutor {
  execute<T = unknown>(sql: string, values?: unknown[]): Promise<[T, unknown]>;
}

const FEEDBACK_SELECT = `
  SELECT f.id, f.title, f.description, f.source, f.status, f.created_by,
         u.username AS created_by_username, f.created_at, f.updated_at
  FROM problem_feedback f
  LEFT JOIN users u ON u.id = f.created_by`;

function isAdmin(actor: ActorContext): boolean {
  return actor.username.toLowerCase() === 'admin'
    || actor.roles.includes('admin')
    || actor.permissions.includes('*')
    || actor.permissions.includes('admin:*');
}

function normalizeInput(input: FeedbackInput): FeedbackInput {
  const title = input.title.trim();
  const description = input.description.trim();
  if (!title || title.length > 160 || !description || description.length > 5000) {
    throw new Error('FEEDBACK_PAYLOAD_INVALID');
  }
  if (input.source !== 'manual' && input.source !== 'agent') {
    throw new Error('FEEDBACK_PAYLOAD_INVALID');
  }
  if (input.status !== undefined && !['pending', 'accepted', 'resolved'].includes(input.status)) {
    throw new Error('FEEDBACK_PAYLOAD_INVALID');
  }
  if (input.idempotencyKey && !/^[a-f0-9]{64}$/.test(input.idempotencyKey)) {
    throw new Error('FEEDBACK_PAYLOAD_INVALID');
  }
  return { ...input, title, description };
}

function toFeedbackItem(row: FeedbackRow): FeedbackItem {
  return {
    id: Number(row.id),
    title: row.title,
    description: row.description,
    source: row.source,
    status: row.status,
    createdBy: row.created_by == null ? null : Number(row.created_by),
    createdByUsername: row.created_by_username,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

export class FeedbackService {
  constructor(
    private readonly poolProvider: () => FeedbackExecutor | null = () => dbConnection.getPool() as FeedbackExecutor | null,
  ) {}

  async list(actor: ActorContext): Promise<FeedbackItem[]> {
    const pool = this.pool();
    const scoped = !isAdmin(actor);
    const [rows] = await pool.execute<FeedbackRow[]>(
      `${FEEDBACK_SELECT}${scoped ? ' WHERE f.created_by = ?' : ''} ORDER BY f.created_at DESC, f.id DESC`,
      scoped ? [actor.userId] : [],
    );
    return rows.map(toFeedbackItem);
  }

  async create(actor: ActorContext, rawInput: FeedbackInput): Promise<FeedbackItem> {
    const input = normalizeInput(rawInput);
    const pool = this.pool();
    const [result] = await pool.execute<ResultSetHeader>(
      `INSERT INTO problem_feedback
         (title, description, source, created_by, updated_by, idempotency_key)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)`,
      [input.title, input.description, input.source, actor.userId, actor.userId, input.idempotencyKey ?? null],
    );
    return this.requireVisible(actor, Number(result.insertId));
  }

  async update(
    actor: ActorContext,
    id: number,
    rawInput: Pick<FeedbackInput, 'title' | 'description' | 'status'>,
  ): Promise<FeedbackItem> {
    const input = normalizeInput({ ...rawInput, source: 'manual' });
    const existing = await this.requireVisible(actor, id);
    const status = input.status ?? existing.status;
    const scoped = !isAdmin(actor);
    await this.pool().execute<ResultSetHeader>(
      `UPDATE problem_feedback SET title = ?, description = ?, status = ?, updated_by = ? WHERE id = ?${scoped ? ' AND created_by = ?' : ''}`,
      scoped
        ? [input.title, input.description, status, actor.userId, id, actor.userId]
        : [input.title, input.description, status, actor.userId, id],
    );
    return this.requireVisible(actor, id);
  }

  async delete(actor: ActorContext, id: number): Promise<void> {
    await this.requireVisible(actor, id);
    const scoped = !isAdmin(actor);
    await this.pool().execute<ResultSetHeader>(
      `DELETE FROM problem_feedback WHERE id = ?${scoped ? ' AND created_by = ?' : ''}`,
      scoped ? [id, actor.userId] : [id],
    );
  }

  private async requireVisible(actor: ActorContext, id: number): Promise<FeedbackItem> {
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error('FEEDBACK_NOT_FOUND');
    const scoped = !isAdmin(actor);
    const [rows] = await this.pool().execute<FeedbackRow[]>(
      `${FEEDBACK_SELECT} WHERE f.id = ?${scoped ? ' AND f.created_by = ?' : ''} LIMIT 1`,
      scoped ? [id, actor.userId] : [id],
    );
    if (!rows[0]) throw new Error('FEEDBACK_NOT_FOUND');
    return toFeedbackItem(rows[0]);
  }

  private pool(): FeedbackExecutor {
    const pool = this.poolProvider();
    if (!pool) throw new Error('FEEDBACK_STORAGE_UNAVAILABLE');
    return pool;
  }
}

export const feedbackService = new FeedbackService();
