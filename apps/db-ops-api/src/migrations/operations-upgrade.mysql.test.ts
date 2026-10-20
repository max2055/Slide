/** Real incremental upgrade from 127; synthetic retained V1/Chat/SQL records. */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import mysql from 'mysql2/promise';
import { describe, it, expect } from 'vitest';
import { MigrationRunner } from './runner.js';
const port = Number(process.env.OPERATIONS_TEST_MYSQL_PORT ?? process.env.AGENT_RUN_TEST_MYSQL_PORT ?? 0);
describe.skipIf(!port)('P10 additive upgrade and retained rollback', () => {
  it('upgrades a 127 ledger, reruns, preserves old rows and makes no role grants', async () => {
    const database = `p10_upgrade_${randomUUID().replaceAll('-', '')}`;
    const config = { host: '127.0.0.1', port, user: 'root', password: process.env.OPERATIONS_TEST_MYSQL_PASSWORD ?? process.env.AGENT_RUN_TEST_MYSQL_PASSWORD ?? '', timezone: 'Z' };
    const admin = mysql.createPool(config), directory = await mkdtemp(join(tmpdir(), 'slide-p10-migrations-'));
    let pool: mysql.Pool | undefined, restored: mysql.Pool | undefined;
    const restoreDatabase = `${database}_restore`; let restoreCreated = false;
    try {
      await admin.query(`CREATE DATABASE ${database}`);
      pool = mysql.createPool({ ...config, database });
      const source = new URL('../../sql/migrations/', import.meta.url);
      for (const file of await readdir(source)) if (/^\d+_.+\.sql$/.test(file) && file < '128_') await copyFile(new URL(file, source), join(directory, file));
      await new MigrationRunner(pool, directory).run();
      await pool.query("INSERT INTO users(id,username,password_hash) VALUES(901,'p10-retained','no-login')");
      await pool.query("INSERT INTO chat_sessions(session_id,user_id,title) VALUES('p10-retained',901,'synthetic retained chat')");
      await pool.query("INSERT INTO operations(id,actor_id,origin,resource_type,resource_id,command_type,risk,idempotency_key,correlation_id,state) VALUES('p10-old',901,'chat','server','901','read','low','old','old','outcome_unknown')");
      const runner = new MigrationRunner(pool); await runner.run(); await runner.run();
      const [operations] = await pool.query<any[]>("SELECT state,attempt FROM operations WHERE id='p10-old'");
      expect(operations).toEqual([{ state: 'outcome_unknown', attempt: 1 }]);
      expect((await pool.query<any[]>("SELECT title FROM chat_sessions WHERE session_id='p10-retained'"))[0][0].title).toBe('synthetic retained chat');
      const [grants] = await pool.query<any[]>("SELECT COUNT(*) n FROM role_permissions rp JOIN permissions p ON p.id=rp.permission_id WHERE p.code LIKE 'operations:%'");
      expect(grants[0].n).toBe(0);
      // Rollback is old executable + flags off, never reverse DDL. The previous
      // runner accepts a newer ledger and leaves new evidence tables untouched.
      await new MigrationRunner(pool, directory).run();
      const [tables] = await pool.query<any[]>("SHOW TABLES LIKE 'action_executions'"); expect(tables).toHaveLength(1);
      const [dependencies] = await pool.query<any[]>("SHOW TABLES LIKE 'investigation_case_dependencies'"); expect(dependencies).toHaveLength(1);
      const [unknown] = await pool.query<any[]>("SELECT state FROM operations WHERE id='p10-old'"); expect(unknown[0].state).toBe('outcome_unknown');
      const container = process.env.OPERATIONS_TEST_MYSQL_CONTAINER;
      if (container) {
        if (!/^slide-(t12-|max203-)[a-zA-Z0-9-]+$/.test(container)) throw new Error('UNSAFE_TEST_CONTAINER');
        // Restore the real logical backup into a NEW dedicated schema; never
        // reverse-migrate or drop evidence to simulate recovery.
        const dump = execFileSync('docker', ['exec', container, 'mysqldump', '-uroot', '--no-tablespaces', '--single-transaction', '--set-gtid-purged=OFF', database], { maxBuffer: 32 * 1024 * 1024 });
        await admin.query(`CREATE DATABASE ${restoreDatabase}`); restoreCreated = true;
        execFileSync('docker', ['exec', '-i', container, 'mysql', '-uroot', restoreDatabase], { input: dump, maxBuffer: 1024 * 1024 });
        restored = mysql.createPool({ ...config, database: restoreDatabase });
        await new MigrationRunner(restored).run();
        const [recovered] = await restored.query<any[]>("SELECT state,attempt FROM operations WHERE id='p10-old'");
        expect(recovered).toEqual(operations);
        const [recoveredChat] = await restored.query<any[]>("SELECT title FROM chat_sessions WHERE session_id='p10-retained'");
        expect(recoveredChat[0].title).toBe('synthetic retained chat');
        const [ledger] = await restored.query<any[]>("SELECT migration_id,status,checksum FROM app_schema_migrations ORDER BY migration_id");
        expect(ledger).toEqual((await pool.query<any[]>('SELECT migration_id,status,checksum FROM app_schema_migrations ORDER BY migration_id'))[0]);
      }

    } finally { await restored?.end(); if (restoreCreated) await admin.query(`DROP DATABASE ${restoreDatabase}`); await pool?.end(); await admin.query(`DROP DATABASE ${database}`); await admin.end(); await rm(directory, { recursive: true, force: true }); }
  }, 90_000);
});
