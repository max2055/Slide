/**
 * GitHub #456 / MAX-286. Real InnoDB transaction evidence for qualification fixture bootstrap.
 * Uses a disposable MySQL on a random localhost port. Do not point this at a business database.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

const exec = promisify(execFile);
const root = path.resolve(import.meta.dirname, '../..');
const api = path.join(root, 'apps/db-ops-api');
const script = path.join(root, 'scripts/qualification/bootstrap-admin.mjs');
const require = createRequire(path.join(api, 'package.json'));
const mysql = require('mysql2/promise');
const bcrypt = require('bcrypt');

const database = `db_ops_ai_qualification_max286_${process.pid}`;
const container = `slide-max286-${process.pid}`;
const adminPassword = 'qualification-admin-password';
const rcaHost = 'qualification-server-rca.invalid';
const keepHost = 'max286-keep.invalid';
const evidenceDir = process.env.MAX286_EVIDENCE_DIR
  ?? path.join(tmpdir(), `max286-evidence-${process.pid}`);

function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== 'object') return value;
  const copy = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === 'password_hash') copy[key] = item ? `redacted:${String(item).length}` : item;
    else copy[key] = redact(item);
  }
  return copy;
}

async function run(command, args, options = {}) {
  try {
    const result = await exec(command, args, { maxBuffer: 32 * 1024 * 1024, ...options });
    return { code: 0, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  } catch (error) {
    return {
      code: typeof error.code === 'number' ? error.code : 1,
      stdout: error.stdout ?? '',
      stderr: `${error.stderr ?? ''}${error.message ?? ''}`,
    };
  }
}

test('fixture DML rolls back on real MySQL while DDL stays in its own phase', { timeout: 300_000 }, async () => {
  const evidence = {
    issue: 'https://github.com/max2055/Slide/issues/456',
    database,
    container,
    business_databases_used: false,
    cases: [],
  };
  let port = 0;
  let baseEnv;
  const started = await run('docker', [
    'run', '-d', '--name', container, '--memory', '1g',
    '-e', 'MYSQL_ALLOW_EMPTY_PASSWORD=yes',
    '-p', '127.0.0.1::3306', 'mysql:8.4',
    '--innodb-buffer-pool-size=64M', '--performance-schema=OFF', '--max-connections=40',
  ]);
  evidence.docker_start_code = started.code;
  if (started.code !== 0) throw new Error(started.stderr);
  try {
    const mapped = await exec('docker', ['port', container, '3306/tcp']);
    port = Number(String(mapped.stdout).trim().split(':').at(-1));
    evidence.port = port;
    assert.equal(port > 0 && port !== 3306, true);
    const deadline = Date.now() + 90_000;
    let stable = 0;
    while (Date.now() < deadline) {
      const probe = await mysql.createConnection({ host: '127.0.0.1', port, user: 'root', password: '' })
        .then(async (connection) => {
          await connection.query('SELECT 1');
          await connection.end();
          return true;
        })
        .catch(() => false);
      stable = probe ? stable + 1 : 0;
      if (stable >= 3) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (stable < 3) throw new Error('disposable MySQL did not become ready');

    baseEnv = {
      ...process.env,
      DB_HOST: '127.0.0.1',
      DB_PORT: String(port),
      DB_USER: 'root',
      DB_PASSWORD: '',
      DB_NAME: database,
      QUALIFICATION_DB_NAME: database,
      QUALIFICATION_ADMIN_PASSWORD: adminPassword,
    };
    delete baseEnv.QUALIFICATION_BOOTSTRAP_FAIL_AFTER;
    const init = await run(process.execPath, ['--import', 'tsx', 'init-db.ts'], { cwd: api, env: baseEnv, timeout: 180_000 });
    evidence.init_db_code = init.code;
    if (init.code !== 0) throw new Error(init.stderr.slice(-4000));

    const admin = await mysql.createConnection({ host: '127.0.0.1', port, user: 'root', password: '', database });
    const reader = await mysql.createConnection({ host: '127.0.0.1', port, user: 'root', password: '', database });
    try {
      const [session] = await reader.query('SELECT @@autocommit AS autocommit, @@transaction_isolation AS isolation');
      evidence.session = session[0];
      assert.equal(Number(session[0].autocommit), 1);
      const [engines] = await reader.query(
        `SELECT TABLE_NAME AS name, ENGINE AS engine
         FROM information_schema.TABLES
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('servers', 'alerts', 'ai_analysis', 'workflow_jobs', 'users', 'chat_sessions', 'chat_messages')
         ORDER BY TABLE_NAME`,
      );
      evidence.engines = engines;
      assert.equal(engines.every((row) => row.engine === 'InnoDB'), true);

      await reader.query(
        `INSERT INTO servers (host, port, label, os_type, credential_type, credential_encrypted, status, collection_enabled)
         VALUES (?, 22, 'keep', 'linux', 'password', 'not-a-secret', 'online', 0)`,
        [keepHost],
      );

      async function snapshot() {
        const [servers] = await reader.query(
          'SELECT id, host, label FROM servers WHERE host IN (?, ?) ORDER BY host, id',
          [rcaHost, keepHost],
        );
        const [alerts] = await reader.query(
          "SELECT id, server_id, title, status FROM alerts WHERE title = 'Qualification server RCA browser alert' ORDER BY id",
        );
        const [analysis] = await reader.query(
          "SELECT id, server_id, related_id, cache_key, session_key FROM ai_analysis WHERE session_key = 'qualification-server-rca-session' ORDER BY id",
        );
        const [jobs] = await reader.query(
          'SELECT id, state, attempts, idempotency_key, last_error FROM workflow_jobs WHERE id = ?',
          ['00000000-0000-4000-8000-000000000139'],
        );
        const [counterTable] = await reader.query(
          `SELECT TABLE_COMMENT AS table_comment, ENGINE AS engine
           FROM information_schema.TABLES
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'qualification_approval_counter'`,
        );
        const [counter] = await reader.query('SELECT id, value FROM qualification_approval_counter ORDER BY id');
        const [users] = await reader.query(
          "SELECT id, username, password_hash, status FROM users WHERE username IN ('admin', 'admin-missing', 'qualification-viewer', 'user') ORDER BY username",
        );
        const [roles] = await reader.query(
          `SELECT u.username, r.name AS role_name
           FROM user_roles ur JOIN users u ON u.id = ur.user_id JOIN roles r ON r.id = ur.role_id
           WHERE u.username IN ('admin', 'qualification-viewer')
           ORDER BY u.username, r.name`,
        );
        const [chat] = await reader.query(
          "SELECT session_id, user_id, title, message_count FROM chat_sessions WHERE session_id = 'qualification-admin-private-session'",
        );
        const [messages] = await reader.query(
          "SELECT message_id, content FROM chat_messages WHERE message_id = 'qualification-admin-private-message'",
        );
        return { servers, alerts, analysis, jobs, counterTable, counter, users, roles, chat, messages };
      }

      async function bootstrap(failAfterStep) {
        const env = { ...baseEnv };
        if (failAfterStep) env.QUALIFICATION_BOOTSTRAP_FAIL_AFTER = failAfterStep;
        return run(process.execPath, [script], { cwd: api, env });
      }

      await reader.query("UPDATE users SET username = 'admin-missing' WHERE username = 'admin'");
      const missing = await bootstrap();
      const missingState = await snapshot();
      evidence.cases.push({
        name: 'missing-admin',
        code: missing.code,
        stderr_has_rollback: missing.stderr.includes('qualification bootstrap phase=rollback'),
        stderr_has_commit: missing.stderr.includes('qualification bootstrap phase=commit'),
        stderr_has_ddl: missing.stderr.includes('qualification bootstrap phase=ddl'),
        message: missing.stderr.includes('qualification admin seed is missing'),
        state: redact(missingState),
      });
      assert.notEqual(missing.code, 0);
      assert.match(missing.stderr, /qualification admin seed is missing/);
      assert.match(missing.stderr, /phase=ddl/);
      assert.match(missing.stderr, /phase=dml/);
      assert.match(missing.stderr, /phase=rollback/);
      assert.equal(missing.stderr.includes('phase=commit'), false);
      assert.deepEqual(missingState.servers.map((row) => row.host), [keepHost]);
      assert.equal(missingState.alerts.length, 0);
      assert.equal(missingState.analysis.length, 0);
      assert.equal(missingState.jobs.length, 0);
      assert.equal(missingState.counter.length, 0);
      assert.equal(missingState.counterTable[0]?.table_comment, 'Qualification approval execution counter');
      assert.equal(missingState.counterTable[0]?.engine, 'InnoDB');
      assert.equal(missingState.users.some((row) => row.username === 'qualification-viewer'), false);
      assert.equal(missingState.chat.length, 0);

      await reader.query("UPDATE users SET username = 'admin' WHERE username = 'admin-missing'");
      const success = await bootstrap();
      const committed = await snapshot();
      const adminUser = committed.users.find((row) => row.username === 'admin');
      evidence.cases.push({
        name: 'success',
        code: success.code,
        stdout: success.stdout.trim(),
        phases: ['ddl', 'dml', 'commit'].every((phase) => success.stderr.includes(`phase=${phase}`)),
        state: redact(committed),
      });
      assert.equal(success.code, 0);
      assert.match(success.stdout, /qualification admin prepared/);
      assert.match(success.stderr, /phase=commit/);
      assert.equal(success.stderr.includes('phase=rollback'), false);
      assert.equal(await bcrypt.compare(adminPassword, adminUser.password_hash), true);
      assert.equal(committed.servers.filter((row) => row.host === rcaHost).length, 1);
      assert.equal(committed.alerts.length, 1);
      assert.equal(committed.analysis.length, 1);
      assert.equal(Number(committed.alerts[0].server_id), Number(committed.servers.find((row) => row.host === rcaHost).id));
      assert.equal(Number(committed.analysis[0].server_id), Number(committed.alerts[0].server_id));
      assert.equal(Number(committed.analysis[0].related_id), Number(committed.alerts[0].id));
      assert.deepEqual(committed.jobs, [{
        id: '00000000-0000-4000-8000-000000000139',
        state: 'dead_letter',
        attempts: 5,
        idempotency_key: 'qualification:dead-letter:139',
        last_error: 'qualification delivery failure',
      }]);
      assert.deepEqual(committed.counter, [{ id: 1, value: 0 }]);
      assert.equal(committed.messages[0].content, 'private qualification message');
      assert.equal(committed.roles.some((row) => row.username === 'admin' && row.role_name === 'admin'), true);
      assert.equal(committed.roles.some((row) => row.username === 'qualification-viewer' && row.role_name === 'viewer'), true);
      assert.equal(committed.servers.some((row) => row.host === keepHost), true);

      for (const step of ['after-rca', 'before-commit']) {
        const failed = await bootstrap(step);
        const after = await snapshot();
        evidence.cases.push({
          name: `inject-${step}`,
          code: failed.code,
          stderr_has_rollback: failed.stderr.includes('phase=rollback'),
          stderr_has_commit: failed.stderr.includes('phase=commit'),
          unchanged: JSON.stringify(after) === JSON.stringify(committed),
        });
        assert.notEqual(failed.code, 0);
        assert.match(failed.stderr, new RegExp(`qualification bootstrap injected failure after ${step}`));
        assert.match(failed.stderr, /phase=rollback/);
        assert.equal(failed.stderr.includes('phase=commit'), false);
        assert.deepEqual(after, committed);
      }

      const beforeIds = committed.servers.filter((row) => row.host === rcaHost).map((row) => Number(row.id));
      let observed;
      await assert.rejects(
        prepareObserved(),
        /qualification bootstrap injected failure after after-rca/,
      );
      async function prepareObserved() {
        const { prepareQualificationAdmin } = await import(pathToFileURL(script).href);
        return prepareQualificationAdmin(admin, {
          password: adminPassword,
          afterStep: async (step) => {
            if (step !== 'after-rca') return;
            const [trx] = await admin.query(
              'SELECT COUNT(*) AS open_trx FROM information_schema.innodb_trx WHERE trx_mysql_thread_id = CONNECTION_ID()',
            );
            const [same] = await admin.query('SELECT id FROM servers WHERE host = ? ORDER BY id', [rcaHost]);
            const [other] = await reader.query('SELECT id FROM servers WHERE host = ? ORDER BY id', [rcaHost]);
            observed = {
              open_trx: Number(trx[0].open_trx),
              same_connection_ids: same.map((row) => Number(row.id)),
              other_connection_ids: other.map((row) => Number(row.id)),
            };
            throw new Error('qualification bootstrap injected failure after after-rca');
          },
        });
      }
      const afterObserve = await snapshot();
      evidence.cases.push({
        name: 'uncommitted-read',
        observed,
        unchanged: JSON.stringify(afterObserve) === JSON.stringify(committed),
      });
      assert.equal(observed.open_trx, 1);
      assert.deepEqual(observed.other_connection_ids, beforeIds);
      assert.equal(observed.same_connection_ids.length, 1);
      assert.notDeepEqual(observed.same_connection_ids, beforeIds);
      assert.deepEqual(afterObserve, committed);

      const rerun = await bootstrap();
      const rerunState = await snapshot();
      const rerunAdmin = rerunState.users.find((row) => row.username === 'admin');
      evidence.cases.push({
        name: 'rerun-success',
        code: rerun.code,
        rca_servers: rerunState.servers.filter((row) => row.host === rcaHost).length,
        alerts: rerunState.alerts.length,
        analysis: rerunState.analysis.length,
        keep_server_unchanged: rerunState.servers.some((row) => row.host === keepHost && row.id === committed.servers.find((item) => item.host === keepHost).id),
        state: redact(rerunState),
      });
      assert.equal(rerun.code, 0);
      assert.equal(rerunState.servers.filter((row) => row.host === rcaHost).length, 1);
      assert.equal(rerunState.alerts.length, 1);
      assert.equal(rerunState.analysis.length, committed.analysis.length + 1);
      assert.deepEqual(rerunState.analysis.slice(0, committed.analysis.length), committed.analysis);
      assert.equal(Number(rerunState.alerts[0].server_id), Number(rerunState.servers.find((row) => row.host === rcaHost).id));
      assert.equal(rerunState.jobs.length, 1);
      assert.deepEqual(rerunState.counter, [{ id: 1, value: 0 }]);
      assert.equal(rerunState.messages[0].content, 'private qualification message');
      assert.equal(await bcrypt.compare(adminPassword, rerunAdmin.password_hash), true);
      assert.equal(rerunState.servers.find((row) => row.host === keepHost).id, committed.servers.find((row) => row.host === keepHost).id);

      const unknown = await bootstrap('not-a-step');
      const afterUnknown = await snapshot();
      evidence.cases.push({
        name: 'unknown-injection',
        code: unknown.code,
        touched_database: unknown.stderr.includes('phase=ddl'),
        unchanged: JSON.stringify(afterUnknown) === JSON.stringify(rerunState),
      });
      assert.notEqual(unknown.code, 0);
      assert.match(unknown.stderr, /unknown qualification bootstrap failure injection/);
      assert.equal(unknown.stderr.includes('phase=ddl'), false);
      assert.deepEqual(afterUnknown, rerunState);
    } finally {
      await reader.end();
      await admin.end();
    }
  } finally {
    const removed = await run('docker', ['rm', '-f', container]);
    const left = await run('docker', ['ps', '-aq', '--filter', `name=^${container}$`]);
    evidence.cleanup = {
      remove_code: removed.code,
      remaining_container_ids: left.stdout.trim(),
      port,
    };
    await mkdir(evidenceDir, { recursive: true });
    await writeFile(path.join(evidenceDir, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`);
    const lines = [
      '# MAX-286 / GitHub #456 acceptance evidence',
      '',
      `- Disposable container: ${container}`,
      `- Host port: ${port} (not 3306)`,
      `- Database: ${database}`,
      `- Business databases used: no`,
      `- Session autocommit before the script: ${evidence.session?.autocommit ?? 'unknown'}`,
      `- Cleanup remove code: ${removed.code}; remaining containers: ${left.stdout.trim() || 'none'}`,
      '',
      '```json',
      JSON.stringify(evidence, null, 2),
      '```',
      '',
    ];
    await writeFile(path.join(evidenceDir, 'REPORT.md'), lines.join('\n'));
    evidence.evidence_dir = evidenceDir;
  }
});
