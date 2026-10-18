/** Opt-in reuse of an owned standby API. The signed phase config still binds
 * the exact loopback URL; this receipt never grants JWT, ACL or audit authority. */
import { constants } from 'node:fs';
import { open, lstat } from 'node:fs/promises';
import { connect } from 'node:net';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import { bytesHash, sourceFailure, type SourcePackage } from './config.js';
async function privateFile(path: string) {
  const f = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const st = await f.stat();
    if (!st.isFile() || st.uid !== process.getuid?.() || st.mode & 0o077 || st.size > 65536)
      sourceFailure('SESSION_PRIVATE_FILE');
    const bytes = await f.readFile();
    if (bytes.length > 65536) sourceFailure('SESSION_INPUT_LIMIT');
    return bytes;
  } finally {
    await f.close();
  }
}
async function status(socket: string, sessionId: string) {
  const st = await lstat(socket);
  if (!st.isSocket() || st.uid !== process.getuid?.() || st.mode & 0o077)
    sourceFailure('SESSION_PRIVATE_SOCKET');
  return new Promise<any>((done, reject) => {
    const c = connect(socket);
    let text = '';
    c.setTimeout(1500, () => c.destroy(new Error('SESSION_STATUS_UNKNOWN')));
    c.on('error', reject);
    c.on('connect', () => c.write(JSON.stringify({ command: 'status', sessionId }) + '\n'));
    c.on('data', (chunk) => {
      text += chunk;
      if (text.length > 65536) c.destroy(new Error('SESSION_STATUS_LIMIT'));
    });
    c.on('end', () => {
      try {
        const v = JSON.parse(text);
        if (!v.ok) throw new Error('SESSION_STATUS_REJECTED');
        done(v.result);
      } catch (error) {
        reject(error);
      }
    });
  });
}
export async function verifySessionApi(
  pool: Pool,
  config: SourcePackage,
  head: string,
  file: string,
  expectedHash: string,
) {
  try {
    const bytes = await privateFile(file);
    if (!/^[a-f0-9]{64}$/.test(expectedHash) || bytesHash(bytes) !== expectedHash)
      sourceFailure('SESSION_DESCRIPTOR_CHANGED');
    const d = JSON.parse(bytes.toString());
    if (
      d.head !== head ||
      d.schema !== config.database ||
      d.databasePort !== Number(process.env.DB_PORT) ||
      config.api !== `http://127.0.0.1:${d.apiPort}` ||
      Date.parse(d.startsAt) > Date.now() ||
      Date.parse(d.sessionExpiresAt) <= Date.now() ||
      Date.parse(d.sessionExpiresAt) - Date.parse(d.startsAt) > 14400000 ||
      Date.parse(config.deadline) > Date.parse(d.sessionExpiresAt) ||
      !Number.isFinite(Date.parse(d.startsAt)) ||
      !Number.isFinite(Date.parse(d.sessionExpiresAt))
    )
      sourceFailure('SESSION_BINDING');
    const [rows] = await pool.query<RowDataPacket[]>('SELECT DATABASE() db,@@server_uuid uuid');
    if (rows[0]?.db !== d.schema || rows[0]?.uuid !== d.uuid)
      sourceFailure('SESSION_DATABASE_CHANGED');
    const current = await status(d.socket, d.sessionId);
    if (
      current.closed ||
      current.held ||
      current.phaseOperationId !== config.operationId ||
      current.url !== config.api ||
      current.expiresAt !== d.sessionExpiresAt
    )
      sourceFailure('SESSION_NOT_ACTIVE');
    const identity = JSON.parse((await privateFile(d.directory + '/api-identity.json')).toString());
    if (
      identity.pid !== current.apiPid ||
      identity.head !== head ||
      identity.cwd !== resolve('.') ||
      identity.port !== d.apiPort ||
      identity.sessionId !== d.sessionId ||
      identity.log !== d.directory + '/api.log' ||
      identity.execPath !== process.execPath ||
      identity.argv.length !== 3 ||
      identity.argv[0] !== '--import' ||
      identity.argv[2] !== 'server.ts' ||
      identity.argv[1] !== identity.loader
    )
      sourceFailure('SESSION_API_IDENTITY');
    const command = execFileSync('ps', ['-p', String(identity.pid), '-o', 'command='], {
      encoding: 'utf8',
      timeout: 1500,
    }).trim();
    if (command !== [identity.execPath, ...identity.argv].join(' '))
      sourceFailure('SESSION_API_PROCESS_CHANGED');
    // Bound the durable receipt read; do not expose or persist arbitrary logs.
    const log = await open(identity.log, constants.O_RDONLY | constants.O_NOFOLLOW);
    let standby = false;
    try {
      const st = await log.stat();
      if (!st.isFile() || st.uid !== process.getuid?.() || st.mode & 0o077)
        sourceFailure('SESSION_API_LOG');
      const buffer = Buffer.alloc(Math.min(st.size, 262144));
      const { bytesRead } = await log.read(buffer, 0, buffer.length, 0);
      standby = buffer
        .subarray(0, bytesRead)
        .includes(Buffer.from('WORKER_LEASE_UNAVAILABLE: API-only standby'));
    } finally {
      await log.close();
    }
    if (!standby) sourceFailure('SESSION_NOT_STANDBY');
    return {
      pid: identity.pid,
      port: identity.port,
      sessionId: d.sessionId,
      descriptorHash: expectedHash,
    };
  } catch {
    sourceFailure('SESSION_API_REJECTED');
  }
}
