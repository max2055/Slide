import { createHash, randomUUID } from 'node:crypto';
import bcrypt from 'bcrypt';
import mysql, { type Pool, type RowDataPacket } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuthDatabaseService } from '../auth-database-service.js';

const OLD_PASSWORD = 'legacy-password';
const NEW_PASSWORD = 'replaced-password';
const CAS_SQL = 'CAST(password_hash AS BINARY) = ?';

function sha256(password: string): string {
  return createHash('sha256').update(password).digest('hex');
}

type UserRow = {
  id: number;
  username: string;
  password_hash: string;
  status: string;
  session_version: number;
};

type TokenRow = { user_id: number; revoked: number };

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/**
 * 内存库只实现本修复触及的语句。CAS 更新在真正写入前停住，用来固定
 * “bcrypt 算完、写回之前”这个窗口。
 */
function createMemoryAuth() {
  const users: UserRow[] = [];
  const tokens: TokenRow[] = [];
  const casSql: string[] = [];
  const casFinished: Promise<unknown>[] = [];
  let casHold: Promise<void> | null = null;
  const casEntered = deferred();
  let entered = false;

  function holdMigration() {
    const gate = deferred();
    casHold = gate.promise;
    return {
      entered: casEntered.promise,
      release: gate.resolve,
    };
  }

  async function execute(sql: string, params: unknown[] = []) {
    const text = sql.replace(/\s+/g, ' ').trim();
    if (text.startsWith('SELECT id, username, password_hash FROM users WHERE username = ?')) {
      const username = params[0];
      return [users.filter((user) => user.username === username && user.status === 'active').map((user) => ({ ...user }))];
    }
    if (text.includes(CAS_SQL)) {
      casSql.push(text);
      const task = (async () => {
        if (!entered) {
          entered = true;
          casEntered.resolve();
        }
        if (casHold) await casHold;
        const [nextHash, id, expected] = params as [string, number, string];
        const user = users.find((item) => item.id === id);
        const sameBytes = user !== undefined
          && Buffer.from(user.password_hash).equals(Buffer.from(expected));
        if (!user || !sameBytes) return [{ affectedRows: 0 }];
        user.password_hash = nextHash;
        return [{ affectedRows: 1 }];
      })();
      casFinished.push(task);
      return task;
    }
    if (text === 'UPDATE users SET password_hash = ?, session_version = session_version + 1 WHERE id = ?') {
      const [nextHash, id] = params as [string, number];
      const user = users.find((item) => item.id === id);
      if (!user) return [{ affectedRows: 0 }];
      user.password_hash = nextHash;
      user.session_version += 1;
      return [{ affectedRows: 1 }];
    }
    if (text === 'UPDATE refresh_tokens SET revoked = TRUE WHERE user_id = ?') {
      const userId = params[0];
      for (const token of tokens) {
        if (token.user_id === userId) token.revoked = 1;
      }
      return [{ affectedRows: 1 }];
    }
    if (text.startsWith('SELECT id FROM users WHERE username = ?')) {
      const username = params[0];
      return [users.filter((user) => user.username === username).map((user) => ({ id: user.id }))];
    }
    if (text.startsWith('UPDATE users SET ') && text.endsWith('WHERE username = ?')) {
      const username = params[params.length - 1];
      const user = users.find((item) => item.username === username);
      if (!user) return [{ affectedRows: 0 }];
      let index = 0;
      if (text.includes('status = ?')) user.status = String(params[index++]);
      if (text.includes('password_hash = ?')) user.password_hash = String(params[index++]);
      user.session_version += 1;
      return [{ affectedRows: 1 }];
    }
    throw new Error(`unexpected sql: ${text}`);
  }

  const connection = {
    beginTransaction: async () => undefined,
    commit: async () => undefined,
    rollback: async () => undefined,
    release: () => undefined,
    execute,
  };
  const pool = {
    execute,
    getConnection: async () => connection,
  };
  const service = new AuthDatabaseService(() => pool as never);
  return { users, tokens, service, holdMigration, casSql, casFinished };
}

function seed(auth: ReturnType<typeof createMemoryAuth>, passwordHash: string, sessionVersion = 5) {
  auth.users.push({
    id: 41,
    username: 'legacy-user',
    password_hash: passwordHash,
    status: 'active',
    session_version: sessionVersion,
  });
  auth.tokens.push({ user_id: 41, revoked: 0 });
}

async function settle(auth: ReturnType<typeof createMemoryAuth>, count = 1) {
  const deadline = Date.now() + 5000;
  while (auth.casFinished.length < count) {
    if (Date.now() > deadline) {
      throw new Error(`expected ${count} migration attempts, saw ${auth.casFinished.length}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  await Promise.all(auth.casFinished);
}

describe('legacy password migration compare-and-swap (in-memory)', () => {
  it('upgrades an unchanged SHA-256 hash and leaves session_version and refresh tokens alone', async () => {
    const auth = createMemoryAuth();
    seed(auth, sha256(OLD_PASSWORD));

    await expect(auth.service.verifyPassword('legacy-user', OLD_PASSWORD)).resolves.toBe(true);
    await settle(auth);

    const user = auth.users[0];
    expect(user.password_hash.startsWith('$2')).toBe(true);
    expect(await bcrypt.compare(OLD_PASSWORD, user.password_hash)).toBe(true);
    expect(await bcrypt.compare(NEW_PASSWORD, user.password_hash)).toBe(false);
    expect(user.session_version).toBe(5);
    expect(auth.tokens[0].revoked).toBe(0);
    expect(auth.casSql).toHaveLength(1);
    expect(auth.casSql[0]).not.toContain('session_version');

    auth.casFinished.length = 0;
    await expect(auth.service.verifyPassword('legacy-user', OLD_PASSWORD)).resolves.toBe(true);
    expect(auth.casFinished).toHaveLength(0);
    expect(user.session_version).toBe(5);
  });

  it('does not migrate a wrong password or an existing bcrypt hash', async () => {
    const auth = createMemoryAuth();
    seed(auth, sha256(OLD_PASSWORD));
    await expect(auth.service.verifyPassword('legacy-user', 'wrong-password')).resolves.toBe(false);
    expect(auth.casFinished).toHaveLength(0);
    expect(auth.users[0].password_hash).toBe(sha256(OLD_PASSWORD));
    expect(auth.users[0].session_version).toBe(5);

    auth.users[0].password_hash = await bcrypt.hash(OLD_PASSWORD, 4);
    await expect(auth.service.verifyPassword('legacy-user', OLD_PASSWORD)).resolves.toBe(true);
    expect(auth.casFinished).toHaveLength(0);
    expect(auth.users[0].session_version).toBe(5);
  });

  it('keeps a concurrent password change and its session_version', async () => {
    const auth = createMemoryAuth();
    seed(auth, sha256(OLD_PASSWORD));
    const gate = auth.holdMigration();
    const login = auth.service.verifyPassword('legacy-user', OLD_PASSWORD);
    await gate.entered;
    await expect(auth.service.changePassword(41, NEW_PASSWORD)).resolves.toEqual({ success: true });
    gate.release();
    await expect(login).resolves.toBe(true);
    await settle(auth);

    const user = auth.users[0];
    expect(await bcrypt.compare(NEW_PASSWORD, user.password_hash)).toBe(true);
    expect(await bcrypt.compare(OLD_PASSWORD, user.password_hash)).toBe(false);
    expect(user.session_version).toBe(6);
    expect(auth.tokens[0].revoked).toBe(1);
  });

  it('keeps an administrator reset and its session_version', async () => {
    const auth = createMemoryAuth();
    seed(auth, sha256(OLD_PASSWORD));
    const gate = auth.holdMigration();
    const login = auth.service.verifyPassword('legacy-user', OLD_PASSWORD);
    await gate.entered;
    await expect(auth.service.updateUser('legacy-user', { newPassword: NEW_PASSWORD })).resolves.toEqual({ success: true });
    gate.release();
    await expect(login).resolves.toBe(true);
    await settle(auth);

    const user = auth.users[0];
    expect(await bcrypt.compare(NEW_PASSWORD, user.password_hash)).toBe(true);
    expect(await bcrypt.compare(OLD_PASSWORD, user.password_hash)).toBe(false);
    expect(user.session_version).toBe(6);
    expect(auth.tokens[0].revoked).toBe(1);
  });

  it('lets one of two concurrent legacy logins migrate without moving session_version', async () => {
    const auth = createMemoryAuth();
    seed(auth, sha256(OLD_PASSWORD), 2);
    const [first, second] = await Promise.all([
      auth.service.verifyPassword('legacy-user', OLD_PASSWORD),
      auth.service.verifyPassword('legacy-user', OLD_PASSWORD),
    ]);
    expect(first).toBe(true);
    expect(second).toBe(true);
    await settle(auth, 2);

    const user = auth.users[0];
    expect(user.password_hash.startsWith('$2')).toBe(true);
    expect(await bcrypt.compare(OLD_PASSWORD, user.password_hash)).toBe(true);
    expect(user.session_version).toBe(2);
    expect(auth.tokens[0].revoked).toBe(0);
    expect(auth.casSql).toHaveLength(2);
  });

  it('skips migration when the observed hash changes only by letter case', async () => {
    const auth = createMemoryAuth();
    const legacy = sha256(OLD_PASSWORD);
    seed(auth, legacy);
    const gate = auth.holdMigration();
    const login = auth.service.verifyPassword('legacy-user', OLD_PASSWORD);
    await gate.entered;
    auth.users[0].password_hash = legacy.toUpperCase();
    gate.release();
    await expect(login).resolves.toBe(true);
    await settle(auth);

    expect(auth.users[0].password_hash).toBe(legacy.toUpperCase());
    expect(auth.users[0].session_version).toBe(5);
    expect(auth.tokens[0].revoked).toBe(0);
  });
});

const mysqlPort = Number(process.env.MAX304_TEST_MYSQL_PORT);
describe.skipIf(!mysqlPort)('legacy password migration compare-and-swap (real MySQL)', () => {
  const database = `max304_cas_${process.pid}_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const options = {
    host: '127.0.0.1',
    port: mysqlPort,
    user: process.env.MAX304_TEST_MYSQL_USER ?? 'root',
    password: process.env.MAX304_TEST_MYSQL_PASSWORD ?? '',
  };
  let admin: Pool;
  let pool: Pool;

  beforeAll(async () => {
    await provision();
  });

  afterAll(async () => {
    await pool?.end().catch(() => undefined);
    if (!admin) return;
    try {
      await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
    } finally {
      await admin.end();
    }
  });

  async function provision() {
    admin = mysql.createPool(options);
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    pool = mysql.createPool({ ...options, database, connectionLimit: 8 });
    await pool.query(`CREATE TABLE users (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      username VARCHAR(50) NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'active',
      session_version BIGINT UNSIGNED NOT NULL DEFAULT 1
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    await pool.query(`CREATE TABLE refresh_tokens (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      user_id INT UNSIGNED NOT NULL,
      revoked BOOLEAN NOT NULL DEFAULT FALSE
    ) ENGINE=InnoDB`);
  }

  async function readUser(id: number) {
    const [rows] = await pool.execute<RowDataPacket[]>(
      'SELECT password_hash, session_version FROM users WHERE id = ?',
      [id],
    );
    return rows[0] as { password_hash: string; session_version: number };
  }

  async function readRevoked(id: number) {
    const [rows] = await pool.execute<RowDataPacket[]>(
      'SELECT revoked FROM refresh_tokens WHERE user_id = ?',
      [id],
    );
    return Number(rows[0].revoked);
  }

  function pausingPool(real: Pool) {
    const entered = deferred();
    const release = deferred();
    let seen = false;
    const finished: Promise<unknown>[] = [];
    const proxied = {
      execute: async (sql: string, params?: unknown[]) => {
        if (sql.includes(CAS_SQL)) {
          if (!seen) {
            seen = true;
            entered.resolve();
          }
          await release.promise;
          const task = real.execute(sql, params as never);
          finished.push(task);
          return task;
        }
        return real.execute(sql, params as never);
      },
      getConnection: () => real.getConnection(),
    };
    return { pool: proxied, entered: entered.promise, release: release.resolve, finished };
  }

  it('shows a case-insensitive equality would match a different-case hash, then the service CAS does not', async () => {
    const legacy = sha256(OLD_PASSWORD);
    await pool.execute(
      'INSERT INTO users (username, password_hash, session_version) VALUES (?, ?, 5)',
      ['case-probe', legacy.toUpperCase()],
    );
    const [loose] = await pool.execute(
      'UPDATE users SET password_hash = ? WHERE username = ? AND password_hash = ?',
      ['loose-match', 'case-probe', legacy],
    ) as [{ affectedRows: number }, unknown];
    expect(loose.affectedRows).toBe(1);
    await pool.execute('UPDATE users SET password_hash = ? WHERE username = ?', [legacy.toUpperCase(), 'case-probe']);
    const [strict] = await pool.execute(
      'UPDATE users SET password_hash = ? WHERE username = ? AND CAST(password_hash AS BINARY) = ?',
      ['strict-match', 'case-probe', legacy],
    ) as [{ affectedRows: number }, unknown];
    expect(strict.affectedRows).toBe(0);
    expect((await pool.execute<RowDataPacket[]>(
      'SELECT password_hash FROM users WHERE username = ?',
      ['case-probe'],
    ))[0][0].password_hash).toBe(legacy.toUpperCase());
  });

  async function insertLegacy(username: string) {
    const [result] = await pool.execute(
      'INSERT INTO users (username, password_hash, session_version) VALUES (?, ?, 5)',
      [username, sha256(OLD_PASSWORD)],
    ) as [{ insertId: number }, unknown];
    await pool.execute('INSERT INTO refresh_tokens (user_id, revoked) VALUES (?, FALSE)', [result.insertId]);
    return result.insertId;
  }

  it('does not let a concurrent password change or administrator reset roll back the new credential', async () => {
    for (const [username, reset] of [
      ['change-user', 'change'],
      ['reset-user', 'reset'],
    ] as const) {
      const userId = await insertLegacy(username);
      const paused = pausingPool(pool);
      const service = new AuthDatabaseService(() => paused.pool as never);
      const login = service.verifyPassword(username, OLD_PASSWORD);
      await paused.entered;
      if (reset === 'change') {
        await expect(service.changePassword(userId, NEW_PASSWORD)).resolves.toEqual({ success: true });
      } else {
        await expect(service.updateUser(username, { newPassword: NEW_PASSWORD })).resolves.toEqual({ success: true });
      }
      paused.release();
      await expect(login).resolves.toBe(true);
      await Promise.all(paused.finished);
      const user = await readUser(userId);
      expect(await bcrypt.compare(NEW_PASSWORD, user.password_hash)).toBe(true);
      expect(await bcrypt.compare(OLD_PASSWORD, user.password_hash)).toBe(false);
      expect(Number(user.session_version)).toBe(6);
      expect(await readRevoked(userId)).toBe(1);
    }
  });

  it('migrates one unchanged user and keeps session_version across two concurrent logins', async () => {
    const quietId = await insertLegacy('quiet-user');
    const quiet = new AuthDatabaseService(() => pool);
    await expect(quiet.verifyPassword('quiet-user', OLD_PASSWORD)).resolves.toBe(true);
    let quietRow = await readUser(quietId);
    const quietDeadline = Date.now() + 15000;
    while (!quietRow.password_hash.startsWith('$2') && Date.now() < quietDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      quietRow = await readUser(quietId);
    }
    expect(quietRow.password_hash.startsWith('$2')).toBe(true);
    expect(await bcrypt.compare(OLD_PASSWORD, quietRow.password_hash)).toBe(true);
    expect(Number(quietRow.session_version)).toBe(5);
    expect(await readRevoked(quietId)).toBe(0);

    const raceId = await insertLegacy('race-user');
    const racer = new AuthDatabaseService(() => pool);
    const results = await Promise.all([
      racer.verifyPassword('race-user', OLD_PASSWORD),
      racer.verifyPassword('race-user', OLD_PASSWORD),
    ]);
    expect(results).toEqual([true, true]);
    let raceRow = await readUser(raceId);
    const raceDeadline = Date.now() + 15000;
    while (!raceRow.password_hash.startsWith('$2') && Date.now() < raceDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      raceRow = await readUser(raceId);
    }
    expect(raceRow.password_hash.startsWith('$2')).toBe(true);
    expect(await bcrypt.compare(OLD_PASSWORD, raceRow.password_hash)).toBe(true);
    expect(Number(raceRow.session_version)).toBe(5);
    expect(await readRevoked(raceId)).toBe(0);
  });

  it('leaves a case-changed hash in place while a migration is in flight', async () => {
    const userId = await insertLegacy('case-user');
    const paused = pausingPool(pool);
    const service = new AuthDatabaseService(() => paused.pool as never);
    const login = service.verifyPassword('case-user', OLD_PASSWORD);
    await paused.entered;
    const upper = sha256(OLD_PASSWORD).toUpperCase();
    await pool.execute('UPDATE users SET password_hash = ? WHERE id = ?', [upper, userId]);
    paused.release();
    await expect(login).resolves.toBe(true);
    await Promise.all(paused.finished);
    const user = await readUser(userId);
    expect(user.password_hash).toBe(upper);
    expect(Number(user.session_version)).toBe(5);
    expect(await readRevoked(userId)).toBe(0);
  });
});
