import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { isAbsolute, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { MigrationConnection } from './types.js';

const reconciliationRequired = 'LEGACY_DEVELOPMENT_ACCOUNTS_RECONCILIATION_REQUIRED';
const accountIdSchema = z.number().int().positive().max(0xffffffff);
const baselineAccountIdsSchema = z.array(accountIdSchema);
const originsSchema = z.strictObject({
  serverUuid: z.string().uuid(),
  schema: z.string().min(1),
  baselineChecksum: z.string().regex(/^[a-f0-9]{64}$/),
  accounts: z.array(z.strictObject({
    id: accountIdSchema,
    source: z.enum(['development-seed', 'existing-account']),
  })).max(1024),
});

async function readLegacyOrigins(file: string | undefined) {
  try {
    if (!file || !isAbsolute(file) || !process.getuid) throw new Error();
    const root = await realpath(fileURLToPath(new URL('../../../../', import.meta.url)));
    const resolved = await realpath(file);
    if (!relative(root, resolved).startsWith(`..${sep}`)) throw new Error();
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0 || stat.size > 128 * 1024) throw new Error();
      return originsSchema.parse(JSON.parse(await handle.readFile('utf8')));
    } finally {
      await handle.close();
    }
  } catch {
    throw new Error(reconciliationRequired);
  }
}

export async function insertDevelopmentAccountSeeds(connection: MigrationConnection, statement: string): Promise<void> {
  await connection.query(`CREATE TABLE IF NOT EXISTS development_account_seeds (
    user_id INT UNSIGNED NOT NULL PRIMARY KEY COMMENT 'ID assigned to a user inserted by the development baseline seed',
    CONSTRAINT fk_development_account_seed_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  ) ENGINE=InnoDB COMMENT='Origin records for development baseline account fixtures'`);
  await connection.query('START TRANSACTION');
  try {
    await connection.query(statement);
    const [recorded] = await connection.query<{ affectedRows: number }>(
      "INSERT INTO development_account_seeds (user_id) SELECT id FROM users WHERE username IN ('admin','user')",
    );
    if (recorded.affectedRows !== 2) throw new Error('Development account seed provenance incomplete');
    await connection.query('COMMIT');
  } catch (error) {
    await connection.query('ROLLBACK');
    throw error;
  }
}

/** DDL implicitly commits in MySQL. Prepare storage before the bootstrap transaction. */
export async function prepareBaselineAccountScope(connection: MigrationConnection): Promise<string | undefined> {
  const [[baseline]] = await connection.query<Array<{ checksum: string }>>(
    "SELECT checksum FROM app_schema_migrations WHERE migration_id='000_schema_baseline.sql' AND status='baselined'",
  );
  if (!baseline) return;
  await connection.query(`CREATE TABLE IF NOT EXISTS baseline_account_reconciliation (
    baseline_checksum CHAR(64) NOT NULL PRIMARY KEY COMMENT 'Checksum of the adopted schema baseline',
    account_ids JSON NOT NULL COMMENT 'Historical account IDs captured at first successful production reconciliation'
  ) ENGINE=InnoDB COMMENT='Persistent account scope for explicit baseline takeover'`);
  return baseline.checksum;
}

export async function disableDevelopmentAccountSeeds(
  connection: MigrationConnection,
  env: NodeJS.ProcessEnv,
  legacyChecksums: readonly string[],
  baselineChecksum?: string,
): Promise<void> {
  const [tables] = await connection.query<Array<{ present: number }>>(
    "SELECT 1 AS present FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='development_account_seeds'",
  );
  if (tables.length) {
    await connection.query(`UPDATE users AS account
      JOIN development_account_seeds AS seed ON seed.user_id=account.id
      SET account.status='inactive', account.session_version=account.session_version+1
      WHERE account.status <> 'inactive'`);
  }
  let historicalIds: number[] | undefined;
  if (baselineChecksum) {
    const [scopes] = await connection.query<Array<{ account_ids: unknown; baseline_checksum: string }>>(
      'SELECT baseline_checksum, account_ids FROM baseline_account_reconciliation FOR UPDATE',
    );
    const [scope] = scopes;
    if (scope) {
      const parsed = baselineAccountIdsSchema.safeParse(scope.account_ids);
      if (scopes.length !== 1 || scope.baseline_checksum !== baselineChecksum || !parsed.success) throw new Error(reconciliationRequired);
      historicalIds = parsed.data;
      if (!historicalIds.length) return;
    }
  }
  const [cohort] = await connection.query<Array<{ id: number; status: string; checksum: string }>>(
    `SELECT account.id, account.status, baseline.checksum
     FROM app_schema_migrations AS baseline JOIN users AS account ON (
       (baseline.status='completed' AND baseline.checksum IN (?)
         AND account.created_at BETWEEN baseline.started_at AND baseline.finished_at)
       OR baseline.status='baselined'
     )
     ${tables.length ? 'LEFT JOIN development_account_seeds AS seed ON seed.user_id=account.id' : ''}
     WHERE baseline.migration_id='000_schema_baseline.sql' ${tables.length ? 'AND seed.user_id IS NULL' : ''}
     ${historicalIds ? 'AND account.id IN (?)' : ''}
     FOR UPDATE`,
    historicalIds ? [legacyChecksums, historicalIds] : [legacyChecksums],
  );
  const firstReconciliation = baselineChecksum !== undefined && historicalIds === undefined;
  const eligibleIds = new Set(historicalIds ?? cohort.map(account => account.id));
  if (cohort.some(account => firstReconciliation || account.status !== 'inactive')) {
    const origins = await readLegacyOrigins(env.SLIDE_LEGACY_ACCOUNT_ORIGINS_FILE);
    const [[target]] = await connection.query<Array<{ serverUuid: string; schemaName: string }>>(
      'SELECT @@server_uuid AS serverUuid, DATABASE() AS schemaName',
    );
    const decisions = new Map(origins.accounts.map(account => [account.id, account.source]));
    if (origins.serverUuid !== target?.serverUuid || origins.schema !== target?.schemaName
      || origins.baselineChecksum !== cohort[0]?.checksum || decisions.size !== origins.accounts.length
      || origins.accounts.some(account => !eligibleIds.has(account.id))
      || cohort.some(account => (firstReconciliation || account.status !== 'inactive') && !decisions.has(account.id))) {
      throw new Error(reconciliationRequired);
    }
    const seedIds = origins.accounts.filter(account => account.source === 'development-seed').map(account => account.id);
    if (seedIds.length) {
      await connection.query(
        "UPDATE users SET status='inactive', session_version=session_version+1 WHERE status <> 'inactive' AND id IN (?)",
        [seedIds],
      );
    }
  }

  if (firstReconciliation) {
    await connection.query(
      'INSERT INTO baseline_account_reconciliation (baseline_checksum, account_ids) VALUES (?, ?)',
      [baselineChecksum, JSON.stringify([...eligibleIds])],
    );
  }
}
