import { createHash, randomBytes, randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { dbConnection } from '../db-connection.js';

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
          new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
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
