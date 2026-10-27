/**
 * MAX-237 / T2B-DDL-ERROR-GUARD — dedicated minimal regression for the root
 * DDL subprocess boundary in `drill.ts`.
 *
 * It drives the real `mysqlRootDdl` against a fake `docker` executable placed
 * first on PATH, so no database and no real container are involved:
 *
 *   - success: the docker argv is unchanged and the call returns
 *   - auth failure: the raw child-process error (whose message embeds the whole
 *     docker argv, including MYSQL_PWD, plus the captured stderr) never reaches
 *     the caller, a log stream or a serialized evidence record; the failure is
 *     still signalled as a controlled non-zero failure
 *   - spawn failure: a controlled failure is reported as well
 *
 * The same scenario is re-run end to end through the real CLI on a fresh
 * exclusive fixture by `chief-secret-probe.py`; this file is the repeatable
 * committed check of the boundary itself.
 *
 *   npx tsx docs/slide/development/MAX-237/t2b/ddl-error-guard.test.ts
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mysqlRootDdl } from './drill.js';
import { DrillError } from './migrate.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../../../../..');
const APP_DIR = join(ROOT, 'apps/db-ops-api');
const TSX = join(APP_DIR, 'node_modules/.bin/tsx');
const DRILL = join(HERE, 'drill.ts');

/** Known non-secret stand-in for the root password. */
const MARKER = 'DDL_GUARD_SYNTHETIC_NON_SECRET_ROOT_SENTINEL';
const CONTAINER_ID = 'f'.repeat(64);
const SQL = 'ALTER TABLE `max237_t2b`.`metric_templates_v2` ADD COLUMN `probe` INT';

const cfg = { handle: { container_id: CONTAINER_ID } } as unknown as Parameters<typeof mysqlRootDdl>[0];

const checks: string[] = [];
function pass(check: string): void {
  checks.push(check);
}

/** Every string reachable from an error through its own properties. */
function errorSurface(error: unknown): string {
  const parts: string[] = [];
  const seen = new Set<object>();
  const visit = (value: unknown, depth: number): void => {
    if (depth > 6 || value === null || value === undefined) return;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      parts.push(String(value));
      return;
    }
    if (typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    for (const key of Reflect.ownKeys(value)) {
      parts.push(String(key));
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor && 'value' in descriptor) visit(descriptor.value, depth + 1);
    }
  };
  visit(error, 0);
  return parts.join('\n');
}

interface StreamCapture { text: string }
function captureStreams(run: () => void): StreamCapture {
  const capture: StreamCapture = { text: '' };
  const stdoutWrite = process.stdout.write;
  const stderrWrite = process.stderr.write;
  const sink = (chunk: unknown): boolean => {
    capture.text += String(chunk);
    return true;
  };
  (process.stdout as unknown as { write: unknown }).write = sink;
  (process.stderr as unknown as { write: unknown }).write = sink;
  try {
    run();
  } finally {
    (process.stdout as unknown as { write: unknown }).write = stdoutWrite;
    (process.stderr as unknown as { write: unknown }).write = stderrWrite;
  }
  return capture;
}

function failureOf(run: () => void): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error('expected the root DDL call to fail, but it returned');
}

const workdir = mkdtempSync(join(tmpdir(), 'max237-ddl-guard-'));
const binDir = join(workdir, 'bin');
const argsFile = join(workdir, 'docker-args.txt');
const emptyPathDir = join(workdir, 'empty');
const realPath = process.env.PATH ?? '';
const savedEnv = {
  PATH: process.env.PATH,
  MAX237_FAKE_DOCKER_MODE: process.env.MAX237_FAKE_DOCKER_MODE,
  MAX237_FAKE_DOCKER_ARGS: process.env.MAX237_FAKE_DOCKER_ARGS,
};

try {
  mkdirSync(binDir, { recursive: true, mode: 0o755 });
  mkdirSync(emptyPathDir, { recursive: true, mode: 0o755 });
  const fakeDocker = join(binDir, 'docker');
  writeFileSync(fakeDocker, [
    '#!/bin/sh',
    '# Records the exact argv, then succeeds or fails as instructed.',
    'printf \'%s\\n\' "$@" > "$MAX237_FAKE_DOCKER_ARGS"',
    'if [ "${MAX237_FAKE_DOCKER_MODE:-fail}" = "ok" ]; then exit 0; fi',
    'echo "ERROR 1045 (28000): Access denied for user \'root\'@\'localhost\' (using password: YES)" >&2',
    'exit 1',
    '',
  ].join('\n'), { mode: 0o755 });

  process.env.PATH = `${binDir}:${realPath}`;
  process.env.MAX237_FAKE_DOCKER_ARGS = argsFile;

  // ---------------------------------------------------------- success unchanged
  process.env.MAX237_FAKE_DOCKER_MODE = 'ok';
  const okCapture = captureStreams(() => mysqlRootDdl(cfg, MARKER, SQL));
  assert.equal(okCapture.text, '', 'a successful DDL subprocess must not write to stdout/stderr');
  const argv = readFileSync(argsFile, 'utf8').split('\n').filter(line => line !== '');
  assert.deepEqual(argv, [
    'exec', '-e', `MYSQL_PWD=${MARKER}`, '-i', CONTAINER_ID, 'mysql', '-uroot', '-N', '-e', SQL,
  ], 'the successful docker invocation must be unchanged');
  pass('success: docker argv unchanged, no output, no failure');

  // -------------------------------------------------- auth failure stays private
  process.env.MAX237_FAKE_DOCKER_MODE = 'fail';
  let caught: unknown = null;
  const failCapture = captureStreams(() => { caught = failureOf(() => mysqlRootDdl(cfg, MARKER, SQL)); });
  assert.equal(failCapture.text, '', 'the converted failure must not write the raw error to a stream');
  assert.ok(caught instanceof DrillError, 'the boundary must report a controlled DrillError');
  const failure = caught as DrillError;
  assert.equal(failure.reason, 'root-ddl-failed');
  assert.match(failure.message, /exit code 1/);
  assert.deepEqual(failure.detail, { exit_code: 1 });
  assert.ok(!errorSurface(failure).includes(MARKER), 'the credential must not reach the caller or its stack');
  assert.ok(!JSON.stringify(failure).includes(MARKER), 'the credential must not reach a serialized error');
  assert.equal((failure as { cause?: unknown }).cause, undefined);
  // The same records the CLI writes to stderr/--out for a DrillError and for a
  // plain error must stay marker-free.
  const drillRecords = [
    JSON.stringify({ reason: failure.reason, message: failure.message, detail: failure.detail }),
    JSON.stringify({ reason: 'error', message: String(failure.message) }),
  ];
  assert.ok(drillRecords.every(record => !record.includes(MARKER)),
    'the credential must not reach an evidence record');
  pass('auth failure: controlled reason/exit code, no marker in caller/stack/streams/record');

  // ------------------------------------------------------ spawn failure controlled
  process.env.PATH = emptyPathDir;
  const spawnFailure = failureOf(() => mysqlRootDdl(cfg, MARKER, SQL)) as DrillError;
  assert.equal(spawnFailure.reason, 'root-ddl-failed');
  assert.match(spawnFailure.message, /could not be started/);
  assert.deepEqual(spawnFailure.detail, { exit_code: null });
  assert.ok(!errorSurface(spawnFailure).includes(MARKER));
  pass('spawn failure: controlled reason, no marker');
  process.env.PATH = `${binDir}:${realPath}`;

  // -------------------------------------- a separate process still exits non-zero
  const harness = join(workdir, 'harness.mts');
  writeFileSync(harness, [
    `const { mysqlRootDdl } = await import(${JSON.stringify(pathToFileURL(DRILL).href)});`,
    'const [marker, containerId] = process.argv.slice(2);',
    'try {',
    '  mysqlRootDdl({ handle: { container_id: containerId } } as never, marker, "SELECT 1");',
    '  process.stdout.write(JSON.stringify({ result: "unexpected-success" }) + "\\n");',
    '} catch (error) {',
    '  const failure = error as { reason?: string; message?: string; detail?: unknown };',
    '  process.stdout.write(JSON.stringify({',
    '    reason: failure.reason, message: failure.message, detail: failure.detail,',
    '  }) + "\\n");',
    '  process.exitCode = 1;',
    '}',
    '',
  ].join('\n'));
  process.env.MAX237_FAKE_DOCKER_MODE = 'fail';
  const child = spawnSync(TSX, [harness, MARKER, CONTAINER_ID], {
    env: { ...process.env, MAX237_FAKE_DOCKER_ARGS: argsFile },
    encoding: 'utf8',
  });
  assert.equal(child.status, 1, `child stderr: ${child.stderr}`);
  assert.equal(child.stdout.includes(MARKER), false, 'marker must not reach the child stdout');
  assert.equal(child.stderr.includes(MARKER), false, 'marker must not reach the child stderr');
  const childRecord = JSON.parse(child.stdout.trim()) as { reason?: string; message?: string };
  assert.equal(childRecord.reason, 'root-ddl-failed');
  assert.match(String(childRecord.message), /exit code 1/);
  pass('separate process: exit non-zero, marker absent from stdout and stderr');

  process.stdout.write(`ddl-error-guard: ${checks.length}/${checks.length} PASS\n`);
  for (const check of checks) process.stdout.write(`  - ${check}\n`);
} finally {
  if (savedEnv.PATH === undefined) delete process.env.PATH; else process.env.PATH = savedEnv.PATH;
  if (savedEnv.MAX237_FAKE_DOCKER_MODE === undefined) delete process.env.MAX237_FAKE_DOCKER_MODE;
  else process.env.MAX237_FAKE_DOCKER_MODE = savedEnv.MAX237_FAKE_DOCKER_MODE;
  if (savedEnv.MAX237_FAKE_DOCKER_ARGS === undefined) delete process.env.MAX237_FAKE_DOCKER_ARGS;
  else process.env.MAX237_FAKE_DOCKER_ARGS = savedEnv.MAX237_FAKE_DOCKER_ARGS;
  rmSync(workdir, { recursive: true, force: true });
}
