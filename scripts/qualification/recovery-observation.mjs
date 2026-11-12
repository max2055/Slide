// Foreground owner for a single disposable qualification container/test process.
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { cpus, freemem, totalmem, loadavg, arch, platform } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const execute = promisify(execFile);
const dbPattern = /^investigation_test_\d+_[a-f0-9]{32}$/;
const ATTEMPT_TIMEOUT_MS = 2500;
// recovery-observation.ts beforeCleanup waits 4s, then the worker drops its database.
// Watch lag, ack write, and the worker's ack poll sit outside the docker calls.
export const CLEANUP_WINDOW_MS = 4000;
export const CLEANUP_WATCH_MS = 100;
export const CLEANUP_ACK_POLL_MS = 20;
export const CLEANUP_ACK_WRITE_MS = 50;
export const CLEANUP_MARGIN_MS = 250;
export const STATS_RETRY_BUDGET_MS = CLEANUP_WINDOW_MS - CLEANUP_WATCH_MS - CLEANUP_ACK_POLL_MS - CLEANUP_ACK_WRITE_MS - CLEANUP_MARGIN_MS;
export async function boundedCommand(file, argv, options = {}) {
  const retries = options.retries ?? 0;
  const deadline = options.deadlineMs ?? Number.POSITIVE_INFINITY;
  const attemptTimeout = options.timeout ?? ATTEMPT_TIMEOUT_MS;
  const execOptions = { maxBuffer: 128 * 1024, ...options };
  delete execOptions.retries;
  delete execOptions.deadlineMs;
  delete execOptions.timeout;
  const attempts = [];
  const started = performance.now();
  for (let attempt = 0; ; attempt += 1) {
    const remaining = deadline - performance.now();
    if (remaining < 1) return { ok: false, code: 'DEADLINE_EXCEEDED', signal: null, attempts, durationMs: performance.now() - started };
    const timeoutMs = Math.max(1, Math.floor(Math.min(attemptTimeout, remaining)));
    const attemptStarted = performance.now();
    try {
      const result = await execute(file, argv, { ...execOptions, timeout: timeoutMs });
      attempts.push({ ok: true, timeoutMs, durationMs: performance.now() - attemptStarted });
      return { ok: true, stdout: result.stdout.trim(), attempts, durationMs: performance.now() - started };
    } catch (error) {
      const failure = { ok: false, code: typeof error.code === 'number' ? error.code : 'EXECUTION_FAILED', signal: error.signal ?? null };
      // Docker handles SIGTERM and can exit 143 with signal=null. Preserve the
      // execFile kill flag and elapsed budget instead of losing timeout evidence.
      attempts.push({ ...failure, timeoutMs, durationMs: performance.now() - attemptStarted, killed: error.killed === true });
      // `docker stats --no-stream` can be killed by SIGPIPE while the container is still readable.
      if (error.signal !== 'SIGPIPE' || attempt >= retries || deadline - performance.now() < 1) return { ...failure, attempts, durationMs: performance.now() - started };
    }
  }
}
export function pendingSql(events, now) {
  const pending = new Map();
  for (const event of events) {
    if (event.kind !== 'sql') continue;
    const key = `${event.pid}:${event.id}`;
    if (event.event === 'begin') pending.set(key, event);
    else pending.delete(key);
  }
  return [...pending.values()].map(e => ({ pid: e.pid, id: e.id, database: e.database,
    label: e.label, durationMs: /^\d+$/.test(e.monotonicNs) ? Math.max(0, Number(now - BigInt(e.monotonicNs)) / 1e6) : null }));
}
export async function runObservation(container, port, command, args) {
  if (!/^slide-report-recovery-\d+-\d+$/.test(container) || !/^\d+$/.test(port) || !command) throw new Error('Invalid isolated recovery invocation');
  const output = resolve(process.env.RECOVERY_OBSERVATION_DIR ?? join('.qualification/report-recovery', container));
  mkdirSync(output, { recursive: true });
  const origin = performance.now();
  let recordingFailed = false;
  const record = event => {
    try { appendFileSync(join(output, 'runner.jsonl'), JSON.stringify({ utc: new Date().toISOString(), monoMs: performance.now() - origin, ...event }) + '\n'); }
    catch { recordingFailed = true; process.stderr.write('RECOVERY_OBSERVATION_WRITE_FAILED\n'); }
  };
  const commit = await boundedCommand('git', ['rev-parse', 'HEAD']);
  if (!commit.ok || !/^[a-f0-9]{40}$/.test(commit.stdout)) throw new Error('Missing source identity');
  const identity = await boundedCommand('docker', ['inspect', '--format', '{{json .Id}} {{json .Image}} {{json .Platform}} {{json .State.Pid}}', container]);
  if (!identity.ok) throw new Error('Missing isolated container identity');
  const imageId = /sha256:[a-f0-9]{64}/.exec(identity.stdout)?.[0];
  if (!imageId) throw new Error('Missing isolated image identity');
  const image = await boundedCommand('docker', ['image', 'inspect', '--format', '{{.Id}} {{.Architecture}} {{.Os}}', imageId]);
  if (!image.ok) throw new Error('Missing isolated image architecture');
  record({ event: 'identity', commit: commit.stdout, container, containerIdentity: identity.stdout, imageIdentity: image.stdout,
    runner: { pid: process.pid, arch: arch(), platform: platform(), cpus: cpus().length, memoryBytes: totalmem() } });
  const events = () => readdirSync(output).filter(f => /^hook-\d+\.jsonl$/.test(f)).flatMap(f => readFileSync(join(output, f), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)));
  const sample = async final => {
    // One budget covers every stats attempt and the parallel process-list read.
    // CI no-stream samples regularly take ~2s; use the existing 3.58s total
    // window for its attempt too, rather than killing it at 2.5s under CI load.
    const sampleDeadline = performance.now() + STATS_RETRY_BUDGET_MS;
    try {
      const hookEvents = events();
      const databases = [...new Set(hookEvents.map(e => e.database))].filter(db => dbPattern.test(db));
      const connectionIds = [...new Set(hookEvents.map(e => e.connectionId))].filter(id => Number.isSafeInteger(id) && id > 0);
      const predicates = [];
      if (databases.length) predicates.push(`PROCESSLIST_DB IN (${databases.map(db => `'${db}'`).join(',')})`);
      if (connectionIds.length) predicates.push(`PROCESSLIST_ID IN (${connectionIds.join(',')})`);
      const predicate = predicates.length ? `(${predicates.join(' OR ')})` : 'FALSE';
      // Explicit columns exclude statement text, SQL bindings, connection credentials and business rows.
      const sql = `SELECT PROCESSLIST_ID,PROCESSLIST_DB,PROCESSLIST_COMMAND,PROCESSLIST_TIME,PROCESSLIST_STATE FROM performance_schema.threads WHERE ${predicate} LIMIT 100; SELECT t.PROCESSLIST_ID,w.EVENT_NAME,w.TIMER_WAIT,w.OPERATION FROM performance_schema.events_waits_current w JOIN performance_schema.threads t ON w.THREAD_ID=t.THREAD_ID WHERE ${predicate} LIMIT 100;`;
      const [stats, waits] = await Promise.all([
        boundedCommand('docker', ['stats', '--no-stream', '--format', '{{.CPUPerc}}|{{.MemUsage}}|{{.BlockIO}}|{{.PIDs}}', container], { retries: 2, timeout: STATS_RETRY_BUDGET_MS, deadlineMs: sampleDeadline }),
        boundedCommand('docker', ['exec', '--env', 'MYSQL_PWD=qualification-test-password', container, 'mysql', '-uroot', '--batch', '--skip-column-names', '-e', sql], { deadlineMs: sampleDeadline }),
      ]);
      record({ event: final ? 'final-snapshot' : 'sample', databases, connectionIds, pendingSql: pendingSql(hookEvents, process.hrtime.bigint()), stats, waits,
        runner: { freeMemoryBytes: freemem(), load: loadavg(), usage: process.resourceUsage() } });
      if (!stats.ok || !waits.ok) recordingFailed = true;
    } catch { recordingFailed = true; record({ event: 'snapshot-error' }); }
  };
  const child = spawn(command, args, { detached: process.platform !== 'win32', stdio: ['inherit', 'inherit', 'pipe'], env: { ...process.env,
    REPORT_TEST_MYSQL_PORT: port, REPORT_TEST_MYSQL_PASSWORD: 'qualification-test-password',
    RECOVERY_OBSERVATION_DIR: output, RECOVERY_OBSERVATION_COMMIT: commit.stdout } });
  child.stderr.on('data', chunk => {
    process.stderr.write(chunk);
    if (String(chunk).includes('RECOVERY_OBSERVATION_WRITE_FAILED')) recordingFailed = true;
  });
  record({ event: 'test-start', pid: child.pid });
  let inFlight;
  let samples = 0;
  const interval = setInterval(() => {
    if (!inFlight && samples++ < 120) inFlight = sample(false).finally(() => { inFlight = undefined; });
  }, 1000);
  // No detached descendants: a signal is forwarded, then force-bounded before shell cleanup.
  let cleanupSnapshot;
  const cleanupRequests = new Set();
  const cleanupWatcher = setInterval(() => {
    try {
      for (const file of readdirSync(output).filter(f => /^cleanup-\d+$/.test(f))) {
        if (cleanupRequests.has(file)) continue;
        cleanupRequests.add(file);
        // The worker waits at most 4s before its finally block drops its own DB.
        // sample() shares STATS_RETRY_BUDGET_MS, then this ack is written.
        cleanupSnapshot = sample(true).then(() => writeFileSync(join(output, `${file}.ack`), 'captured'))
          .catch(() => { recordingFailed = true; record({ event: 'cleanup-snapshot-error' }); });
      }
    } catch { recordingFailed = true; record({ event: 'cleanup-watch-error' }); }
  }, 100);
  let killTimer;
  const signalChild = signal => {
    try {
      if (process.platform === 'win32') child.kill(signal);
      else process.kill(-child.pid, signal);
    } catch { /* The exact child process group already exited. */ }
  };
  const interrupt = signal => {
    record({ event: 'interrupted', signal });
    signalChild(signal);
    killTimer ??= setTimeout(() => signalChild('SIGKILL'), 3000);
  };
  const onTerm = () => interrupt('SIGTERM');
  const onInt = () => interrupt('SIGINT');
  process.once('SIGTERM', onTerm); process.once('SIGINT', onInt);
  const result = await new Promise(resolveResult => {
    child.once('error', () => resolveResult({ code: 1, signal: null }));
    child.once('close', (code, signal) => resolveResult({ code, signal }));
  });
  clearInterval(interval); clearInterval(cleanupWatcher); clearTimeout(killTimer);
  if (cleanupSnapshot) await cleanupSnapshot;
  process.removeListener('SIGTERM', onTerm); process.removeListener('SIGINT', onInt);
  if (inFlight) await inFlight;
  await sample(true); // Before the shell's EXIT trap removes this exact container.
  const hookEvents = events();
  if (!hookEvents.some(e => e.event === 'hook-exit')) recordingFailed = true;
  record({ event: 'test-exit', ...result, recordingFailed, samples: Math.min(samples, 120) });
  return result.code === 0 ? (recordingFailed ? 1 : 0) : (result.code ?? 1);
}
export async function cleanupContainer(container) {
  if (!/^slide-report-recovery-\d+-\d+$/.test(container)) throw new Error('Invalid cleanup identity');
  const output = resolve(process.env.RECOVERY_OBSERVATION_DIR ?? join('.qualification/report-recovery', container));
  mkdirSync(output, { recursive: true });
  let removed = false;
  try { await execute('docker', ['rm', '-f', container], { timeout: 5000, maxBuffer: 4096 }); removed = true; }
  catch { process.stderr.write(`RECOVERY_CONTAINER_CLEANUP_FAILED ${container}\n`); }
  writeFileSync(join(output, 'cleanup.json'), JSON.stringify({ utc: new Date().toISOString(), container, removed }));
  return removed ? 0 : 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.exitCode = process.argv[2] === '--cleanup' ? await cleanupContainer(process.argv[3])
      : await runObservation(...process.argv.slice(2, 5), process.argv.slice(5));
  }
  catch { process.stderr.write('RECOVERY_OBSERVATION_FAILED\n'); process.exitCode = 1; }
}
