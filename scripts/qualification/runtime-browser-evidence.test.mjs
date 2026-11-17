import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, statSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { run, collect } from './runtime-browser-evidence.mjs';

function records(status = 'passed') {
  return ['recovery', 'length', 'reject'].map(scenario => ({ scenario, kind: 'result', status, collectionFailed: false, dropped: 0, wallBefore: 10, mono: 1, wallAfter: 11 }));
}
for (const [label, code, corrupt, expected] of [['success', 0, false, 0], ['business failure', 7, false, 7], ['collection failure', 0, true, 2], ['both failures', 7, true, 7]]) {
  test(`runtime archive preserves ${label}`, () => {
    const root = mkdtempSync(join(tmpdir(), 'runtime-archive-'));
    try {
      const exit = run({ root, launch: (_command, args, options) => {
        assert.ok(args.includes('playwright.agent-runtime.config.ts'));
        mkdirSync(dirname(options.env.RUNTIME_EVIDENCE_FILE), { recursive: true });
        writeFileSync(options.env.RUNTIME_EVIDENCE_FILE, corrupt ? '{"password":"SENSITIVE_SENTINEL"}' : records(code ? 'failed' : 'passed').map(JSON.stringify).join('\n'));
        assert.equal(statSync(options.env.RUNTIME_EVIDENCE_FILE).mode & 0o777, 0o600);
        return { status: code };
      } });
      assert.equal(exit, expected);
      const text = readFileSync(join(root, 'frontend/test-results-agent-runtime-sanitized/evidence.json'), 'utf8');
      assert.ok(!text.includes('SENSITIVE_SENTINEL'));
      const report = JSON.parse(text);
      assert.equal(report.businessExit, code);
      assert.equal(report.collection, corrupt ? 'failed' : 'complete');
      if (corrupt) assert.equal(report.records, undefined);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}
test('runtime archive rejects extra fields and enum injection without printing input', () => {
  const root = mkdtempSync(join(tmpdir(), 'runtime-secrets-'));
  try {
    for (const field of ['Authorization', 'Cookie', 'password', 'token', 'body', 'DOM', '__proto__']) {
      const rows = records(); rows[0] = JSON.parse(JSON.stringify(rows[0]).slice(0, -1) + `,"${field}":"SENSITIVE_SENTINEL"}`);
      const input = join(root, 'input'); const output = join(root, 'output');
      writeFileSync(input, rows.map(JSON.stringify).join('\n'));
      assert.equal(collect(input, output, 0), 2);
      assert.ok(!readFileSync(output, 'utf8').includes('SENSITIVE_SENTINEL'));
    }
    writeFileSync(join(root, 'input'), records().map(row => JSON.stringify({ ...row, status: 'SENSITIVE_SENTINEL' })).join('\n'));
    assert.equal(collect(join(root, 'input'), join(root, 'output'), 0), 2);
    assert.ok(!readFileSync(join(root, 'output'), 'utf8').includes('SENSITIVE_SENTINEL'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('missing data and unwritable output cannot replace a business failure with success', () => {
  const root = mkdtempSync(join(tmpdir(), 'runtime-missing-'));
  try {
    assert.equal(collect(join(root, 'missing'), join(root, 'output'), 9), 9);
    writeFileSync(join(root, 'blocked'), 'file');
    assert.equal(collect(join(root, 'missing'), join(root, 'blocked/output'), 9), 9);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('runner retains a signalled business exit while collecting failure metadata', () => {
  const root = mkdtempSync(join(tmpdir(), 'runtime-signal-'));
  try {
    assert.equal(run({ root, launch: () => ({ status: null, signal: 'SIGTERM' }) }), 143);
    const report = JSON.parse(readFileSync(join(root, 'frontend/test-results-agent-runtime-sanitized/evidence.json'), 'utf8'));
    assert.equal(report.businessExit, 143);
    assert.equal(report.collection, 'failed');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('stale private evidence is refused before another business launch', () => {
  const root = mkdtempSync(join(tmpdir(), 'runtime-stale-'));
  try {
    const input = join(root, 'frontend/test-results-agent-runtime-private/events.ndjson');
    mkdirSync(dirname(input), { recursive: true }); writeFileSync(input, 'SENSITIVE_STALE_INPUT');
    let launches = 0;
    assert.equal(run({ root, launch: () => { launches++; return { status: 0 }; } }), 2);
    assert.equal(launches, 0);
    const output = readFileSync(join(root, 'frontend/test-results-agent-runtime-sanitized/evidence.json'), 'utf8');
    assert.equal(JSON.parse(output).collection, 'failed'); assert.ok(!output.includes('SENSITIVE_STALE_INPUT'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('MF-R1 rejects coerced event kinds, non-own enums and array HMACs', () => {
  const root = mkdtempSync(join(tmpdir(), 'runtime-schema-'));
  try {
    const base = { scenario: 'recovery', kind: 'phase', phase: 'started', wallBefore: 1, mono: 1, wallAfter: 1 };
    for (const row of [{ ...base, kind: ['phase'] }, { ...base, kind: 'constructor' }, { ...base, kind: '__proto__' },
      { ...base, kind: 'ws', phase: undefined, direction: 'received', event: 'run.snapshot', session: ['a'.repeat(64)] }]) {
      writeFileSync(join(root, 'input'), [...records(), row].map(JSON.stringify).join('\n'));
      assert.equal(collect(join(root, 'input'), join(root, 'output'), 0), 2);
      assert.equal(JSON.parse(readFileSync(join(root, 'output'), 'utf8')).collection, 'failed');
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
