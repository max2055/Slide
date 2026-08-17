import { randomUUID } from 'node:crypto';
import { dbConnection, decryptData, encryptData } from '../db-connection.js';

interface CredentialExecutor {
  execute(sql: string, values?: unknown[]): Promise<[any, unknown?]>;
}

export class CredentialReferenceService {
  constructor(
    private readonly executorProvider: () => CredentialExecutor | null = () => dbConnection.getPool() as CredentialExecutor | null,
    private readonly decrypt: (value: string) => string = decryptData,
    private readonly encrypt: (value: string) => string = encryptData,
  ) {}

  async create(ownerId: number, toolName: string, secret: string, expiresInMs = 30 * 60_000): Promise<{ ref: string; expiresAt: Date }> {
    if (!Number.isSafeInteger(ownerId) || ownerId <= 0 || !toolName || !secret || secret.length > 16_384) {
      throw new Error('CREDENTIAL_REFERENCE_INPUT_INVALID');
    }
    const ref = randomUUID();
    const expiresAt = new Date(Date.now() + Math.min(Math.max(expiresInMs, 60_000), 60 * 60_000));
    const [result] = await this.executor().execute(
      `INSERT INTO agent_credential_references
       (ref_id, owner_id, tool_name, secret_encrypted, status, expires_at)
       VALUES (?, ?, ?, ?, 'active', ?)`,
      [ref, ownerId, toolName, this.encrypt(secret), expiresAt],
    );
    if (Number(result?.affectedRows) !== 1) throw new Error('CREDENTIAL_REFERENCE_CREATE_FAILED');
    return { ref, expiresAt };
  }

  async consume(ref: string, ownerId: number, toolName: string): Promise<string | null> {
    if (!ref || ref.length > 128 || !Number.isSafeInteger(ownerId) || ownerId <= 0 || !toolName) return null;
    const executor = this.executor();
    const [rows] = await executor.execute(
      `SELECT secret_encrypted FROM agent_credential_references
       WHERE ref_id = ? AND owner_id = ? AND tool_name = ?
         AND status = 'active' AND expires_at > NOW() LIMIT 1`,
      [ref, ownerId, toolName],
    );
    const row = Array.isArray(rows) ? rows[0] : undefined;
    if (!row?.secret_encrypted) return null;
    const [claim] = await executor.execute(
      `UPDATE agent_credential_references SET status = 'consumed', consumed_at = NOW()
       WHERE ref_id = ? AND owner_id = ? AND tool_name = ?
         AND status = 'active' AND expires_at > NOW()`,
      [ref, ownerId, toolName],
    );
    if (Number(claim?.affectedRows) !== 1) return null;
    return this.decrypt(String(row.secret_encrypted));
  }

  private executor(): CredentialExecutor {
    const executor = this.executorProvider();
    if (!executor) throw new Error('CREDENTIAL_REFERENCE_STORE_UNAVAILABLE');
    return executor;
  }
}

export const credentialReferenceService = new CredentialReferenceService();
