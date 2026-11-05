import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { requireEncryptionKey } from '../src/config/security-config.js';
import { LOST_KEY_ROTATION_SENTINEL } from '../src/credential-rotation.js';

const script = resolve(import.meta.dirname, '../../../scripts/recovery/rotate-lost-encryption-key.ts');
const require = createRequire(import.meta.url);

// Execute the actual CLI orchestration with simulated I/O; real schema and
// rollback coverage lives in rotate-lost-encryption-key.max316.mysql.test.ts.
async function runRotation(backupExists: boolean, failure?: { at: string; error: object }) {
  const db = {
    query: vi.fn(async (sql: string) => {
      if (failure?.at === 'metadata' && sql.includes('information_schema')) throw failure.error;
      return [sql.includes('information_schema') && backupExists ? [{ TABLE_NAME: 'llm_providers_backup' }] : [], []];
    }),
    execute: vi.fn(async (sql: string) => {
      if (failure && sql.includes(failure.at)) throw failure.error;
      if (!backupExists && sql.includes('UPDATE llm_providers_backup')) throw { code: 'ER_NO_SUCH_TABLE' };
      return [{ affectedRows: 1 }, []];
    }),
    beginTransaction: vi.fn(), commit: vi.fn(), rollback: vi.fn(), end: vi.fn(),
  };
  const dependencies: Record<string, object> = {
    '../../apps/db-ops-api/src/config/security-config.js': { requireEncryptionKey },
    '../../apps/db-ops-api/src/credential-rotation.js': { LOST_KEY_ROTATION_SENTINEL },
    'node:fs/promises': { readFile: async () => '', mkdir: async () => {}, writeFile: async () => {} },
    '../../apps/db-ops-api/src/db-connection.js': { encryptData: () => 'synthetic-marker' },
    '../../apps/db-ops-api/node_modules/mysql2/promise.js': { createConnection: async () => db },
  };
  const source = readFileSync(script, 'utf8')
    .replaceAll('import.meta.dirname', JSON.stringify(resolve(script, '..')))
    .replaceAll('import.meta.url', JSON.stringify(`file://${script}`));
  const code = ts.transpileModule(`${source}\nglobalThis.result = main();`, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const sandbox = {
    require: (id: string) => dependencies[id] ?? require(id.startsWith('.') ? resolve(script, '..', id) : id),
    exports: {}, console: { log: vi.fn(), error: vi.fn() },
    process: { argv: ['node'], env: {
      ENCRYPTION_KEY: 'a'.repeat(32), SLIDE_ROTATE_LOST_ENCRYPTION_KEY: 'CONFIRM_LOST_KEY_ROTATION',
      HOME: '/synthetic',
    } },
    result: undefined as Promise<void> | undefined,
  };
  runInNewContext(code, sandbox);
  let error: unknown;
  try { await sandbox.result; } catch (caught) { error = caught; }
  return { db, error };
}

describe('GitHub #463 / MAX-316 optional historical provider backup', () => {
  it.each([false, true])('commits core recovery with backup exists=%s', async (exists) => {
    const { db, error } = await runRotation(exists);
    expect(error).toBeUndefined();
    expect(db.execute.mock.calls.some(([sql]) => sql.includes('UPDATE llm_providers_backup'))).toBe(exists);
    expect(db.execute.mock.calls.some(([sql]) => sql.includes("status = 'revoked'"))).toBe(true);
    expect(db.commit).toHaveBeenCalledOnce();
    expect(db.rollback).not.toHaveBeenCalled();
    expect(db.end).toHaveBeenCalledOnce();
  });

  it.each(['ER_BAD_FIELD_ERROR', 'ER_TABLEACCESS_DENIED_ERROR', 'ER_PARSE_ERROR', 'ER_NO_SUCH_TABLE', 'UNKNOWN'])('rolls back backup update errors: %s', async (code) => {
    // ER_NO_SUCH_TABLE can also originate inside a trigger on an existing
    // backup table. It must not be treated as permission to skip the update.
    const failure = { code };
    const { db, error } = await runRotation(true, { at: 'UPDATE llm_providers_backup', error: failure });
    expect(error).toBe(failure);
    expect(db.rollback).toHaveBeenCalledOnce();
    expect(db.commit).not.toHaveBeenCalled();
    expect(db.end).toHaveBeenCalledOnce();
  });

  it.each(['metadata', 'UPDATE notification_channels', 'UPDATE network_devices'])('rolls back other SQL failures at %s', async (at) => {
    const failure = { code: 'ER_TABLEACCESS_DENIED_ERROR' };
    const { db, error } = await runRotation(false, { at, error: failure });
    expect(error).toBe(failure);
    expect(db.rollback).toHaveBeenCalledOnce();
    expect(db.commit).not.toHaveBeenCalled();
    expect(db.end).toHaveBeenCalledOnce();
  });
});
