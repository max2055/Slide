import { appendFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(new URL('../../apps/db-ops-api/package.json', import.meta.url));
const safeCode = value => typeof value === 'string' && /^[A-Z0-9_]{1,64}$/.test(value) ? value : 'UNCLASSIFIED';

export function driverError(error) {
  return {
    code: safeCode(error?.code),
    ...(Number.isInteger(error?.errno) ? { errno: error.errno } : {}),
    ...(typeof error?.sqlState === 'string' && /^[A-Z0-9]{5}$/.test(error.sqlState) ? { sqlState: error.sqlState } : {}),
  };
}

// Startup logs can contain generated passwords, URLs or credentials in errors.
// Drop the entire sensitive line rather than guessing where its value ends.
export function safeLogs(text) {
  return text.split(/\r?\n/).slice(-80).map(line =>
    /pass(?:word|wd)?|\bpwd\b|secret|token|credential|authorization|api[_-]?key|private[_-]?key|:\/\/[^\s/]*@/i.test(line)
      ? '[redacted sensitive log line]'
      : line.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').slice(0, 1000)).join('\n');
}

export function record(directory, event) {
  appendFileSync(join(directory, 'startup.jsonl'), JSON.stringify({ utc: new Date().toISOString(), ...event }) + '\n');
}

export async function probe(port, connect, queryTimeout = 10_000) {
  let connection;
  const started = performance.now();
  let error;
  try {
    connection = await connect({ host: '127.0.0.1', port, user: 'root', password: '', connectTimeout: 10_000 });
    await connection.query({ sql: 'SELECT 1', timeout: queryTimeout });
  } catch (failure) { error = failure; }
  finally {
    if (connection) {
      try { await connection.end(); }
      catch (failure) { error ??= failure; connection.destroy(); }
    }
  }
  return { ready: !error, elapsedMs: Math.round(performance.now() - started), ...(error ? { error: driverError(error) } : {}) };
}

function docker(args) {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 10_000, maxBuffer: 128 * 1024 });
  return { code: result.status ?? 1, stdout: (result.stdout ?? '') + (args[0] === 'logs' ? result.stderr ?? '' : '') };
}

export function snapshot(container, directory, phase, execute = docker) {
  if (!/^slide-t12-[0-9]+-[0-9]+(?:-operations)?$/.test(container)) throw new Error('Invalid T12 container identity');
  // Never request full inspect, Config.Env, State.Error or Docker stderr.
  const state = execute(['inspect', '--format', '{"status":{{json .State.Status}},"running":{{json .State.Running}},"oomKilled":{{json .State.OOMKilled}},"exitCode":{{json .State.ExitCode}},"memoryBytes":{{json .HostConfig.Memory}}}', container]);
  const logs = execute(['logs', '--tail', '80', container]);
  let fields;
  if (state.code === 0) {
    const parsed = JSON.parse(state.stdout);
    fields = { status: safeCode(String(parsed.status).toUpperCase()), running: parsed.running === true,
      oomKilled: parsed.oomKilled === true, exitCode: Number(parsed.exitCode), memoryBytes: Number(parsed.memoryBytes) };
  }
  record(directory, { event: 'container-snapshot', container, phase, inspectCode: state.code, logsCode: logs.code,
    ...(fields ? { state: fields } : {}), logs: safeLogs(logs.stdout) });
  return state.code === 0 && logs.code === 0 ? 0 : 1;
}

export async function main(args) {
  const [action, directory, ...rest] = args;
  if (action === 'probe') {
    const [portText, label, attempt] = rest, port = Number(portText);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid T12 probe port');
    const mysql = require('mysql2/promise');
    const result = await probe(port, mysql.createConnection);
    record(directory, { event: 'readiness', label, attempt: Number(attempt), node: process.version, ...result });
    return result.ready ? 0 : 1;
  }
  if (action === 'snapshot') return snapshot(rest[0], directory, rest[1]);
  if (action === 'stage') {
    record(directory, { event: 'stage', stage: rest[0], code: Number(rest[1]), elapsedSeconds: Number(rest[2]) });
    return 0;
  }
  if (action === 'cleanup') {
    const [container, stop, remove, absent] = rest;
    record(directory, { event: 'cleanup', container, stopCode: Number(stop), removeCode: Number(remove), removed: absent === '1' });
    return Number(stop) === 0 && Number(remove) === 0 && absent === '1' ? 0 : 1;
  }
  throw new Error('Invalid T12 startup action');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(() => {
    console.error('T12 startup evidence failed'); process.exitCode = 1;
  });
}
