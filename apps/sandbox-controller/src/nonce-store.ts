import { createPool, type Pool, type ResultSetHeader } from 'mysql2/promise';
import type { NonceStore } from './request-auth.js';

// Fixed domain: replicas must never select their own namespace for the same secret.
const domain = 'sandbox-controller';
const databaseNow = 'CAST(UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3)) * 1000 AS SIGNED)';

export class MySqlNonceStore implements NonceStore {
  constructor(private readonly pool: Pool) {}

  static fromEnvironment(): MySqlNonceStore {
    for (const key of ['SANDBOX_NONCE_DB_HOST', 'SANDBOX_NONCE_DB_USER', 'SANDBOX_NONCE_DB_PASSWORD', 'SANDBOX_NONCE_DB_NAME']) {
      if (!process.env[key]) throw new Error(`${key} is required`);
    }
    return new MySqlNonceStore(createPool({
      host: process.env.SANDBOX_NONCE_DB_HOST,
      port: Number(process.env.SANDBOX_NONCE_DB_PORT || 3306),
      user: process.env.SANDBOX_NONCE_DB_USER,
      password: process.env.SANDBOX_NONCE_DB_PASSWORD,
      database: process.env.SANDBOX_NONCE_DB_NAME,
      connectionLimit: 4,
      waitForConnections: false,
      connectTimeout: 3000,
    }));
  }

  async claim(nonce: string, timestamp: number): Promise<boolean> {
    try {
      // Autocommit acknowledgement precedes execution. An uncertain result is never retried.
      const [result] = await this.pool.query<ResultSetHeader>({
        sql: `INSERT INTO sandbox_request_nonces (auth_domain, nonce, expires_at_ms)
          SELECT ?, ?, GREATEST(? + 30000, ${databaseNow} + 60000)
          WHERE ABS(${databaseNow} - ?) <= 30000`,
        values: [domain, nonce, timestamp, timestamp],
        timeout: 3000,
      });
      return result.affectedRows === 1;
    } catch (error) {
      if ((error as { code?: string }).code === 'ER_DUP_ENTRY') return false;
      throw error;
    }
  }

  async cleanup(): Promise<void> {
    await this.pool.query({
      sql: `DELETE FROM sandbox_request_nonces WHERE auth_domain = ? AND expires_at_ms < ${databaseNow} LIMIT 1000`,
      values: [domain], timeout: 3000,
    });
  }

  async close(): Promise<void> { await this.pool.end(); }
}
