import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { constants } from 'node:os';
import { fileURLToPath } from 'node:url';

const scenarios = ['recovery', 'length', 'reject'];
const common = ['scenario', 'kind', 'wallBefore', 'mono', 'wallAfter'];
const fields = {
  phase: ['phase'], http: ['status', 'session', 'count', 'matches', 'length'],
  ws: ['direction', 'event', 'session', 'run', 'message', 'state'],
  snapshot: ['run', 'session', 'state', 'pending', 'count', 'matches', 'length'],
  result: ['status'], collection: ['failed', 'count'],
};
const enums = {
  phase: ['started', 'before_reload', 'pending_staged', 'before_recovery_reload'],
  direction: ['sent', 'received'], event: ['chat.watch', 'run.snapshot', 'complete', 'run.started', 'stream.snapshot', 'stream.event', 'error'],
  state: ['running', 'completed', 'failed', 'cancelled', 'timed_out', 'partial', 'missing'],
};
export function validateEvent(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row) || !scenarios.includes(row.scenario) || !fields[row.kind]) throw new Error('INVALID_EVENT');
  const required = row.kind === 'ws' ? ['direction', 'event', 'session'] : fields[row.kind];
  if (required.some(key => row[key] === undefined)) throw new Error('MISSING_FIELD');
  const allowed = new Set([...common, ...fields[row.kind]]);
  if (Object.keys(row).some(key => !allowed.has(key))) throw new Error('UNKNOWN_FIELD');
  for (const key of ['wallBefore', 'mono', 'wallAfter']) if (!Number.isFinite(row[key]) || row[key] < 0) throw new Error('INVALID_CLOCK');
  if (row.wallAfter < row.wallBefore) throw new Error('CLOCK_CHANGED');
  for (const key of ['session', 'run', 'message']) if (row[key] !== undefined && !/^[a-f0-9]{64}$/.test(row[key])) throw new Error('INVALID_LINK');
  for (const key of ['count', 'length', 'status']) {
    if (row.kind === 'result' && key === 'status') continue;
    if (row[key] !== undefined && (!Number.isSafeInteger(row[key]) || row[key] < 0 || row[key] > 1_000_000)) throw new Error('INVALID_NUMBER');
  }
  for (const [key, values] of Object.entries(enums)) if (row[key] !== undefined && !values.includes(row[key])) throw new Error('INVALID_ENUM');
  for (const key of ['pending', 'matches', 'failed']) if (row[key] !== undefined && typeof row[key] !== 'boolean') throw new Error('INVALID_BOOLEAN');
  if (row.kind === 'result' && !['passed', 'failed', 'timedOut', 'skipped', 'interrupted'].includes(row.status)) throw new Error('INVALID_RESULT');
  if (row.kind === 'collection' && row.failed !== true) throw new Error('INVALID_COLLECTION');
  return row;
}
export function collect(input, output, businessExit) {
  let report;
  let dropped = null;
  try {
    const raw = readFileSync(input);
    if (!raw.length || raw.length > 2_000_000) throw new Error('INVALID_SIZE');
    const lines = raw.toString('utf8').trim().split('\n');
    if (lines.length > 2000) throw new Error('LIMIT');
    const records = lines.map(line => validateEvent(JSON.parse(line)));
    dropped = records.filter(row => row.kind === 'collection').reduce((n, row) => n + row.count, 0);
    if (records.some(row => row.kind === 'collection')) throw new Error('COLLECTION_FAILED');
    if (businessExit === 0 && records.some(row => row.kind === 'result' && row.status !== 'passed')) throw new Error('RESULT_MISMATCH');
    for (const scenario of scenarios) {
      if (records.filter(row => row.scenario === scenario && row.kind === 'result').length !== 1) throw new Error('MISSING_RESULT');
    }
    report = { version: 1, businessExit, collection: 'complete', dropped: 0, records };
  } catch {
    console.error('RUNTIME_EVIDENCE_COLLECTION_FAILED');
    // Never echo rejected input, exception text or an untrusted path.
    report = { version: 1, businessExit, collection: 'failed', dropped, code: 'RUNTIME_EVIDENCE_COLLECTION_FAILED' };
  }
  try {
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  } catch { console.error('RUNTIME_EVIDENCE_COLLECTION_FAILED'); return businessExit || 2; }
  return businessExit !== 0 ? businessExit : report.collection === 'complete' ? 0 : 2;
}
export function run({ root, env = process.env, launch = spawnSync }) {
  const input = resolve(root, 'frontend/test-results-agent-runtime-private/events.ndjson');
  const output = resolve(root, 'frontend/test-results-agent-runtime-sanitized/evidence.json');
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify({ version: 1, collection: 'failed', code: 'RUNTIME_EVIDENCE_NOT_COLLECTED' }) + '\n', { mode: 0o600 });
  if (existsSync(input)) { console.error('RUNTIME_EVIDENCE_COLLECTION_FAILED'); return 2; } // Refuse stale evidence rather than attributing it to a new run.
  const result = launch('pnpm', ['--filter', 'slide-frontend', 'exec', 'playwright', 'test', 'agent-runtime.spec.ts', '--config', 'playwright.agent-runtime.config.ts', '--workers=1'],
    { cwd: root, env: { ...env, RUNTIME_EVIDENCE_FILE: input }, stdio: 'inherit' });
  const businessExit = Number.isInteger(result.status) ? result.status : result.signal && constants.signals[result.signal] ? 128 + constants.signals[result.signal] : 1;
  return collect(input, output, businessExit);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = run({ root: resolve(dirname(fileURLToPath(import.meta.url)), '../..') }); }
  catch { console.error('RUNTIME_EVIDENCE_COLLECTION_FAILED'); process.exitCode = 2; }
}
