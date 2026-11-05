/**
 * GitHub #725 / MAX-303. Controlled env and an initialize probe only.
 * This file does not open a MySQL connection.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import test from 'node:test';
import { promisify } from 'node:util';
import {
  ISOLATED_EVIDENCE_HOST,
  ISOLATED_EVIDENCE_PORT,
  openIsolatedEvidenceDatabase,
} from './evidence-persistence.ts';

const exec = promisify(execFile);

assert.equal(ISOLATED_EVIDENCE_HOST, '127.0.0.1');
assert.equal(ISOLATED_EVIDENCE_PORT, '13306');
assert.notEqual(ISOLATED_EVIDENCE_PORT, '3306');

const legal = {
  DB_HOST: '127.0.0.1',
  DB_PORT: '13306',
  DB_NAME: 'slide_evidence_test_v1',
};

async function expectRefusal(env: NodeJS.ProcessEnv): Promise<void> {
  let calls = 0;
  const initialize = async () => {
    calls += 1;
    throw new Error('INITIALIZE_MUST_NOT_RUN');
  };
  await assert.rejects(
    () => openIsolatedEvidenceDatabase(env, initialize),
    /ISOLATED_EVIDENCE_DATABASE_REQUIRED/,
  );
  assert.equal(calls, 0);
}

test('missing port is refused before initialize', async () => {
  const { DB_PORT: _port, ...env } = legal;
  await expectRefusal(env);
});

test('a port other than the isolated port is refused before initialize', async () => {
  await expectRefusal({ ...legal, DB_PORT: '13307' });
});

test('a matching database name on the shared default port is refused before initialize', async () => {
  await expectRefusal({ ...legal, DB_PORT: '3306' });
});

test('a missing host is refused before initialize', async () => {
  const { DB_HOST: _host, ...env } = legal;
  await expectRefusal(env);
});

test('blank, padded, and parsed-prefix ports are refused before initialize', async () => {
  for (const DB_PORT of ['', '13306 ', ' 13306', '013306', '13306abc', '13306\n']) {
    await expectRefusal({ ...legal, DB_PORT });
  }
});

test('localhost, a blank host, and a non-evidence database name are refused before initialize', async () => {
  await expectRefusal({ ...legal, DB_HOST: 'localhost' });
  await expectRefusal({ ...legal, DB_HOST: '' });
  await expectRefusal({ ...legal, DB_HOST: '127.0.0.1 ' });
  await expectRefusal({ ...legal, DB_NAME: 'db_ops_ai' });
  await expectRefusal({ ...legal, DB_NAME: 'slide_evidence_test_v' });
  await expectRefusal({ ...legal, DB_NAME: 'slide_evidence_test_v1_extra' });
  await expectRefusal({ ...legal, DB_NAME: '' });
});

test('the isolated host, explicit port, and database name call initialize once', async () => {
  let calls = 0;
  const opened = await openIsolatedEvidenceDatabase(legal, async () => {
    calls += 1;
    return true;
  });
  assert.equal(opened, true);
  assert.equal(calls, 1);
});

test('script entry refuses a closed non-isolated port before any database session', async () => {
  const script = new URL('./evidence-persistence.ts', import.meta.url);
  const started = Date.now();
  const failed = await exec(process.execPath, ['--import', 'tsx', script.pathname, 'seed'], {
    env: {
      ...process.env,
      DB_HOST: '127.0.0.1',
      DB_PORT: '1',
      DB_NAME: 'slide_evidence_test_v1',
      DB_USER: 'root',
      DB_PASSWORD: '',
    },
    timeout: 8_000,
  }).then(
    () => { throw new Error('script entry exited 0'); },
    (error: { code?: number; stdout?: string; stderr?: string }) => error,
  );
  const output = `${failed.stdout ?? ''}\n${failed.stderr ?? ''}`;
  assert.equal(failed.code, 1);
  assert.match(output, /ISOLATED_EVIDENCE_DATABASE_REQUIRED/);
  assert.doesNotMatch(output, /系统数据库连接成功/);
  assert.ok(Date.now() - started < 5_000, 'refusal waited long enough to be a connection timeout');
});
