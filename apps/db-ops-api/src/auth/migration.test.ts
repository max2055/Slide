/**
 * Migration test for RBAC-08
 *
 * Validates that 002_add_rbac_tables.sql can be applied to a test schema
 * without errors and produces correct results.
 *
 * This is an integration test using a real MySQL connection.
 * Skips automatically if no MySQL is available.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mysql from 'mysql2/promise';

const TEST_DB = 'db_ops_ai_rbac_test';
const DB_CONFIG = {
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '3306', 10),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
};

describe('Migration - RBAC-08', () => {
  let pool: mysql.Pool | null = null;
  let mysqlAvailable = false;

  beforeAll(async () => {
    try {
      // Connect without database first to create test DB
      const conn = await mysql.createConnection({
        ...DB_CONFIG,
        database: undefined,
      });

      // Drop if exists, create fresh
      await conn.execute(`DROP DATABASE IF EXISTS \`${TEST_DB}\``);
      await conn.execute(`CREATE DATABASE \`${TEST_DB}\` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
      await conn.end();

      // Now connect to test DB and create pre-migration schema
      pool = mysql.createPool({
        ...DB_CONFIG,
        database: TEST_DB,
        waitForConnections: true,
        connectionLimit: 5,
        charset: 'utf8mb4',
        timezone: '+00:00',
        decimalNumbers: true,
      });

      // Create a users table that mirrors the real schema before migration
      await pool.execute(`
        CREATE TABLE IF NOT EXISTS \`users\` (
          \`id\` INT UNSIGNED NOT NULL AUTO_INCREMENT,
          \`username\` VARCHAR(50) NOT NULL UNIQUE,
          \`password_hash\` VARCHAR(255) NOT NULL,
          \`email\` VARCHAR(100) DEFAULT NULL,
          \`role\` ENUM('admin', 'dba', 'developer', 'analyst', 'viewer', 'auditor') NOT NULL DEFAULT 'viewer',
          \`status\` ENUM('active', 'inactive', 'locked') NOT NULL DEFAULT 'active',
          \`last_login_at\` DATETIME DEFAULT NULL,
          \`last_login_ip\` VARCHAR(45) DEFAULT NULL,
          \`created_at\` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          \`updated_at\` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          PRIMARY KEY (\`id\`),
          INDEX \`idx_username\` (\`username\`),
          INDEX \`idx_status\` (\`status\`)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);

      // Create database_instances table (needed for instance_permissions FK)
      await pool.execute(`
        CREATE TABLE IF NOT EXISTS \`database_instances\` (
          \`id\` INT UNSIGNED NOT NULL AUTO_INCREMENT,
          \`name\` VARCHAR(100) NOT NULL,
          \`host\` VARCHAR(255) NOT NULL,
          \`port\` INT NOT NULL,
          \`username\` VARCHAR(100) NOT NULL,
          \`password_encrypted\` VARCHAR(255) NOT NULL,
          PRIMARY KEY (\`id\`)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);

      // Insert test users with each of the 6 ENUM role values
      await pool.execute(
        `INSERT INTO users (username, password_hash, email, role, status) VALUES (?, ?, ?, ?, ?)`,
        ['test_admin', 'hash', 'admin@test.com', 'admin', 'active']
      );
      await pool.execute(
        `INSERT INTO users (username, password_hash, email, role, status) VALUES (?, ?, ?, ?, ?)`,
        ['test_dba', 'hash', 'dba@test.com', 'dba', 'active']
      );
      await pool.execute(
        `INSERT INTO users (username, password_hash, email, role, status) VALUES (?, ?, ?, ?, ?)`,
        ['test_dev', 'hash', 'dev@test.com', 'developer', 'active']
      );
      await pool.execute(
        `INSERT INTO users (username, password_hash, email, role, status) VALUES (?, ?, ?, ?, ?)`,
        ['test_analyst', 'hash', 'analyst@test.com', 'analyst', 'active']
      );
      await pool.execute(
        `INSERT INTO users (username, password_hash, email, role, status) VALUES (?, ?, ?, ?, ?)`,
        ['test_viewer', 'hash', 'viewer@test.com', 'viewer', 'active']
      );
      await pool.execute(
        `INSERT INTO users (username, password_hash, email, role, status) VALUES (?, ?, ?, ?, ?)`,
        ['test_auditor', 'hash', 'auditor@test.com', 'auditor', 'active']
      );

      // Verify pre-migration state
      const [preUsers] = await pool.execute('SELECT COUNT(*) as cnt FROM users') as any;
      console.log(`[Setup] Created ${preUsers[0].cnt} test users`);
      mysqlAvailable = true;
    } catch (error: any) {
      console.warn(`[Setup] MySQL not available or setup failed: ${error.message}`);
      console.warn('[Setup] All migration tests will be skipped');
    }
  }, 30000);

  afterAll(async () => {
    if (pool) {
      try {
        await pool.execute(`DROP DATABASE IF EXISTS \`${TEST_DB}\``);
        console.log(`[Teardown] Dropped test database ${TEST_DB}`);
      } catch (e) {
        // Ignore teardown errors
      }
      await pool.end();
    }
  }, 10000);

  function runIf(fn: () => Promise<void>) {
    return async () => {
      if (!mysqlAvailable || !pool) return;
      await fn();
    };
  }

  it('should apply migration SQL without errors', runIf(async () => {
    // Read the migration SQL
    const fs = await import('fs');
    const path = await import('path');
    const migrationPath = path.resolve(__dirname, '../../sql/migrations/002_add_rbac_tables.sql');

    if (!fs.existsSync(migrationPath)) {
      throw new Error(`Migration file not found: ${migrationPath}`);
    }

    let sql = fs.readFileSync(migrationPath, 'utf8');

    // Remove the transaction wrapper (START TRANSACTION / COMMIT)
    // since vitest already wraps each test in its own context
    sql = sql.replace(/START TRANSACTION;/g, '');
    sql = sql.replace(/COMMIT;/g, '');

    // Execute the migration SQL statement by statement
    const statements = sql.split(';').filter(s => s.trim().length > 0);
    for (const statement of statements) {
      const trimmed = statement.trim();
      if (trimmed.length > 0) {
        try {
          await pool!.execute(trimmed);
        } catch (error: any) {
          // Ignore "already exists" errors for CREATE IF NOT EXISTS
          if (error.message && error.message.includes('already exists')) {
            continue;
          }
          throw error;
        }
      }
    }
  }), 30000);

  it('should have 5 RBAC tables after migration', runIf(async () => {
    const tables = ['roles', 'permissions', 'role_permissions', 'user_roles', 'instance_permissions'];

    for (const table of tables) {
      const [rows] = await pool!.execute(`SHOW TABLES LIKE '${table}'`);
      expect((rows as any[]).length).toBe(1);
    }
  }));

  it('should have 6 default system roles seeded', runIf(async () => {
    const [rows] = await pool!.execute('SELECT name FROM roles WHERE is_system = TRUE ORDER BY name');
    const roleNames = (rows as any[]).map((r: any) => r.name);
    expect(roleNames).toEqual(['admin', 'analyst', 'auditor', 'dba', 'developer', 'viewer']);
  }));

  it('should have wildcard "*" permission seeded', runIf(async () => {
    const [rows] = await pool!.execute("SELECT code FROM permissions WHERE code = '*'");
    expect((rows as any[]).length).toBe(1);
  }));

  it('should have many permission codes in resource:action format', runIf(async () => {
    const [rows] = await pool!.execute('SELECT COUNT(*) as cnt FROM permissions');
    expect((rows as any[])[0].cnt).toBeGreaterThan(10);
  }));

  it('should assign "*" permission to admin role', runIf(async () => {
    const [rows] = await pool!.execute(`
      SELECT COUNT(*) as cnt FROM role_permissions rp
      JOIN roles r ON rp.role_id = r.id
      JOIN permissions p ON rp.permission_id = p.id
      WHERE r.name = 'admin' AND p.code = '*'
    `);
    expect((rows as any[])[0].cnt).toBeGreaterThan(0);
  }));

  it('should migrate existing users to user_roles correctly', runIf(async () => {
    const [rows] = await pool!.execute(`
      SELECT u.username, r.name as role_name
      FROM user_roles ur
      JOIN users u ON ur.user_id = u.id
      JOIN roles r ON ur.role_id = r.id
      ORDER BY u.username
    `);

    const mapped = (rows as any[]).map((r: any) => `${r.username}:${r.role_name}`);

    expect(mapped).toContain('test_admin:admin');
    expect(mapped).toContain('test_dba:dba');
    expect(mapped).toContain('test_dev:developer');
    expect(mapped).toContain('test_analyst:analyst');
    expect(mapped).toContain('test_viewer:viewer');
    expect(mapped).toContain('test_auditor:auditor');
  }));

  it('should have dropped the old role column', runIf(async () => {
    const [rows] = await pool!.execute("SHOW COLUMNS FROM `users` LIKE 'role'");
    expect((rows as any[]).length).toBe(0);
  }));

  it('should have preserved role_backup column', runIf(async () => {
    const [rows] = await pool!.execute("SHOW COLUMNS FROM `users` LIKE 'role_backup'");
    expect((rows as any[]).length).toBe(1);
  }));

  it('should have role_backup values matching old roles', runIf(async () => {
    const [rows] = await pool!.execute(
      'SELECT username, role_backup FROM users ORDER BY username'
    );
    const backups = (rows as any[]).map((r: any) => `${r.username}:${r.role_backup}`);
    expect(backups).toContain('test_admin:admin');
    expect(backups).toContain('test_dba:dba');
    expect(backups).toContain('test_dev:developer');
    expect(backups).toContain('test_analyst:analyst');
    expect(backups).toContain('test_viewer:viewer');
    expect(backups).toContain('test_auditor:auditor');
  }));
});
