import { createHash, randomBytes, randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import type { Pool, PoolConnection } from 'mysql2/promise';
import { dbConnection } from '../db-connection.js';
import { securityEventService } from '../security/security-event-service.js';

export type InstanceAccessLevel = 'read-only' | 'read-write' | 'admin';

export interface ActorContext {
  readonly userId: number;
  readonly username: string;
  readonly roles: readonly string[];
  readonly permissions: readonly string[];
  readonly sessionVersion: number;
  readonly instanceScopes: Readonly<Record<number, InstanceAccessLevel>>;
  readonly requestId: string;
}

export class ActorAuthenticationError extends Error {
  constructor(options?: ErrorOptions) {
    super('Authentication failed');
    this.name = 'ActorAuthenticationError';
    if (options?.cause !== undefined) this.cause = options.cause;
  }
}

interface QueryExecutor {
  execute(sql: string, values?: unknown[]): Promise<any>;
}

interface TransactionConnection extends QueryExecutor {
  beginTransaction(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  release(): void;
}

interface ActorPool extends QueryExecutor {
  getConnection?(): Promise<TransactionConnection>;
}

interface ActorSnapshotRow {
  id: number;
  username: string;
  status: string;
  session_version: number;
  role_name: string | null;
  permission_code: string | null;
  instance_id: number | null;
  access_level: InstanceAccessLevel | null;
}

interface AccessTokenClaims {
  userId: number;
  sessionVersion: number;
}

const ACTOR_SNAPSHOT_SQL = `
  SELECT u.id, u.username, u.status, u.session_version,
         r.name AS role_name, p.code AS permission_code,
         ip.instance_id, ip.access_level
  FROM users u
  LEFT JOIN user_roles ur
    ON ur.user_id = u.id
   AND (ur.grant_expiry IS NULL OR ur.grant_expiry > NOW())
  LEFT JOIN roles r ON r.id = ur.role_id
  LEFT JOIN role_permissions rp ON rp.role_id = r.id
  LEFT JOIN permissions p ON p.id = rp.permission_id
  LEFT JOIN instance_permissions ip
    ON ip.user_id = u.id
   AND (ip.grant_expiry IS NULL OR ip.grant_expiry > NOW())
  WHERE u.id = ?
`;

function isAccessTokenClaims(value: unknown): value is AccessTokenClaims {
  if (!value || typeof value !== 'object') return false;
  const claims = value as Partial<AccessTokenClaims>;
  return Number.isInteger(claims.userId)
    && Number(claims.userId) > 0
    && Number.isInteger(claims.sessionVersion)
    && Number(claims.sessionVersion) > 0;
}

function asAuthenticationError(error: unknown): ActorAuthenticationError {
  return error instanceof ActorAuthenticationError
    ? error
    : new ActorAuthenticationError({ cause: error });
}

async function schemaObjectExists(
  connection: PoolConnection,
  sql: string,
  values: string[],
): Promise<boolean> {
  const [rows] = await connection.execute(sql, values);
  const countRows = rows as Array<{ count: number }>;
  return Number(countRows[0]?.count ?? 0) > 0;
}

/**
 * Applies the runtime security delta on one checked-out connection.
 * Full schema rebuild parity belongs to Phase 134 (HI-01); startup only ensures
 * the columns/index required before ActorContext can authenticate requests.
 */
export async function applyActorSecuritySchema(pool: Pick<Pool, 'getConnection'>): Promise<void> {
  const connection = await pool.getConnection();
  try {
    const userVersionExists = await schemaObjectExists(
      connection,
      `SELECT COUNT(*) AS count FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
      ['users', 'session_version'],
    );
    if (!userVersionExists) {
      await connection.execute(
        `ALTER TABLE users
         ADD COLUMN session_version BIGINT UNSIGNED NOT NULL DEFAULT 1
         COMMENT 'Incremented when security-sensitive user state changes'
         AFTER status`,
      );
    }

    const refreshVersionExists = await schemaObjectExists(
      connection,
      `SELECT COUNT(*) AS count FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
      ['refresh_tokens', 'session_version'],
    );
    if (!refreshVersionExists) {
      await connection.execute(
        `ALTER TABLE refresh_tokens
         ADD COLUMN session_version BIGINT UNSIGNED NOT NULL DEFAULT 1
         COMMENT 'User session version at issuance'
         AFTER user_id`,
      );
    }

    const sessionIndexExists = await schemaObjectExists(
      connection,
      `SELECT COUNT(*) AS count FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?`,
      ['refresh_tokens', 'idx_rt_user_session'],
    );
    if (!sessionIndexExists) {
      await connection.execute(
        `ALTER TABLE refresh_tokens
         ADD INDEX idx_rt_user_session (user_id, session_version, revoked)`,
      );
    }

    await connection.execute(
      `CREATE TABLE IF NOT EXISTS chat_session_shares (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        session_id VARCHAR(100) NOT NULL,
        granted_by INT UNSIGNED NOT NULL,
        recipient_user_id INT UNSIGNED NOT NULL,
        permission ENUM('read') NOT NULL DEFAULT 'read',
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_chat_session_share_recipient (session_id, recipient_user_id),
        KEY idx_chat_share_recipient_permission (recipient_user_id, permission),
        KEY idx_chat_share_grantor (granted_by),
        CONSTRAINT fk_chat_share_session
          FOREIGN KEY (session_id) REFERENCES chat_sessions (session_id) ON DELETE CASCADE,
        CONSTRAINT fk_chat_share_grantor
          FOREIGN KEY (granted_by) REFERENCES users (id) ON DELETE CASCADE,
        CONSTRAINT fk_chat_share_recipient
          FOREIGN KEY (recipient_user_id) REFERENCES users (id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    );
  } finally {
    connection.release();
  }
}

export class ActorContextService {
  constructor(
    private readonly poolProvider: () => ActorPool | null = () => dbConnection.getPool() as ActorPool | null,
  ) {}

  async loadActiveActor(
    userId: number,
    expectedSessionVersion?: number,
    requestId: string = randomUUID(),
  ): Promise<ActorContext> {
    const pool = this.poolProvider();
    if (!pool) throw new ActorAuthenticationError();

    try {
      return await this.loadActorFrom(pool, userId, expectedSessionVersion, requestId);
    } catch (error) {
      throw asAuthenticationError(error);
    }
  }

  async authenticateAccessToken(
    token: string,
    secret: string,
    requestId: string = randomUUID(),
  ): Promise<ActorContext> {
    try {
      const decoded = jwt.verify(token, secret);
      if (!isAccessTokenClaims(decoded)) throw new ActorAuthenticationError();
      return await this.loadActiveActor(decoded.userId, decoded.sessionVersion, requestId);
    } catch (error) {
      throw asAuthenticationError(error);
    }
  }

  async revalidateActor(actor: ActorContext, requestId: string = randomUUID()): Promise<ActorContext> {
    return this.loadActiveActor(actor.userId, actor.sessionVersion, requestId);
  }

  async issueRefreshToken(
    actor: ActorContext,
    expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
  ): Promise<string> {
    const pool = this.poolProvider();
    if (!pool) throw new ActorAuthenticationError();

    const token = randomBytes(48).toString('hex');
    const tokenHash = createHash('sha256').update(token).digest('hex');
    try {
      await pool.execute(
        `INSERT INTO refresh_tokens (token_hash, user_id, session_version, expires_at)
         VALUES (?, ?, ?, ?)`,
        [tokenHash, actor.userId, actor.sessionVersion, expiresAt],
      );
      return token;
    } catch (error) {
      throw asAuthenticationError(error);
    }
  }

  async rotateRefreshToken(
    refreshToken: string,
    requestId: string = randomUUID(),
    rotatedExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
  ): Promise<{ actor: ActorContext; refreshToken: string }> {
    const pool = this.poolProvider();
    if (!pool?.getConnection) throw new ActorAuthenticationError();

    let connection: TransactionConnection | undefined;
    let committed = false;
    try {
      connection = await pool.getConnection();
      await connection.beginTransaction();

      const tokenHash = createHash('sha256').update(refreshToken).digest('hex');
      const [tokenRows] = await connection.execute(
        `SELECT id, user_id, revoked, expires_at, session_version
         FROM refresh_tokens WHERE token_hash = ? FOR UPDATE`,
        [tokenHash],
      );
      const stored = Array.isArray(tokenRows) ? tokenRows[0] : undefined;
      if (!stored) throw new ActorAuthenticationError();

      if (Boolean(stored.revoked)) {
        await connection.execute(
          'UPDATE refresh_tokens SET revoked = TRUE WHERE user_id = ?',
          [stored.user_id],
        );
        await connection.commit();
        committed = true;
        await securityEventService.record({
          eventType: 'refresh_replay',
          reasonCode: 'REVOKED_REFRESH_TOKEN_REUSED',
          actorId: Number(stored.user_id),
          resourceType: 'user-session',
          resourceId: String(stored.user_id),
          requestId,
        }).catch(() => undefined);
        throw new ActorAuthenticationError();
      }

      if (new Date(stored.expires_at).getTime() <= Date.now()) {
        throw new ActorAuthenticationError();
      }

      const currentActor = await this.loadActorFrom(
        connection,
        Number(stored.user_id),
        Number(stored.session_version),
        requestId,
      );

      const [consumeResult] = await connection.execute(
        'UPDATE refresh_tokens SET revoked = TRUE WHERE id = ? AND revoked = FALSE',
        [stored.id],
      );
      if (Number(consumeResult?.affectedRows) !== 1) throw new ActorAuthenticationError();

      const rotatedToken = randomBytes(48).toString('hex');
      const rotatedHash = createHash('sha256').update(rotatedToken).digest('hex');
      await connection.execute(
        `INSERT INTO refresh_tokens (token_hash, user_id, session_version, expires_at)
         VALUES (?, ?, ?, ?)`,
        [
          rotatedHash,
          currentActor.userId,
          currentActor.sessionVersion,
          rotatedExpiresAt,
        ],
      );
      await connection.commit();
      committed = true;

      return { actor: currentActor, refreshToken: rotatedToken };
    } catch (error) {
      if (connection && !committed) {
        try {
          await connection.rollback();
        } catch {
          // Authentication still fails closed if rollback itself fails.
        }
      }
      throw asAuthenticationError(error);
    } finally {
      connection?.release();
    }
  }

  private async loadActorFrom(
    executor: QueryExecutor,
    userId: number,
    expectedSessionVersion: number | undefined,
    requestId: string,
  ): Promise<ActorContext> {
    if (!Number.isInteger(userId) || userId <= 0) throw new ActorAuthenticationError();

    const [rows] = await executor.execute(ACTOR_SNAPSHOT_SQL, [userId]);
    if (!Array.isArray(rows) || rows.length === 0) throw new ActorAuthenticationError();

    const actorRows = rows as ActorSnapshotRow[];
    const user = actorRows[0];
    const sessionVersion = Number(user.session_version);
    if (user.status !== 'active'
      || !Number.isInteger(sessionVersion)
      || sessionVersion <= 0
      || (expectedSessionVersion !== undefined && sessionVersion !== expectedSessionVersion)) {
      throw new ActorAuthenticationError();
    }

    const roles = new Set<string>();
    const permissions = new Set<string>();
    const instanceScopes: Record<number, InstanceAccessLevel> = {};
    for (const row of actorRows) {
      if (row.role_name) roles.add(row.role_name);
      if (row.permission_code) permissions.add(row.permission_code);
      if (row.instance_id !== null && row.access_level) {
        instanceScopes[Number(row.instance_id)] = row.access_level;
      }
    }
    // The bootstrap admin identity is a super administrator even when an
    // older database has a partially populated role_permissions table.
    if (String(user.username).toLowerCase() === 'admin' || roles.has('admin')) permissions.add('*');

    return Object.freeze({
      userId: Number(user.id),
      username: String(user.username),
      roles: Object.freeze([...roles].sort()),
      permissions: Object.freeze([...permissions].sort()),
      sessionVersion,
      instanceScopes: Object.freeze(instanceScopes),
      requestId,
    });
  }
}

export function signAccessToken(
  actor: ActorContext,
  secret: string,
  expiresIn: jwt.SignOptions['expiresIn'] = '1h',
): string {
  return jwt.sign(
    { userId: actor.userId, sessionVersion: actor.sessionVersion },
    secret,
    { expiresIn },
  );
}

export const actorContextService = new ActorContextService();
