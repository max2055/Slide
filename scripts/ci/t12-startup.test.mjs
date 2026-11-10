import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { driverError, safeLogs, probe, snapshot } from '../qualification/t12-startup.mjs';

test('MAX251: driver errors retain only codes, not credentials or SQL', () => {
  assert.deepEqual(driverError({ code: 'ER_ACCESS_DENIED_ERROR', errno: 1045, sqlState: '28000', message: 'secret', sql: 'private' }),
    { code: 'ER_ACCESS_DENIED_ERROR', errno: 1045, sqlState: '28000' });
  assert.deepEqual(driverError({ code: 'password=secret', errno: 'secret', sqlState: 'private' }), { code: 'UNCLASSIFIED' });
});

test('MAX251: bounded logs redact sensitive lines and terminal controls', () => {
  const text = safeLogs(['old\n'.repeat(90), '[MY-013576] InnoDB initialization has started.',
    'GENERATED ROOT PASSWORD: sentinel', 'pAsSwD="sentinel"', '{"apiKey":"sentinel"}',
    'Authorization: Bearer sentinel', 'redis://user:sentinel@example.test', '\u001b[31mhealthy'].join('\n'));
  assert.ok(!text.includes('sentinel'));
  assert.ok(!text.includes('\u001b'));
  assert.ok(text.includes('MY-013576'));
  assert.ok(text.split('\n').length <= 80);
});

test('MAX251: query failure closes the connected driver; close failure destroys it', async () => {
  let closed = 0, destroyed = 0;
  const result = await probe(1234, async config => {
    assert.equal(config.connectTimeout, 10_000);
    return { query: async options => { assert.equal(options.timeout, 10_000); throw { code: 'ECONNRESET' }; },
      end: async () => { closed++; throw { code: 'EPIPE' }; }, destroy: () => { destroyed++; } };
  });
  assert.equal(closed, 1); assert.equal(destroyed, 1);
  assert.equal(result.ready, false); assert.equal(result.error.code, 'ECONNRESET');
  assert.equal((await probe(1234, async () => ({ query: async () => {}, end: async () => {} }))).ready, true);
});

test('MAX251: snapshot rejects shared identities and persists only allowed state', () => {
  const dir = mkdtempSync(join(tmpdir(), 't12-snapshot-'));
  try {
    assert.throws(() => snapshot('mysql', dir, 'failure'), /Invalid/);
    assert.equal(snapshot('slide-t12-123-456', dir, 'failure', args => {
      if (args[0] === 'inspect') {
        assert.ok(!args.join(' ').includes('Config.Env'));
        return { code: 0, stdout: JSON.stringify({ status: 'exited', running: false, oomKilled: true, exitCode: 137,
          memoryBytes: 805306368, Env: ['private-sentinel'], Error: 'private-sentinel' }) };
      }
      return { code: 0, stdout: 'password=private-sentinel\n[MY-010119] Aborting' };
    }), 0);
    const text = readFileSync(join(dir, 'startup.jsonl'), 'utf8');
    assert.ok(!text.includes('private-sentinel'));
    assert.equal(JSON.parse(text).state.oomKilled, true);
    assert.equal(JSON.parse(text).state.exitCode, 137);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

function shellScenario(scenario, mode = '--rollout') {
  const dir = mkdtempSync(join(tmpdir(), 't12-shell-')), bin = join(dir, 'bin'), output = join(dir, 'output');
  mkdirSync(bin);
  writeFileSync(join(bin, 'docker'), `#!/bin/bash
case "$1" in
 run) while [[ "$1" != --name ]]; do shift; done; name="$2"; touch "$FIXTURE/$name"; echo "$name";;
 port) echo '127.0.0.1:43210';;
 inspect) echo '{"status":"exited","running":false,"oomKilled":false,"exitCode":2,"memoryBytes":805306368}';;
 logs) [[ "$SCENARIO" == observation-failure ]] && exit 5; echo '[MY-000067] unknown variable'; echo 'password=never-expose' >&2;;
 stop) exit 0;;
 rm) [[ "$SCENARIO" == cleanup-failure ]] && exit 4; rm -f "$FIXTURE/$2";;
 ps) for f in "$FIXTURE"/slide-t12-*; do [[ -f "$f" ]] && basename "$f"; done; exit 0;;
 *) exit 91;;
esac
`, { mode: 0o755 });
  writeFileSync(join(bin, 'pnpm'), `#!/bin/bash
if [[ "$*" == *' probe '* ]]; then [[ "$SCENARIO" != readiness-failure ]]; exit $?; fi
touch "$FIXTURE/business-started"
[[ "$SCENARIO" == business-failure ]] && exit 7
exit 0
`, { mode: 0o755 });
  writeFileSync(join(bin, 'sleep'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const result = spawnSync('bash', [resolve('scripts/qualification/run-investigation-rollout.sh'), mode], {
    env: { ...process.env, PATH: `${bin}:${dirname(process.execPath)}:${process.env.PATH}`, FIXTURE: dir,
      SCENARIO: scenario, T12_OUTPUT_DIR: output }, encoding: 'utf8', timeout: 30_000,
  });
  return { dir, result, rows: readFileSync(join(output, 'startup.jsonl'), 'utf8').trim().split('\n').map(JSON.parse) };
}

for (const scenario of ['ready', 'readiness-failure', 'business-failure', 'observation-failure', 'cleanup-failure']) {
  test(`MAX251: qualification wrapper ${scenario} retains evidence before cleanup`, () => {
    const { dir, result, rows } = shellScenario(scenario);
    try {
      assert.equal(result.status, scenario === 'ready' ? 0 : scenario === 'business-failure' ? 7 : 1, result.stderr);
      assert.equal(existsSync(join(dir, 'business-started')), scenario !== 'readiness-failure');
      const snapshotAt = rows.findIndex(r => r.event === 'container-snapshot');
      const cleanupAt = rows.findIndex(r => r.event === 'cleanup');
      assert.ok(snapshotAt >= 0 && cleanupAt > snapshotAt);
      assert.ok(!JSON.stringify(rows).includes('never-expose'));
      assert.equal(rows[cleanupAt].removed, scenario !== 'cleanup-failure');
      assert.equal(rows.find(r => r.stage === 'test-exit').code, scenario === 'business-failure' ? 7 : scenario === 'readiness-failure' ? 1 : 0);
      assert.equal(rows.find(r => r.stage === 'cleanup-exit').code, scenario === 'cleanup-failure' ? 1 : 0);
      assert.equal(rows.find(r => r.stage === 'observation-exit').code, scenario === 'observation-failure' ? 1 : 0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}
