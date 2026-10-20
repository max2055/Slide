import { mkdtemp, writeFile, chmod, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:net';
import { execFileSync } from 'node:child_process';
vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));
import type { Pool } from 'mysql2/promise';
import { sourceTestConfig } from './config.fixture.js';
import { bytesHash } from './config.js';
import { verifySessionApi } from './session-api.js';
const paths: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const p of paths.splice(0)) await rm(p, { recursive: true, force: true });
});
describe('owned standby session API admission before audit consumption', () => {
  const head = 'a'.repeat(40);
  async function fixture(change: Record<string, unknown> = {}) {
    vi.stubEnv('DB_PORT', '54321');
    const dir = await mkdtemp(join(tmpdir(), 'v23-session-'));
    paths.push(dir);
    const config = sourceTestConfig();
    const descriptor = {
      head,
      schema: config.database,
      databasePort: Number(process.env.DB_PORT),
      apiPort: 19303,
      startsAt: new Date(Date.now() - 1000).toISOString(),
      sessionExpiresAt: new Date(Date.now() + 300000).toISOString(),
      ...change,
    };
    const bytes = Buffer.from(JSON.stringify(descriptor)),
      file = join(dir, 'descriptor.json');
    await writeFile(file, bytes, { mode: 0o600 });
    const query = vi.fn().mockRejectedValue(new Error('No SQL permitted for an invalid binding'));
    return { config, file, hash: bytesHash(bytes), query, pool: { query } as unknown as Pool };
  }
  it.each([
    ['head', { head: 'b'.repeat(40) }],
    ['database', { schema: 'another_schema' }],
    ['URL', { apiPort: 19304 }],
    ['future start', { startsAt: new Date(Date.now() + 60000).toISOString() }],
    ['expired session', { sessionExpiresAt: new Date(0).toISOString() }],
    ['oversized session', { sessionExpiresAt: new Date(Date.now() + 15000000).toISOString() }],
    ['invalid date', { sessionExpiresAt: 'invalid' }],
  ])('rejects %s before a SQL query', async (_, change) => {
    const f = await fixture(change);
    await expect(verifySessionApi(f.pool, f.config, head, f.file, f.hash)).rejects.toThrow(
      'SESSION_API_REJECTED',
    );
    expect(f.query).not.toHaveBeenCalled();
  });
  it('checks the actual database after valid private descriptor binding', async () => {
    const f = await fixture();
    await expect(verifySessionApi(f.pool, f.config, head, f.file, f.hash)).rejects.toThrow(
      'SESSION_API_REJECTED',
    );
    expect(f.query).toHaveBeenCalledOnce();
  });
  it('rejects changed bytes and readable-by-others input before SQL', async () => {
    const f = await fixture();
    await expect(verifySessionApi(f.pool, f.config, head, f.file, '0'.repeat(64))).rejects.toThrow(
      'SESSION_API_REJECTED',
    );
    await chmod(f.file, 0o644);
    await expect(verifySessionApi(f.pool, f.config, head, f.file, f.hash)).rejects.toThrow(
      'SESSION_API_REJECTED',
    );
    expect(f.query).not.toHaveBeenCalled();
  });
  it('rejects symlinks before SQL', async () => {
    const f = await fixture(),
      link = f.file + '.link';
    await symlink(f.file, link);
    await expect(verifySessionApi(f.pool, f.config, head, link, f.hash)).rejects.toThrow(
      'SESSION_API_REJECTED',
    );
    expect(f.query).not.toHaveBeenCalled();
  });
});

/** Boundary regression: real private socket/files; SQL and ps are unit doubles.
 * Actual production CLI/SQL/JWT/HTTP admission is verified by the isolated harness. */
describe('bounded complete session descriptor', () => {
  let socket: Server | undefined;
  afterEach(async () => {
    if (socket) await new Promise<void>((done) => socket!.close(() => done()));
    socket = undefined;
    vi.clearAllMocks();
  });
  async function fixture() {
    vi.stubEnv('DB_PORT', '54321');
    const directory = await mkdtemp(join(tmpdir(), 'v23-large-session-'));
    paths.push(directory);
    const head = 'a'.repeat(40), config = sourceTestConfig();
    const descriptor = {
      directory, head, schema: config.database, databasePort: 54321, apiPort: 19303,
      startsAt: new Date(Date.now() - 1000).toISOString(),
      sessionExpiresAt: new Date(Date.now() + 300000).toISOString(),
      socket: join(directory, 'control.sock'), sessionId: config.operationId, uuid: 'synthetic-uuid',
      files: Object.fromEntries(Array.from({ length: 322 }, (_, i) =>
        [`/synthetic/dependency-${i}/` + 'module/'.repeat(23) + 'source.ts', 'b'.repeat(64)])),
    };
    const current = { closed: false, held: false, phaseOperationId: config.operationId,
      url: config.api, expiresAt: descriptor.sessionExpiresAt, apiPid: process.pid };
    socket = createServer(c => c.once('data', () => c.end(JSON.stringify({ ok: true, result: current }))));
    await new Promise<void>((done, reject) => { socket!.once('error', reject); socket!.listen(descriptor.socket, done); });
    await chmod(descriptor.socket, 0o600);
    const identity = { sourceToolCeiling: 'server-read-v1', pid: process.pid, head,
      cwd: process.cwd(), port: descriptor.apiPort, sessionId: descriptor.sessionId,
      log: directory + '/api.log', execPath: process.execPath,
      argv: ['--import', '/synthetic/loader.mjs', 'server.ts'], loader: '/synthetic/loader.mjs' };
    await writeFile(identity.log, 'WORKER_LEASE_UNAVAILABLE: API-only standby', { mode: 0o600 });
    vi.mocked(execFileSync).mockReturnValue([identity.execPath, ...identity.argv].join(' '));
    const saveIdentity = async (size?: number) => {
      const bytes = Buffer.from(JSON.stringify(identity));
      await writeFile(directory + '/api-identity.json', Buffer.concat([bytes, Buffer.alloc((size ?? bytes.length) - bytes.length, ' ')]), { mode: 0o600 });
    };
    await saveIdentity();
    const query = vi.fn().mockResolvedValue([[{ db: descriptor.schema, uuid: descriptor.uuid }]]);
    const verify = async (size?: number, hash?: string) => {
      const compact = Buffer.from(JSON.stringify(descriptor));
      const bytes = Buffer.concat([compact, Buffer.alloc((size ?? compact.length) - compact.length, ' ')]);
      const file = directory + '/descriptor.json';
      await writeFile(file, bytes, { mode: 0o600 });
      return verifySessionApi({ query } as unknown as Pool, config, head, file, hash ?? bytesHash(bytes));
    };
    return { verify, saveIdentity, query, descriptor, identity, current };
  }
  it('accepts all 322 dependencies in a complete descriptor larger than 64 KiB', async () => {
    const f = await fixture();
    expect(Buffer.byteLength(JSON.stringify(f.descriptor))).toBeGreaterThan(65536);
    expect(Object.keys(f.descriptor.files)).toHaveLength(322);
    expect((await f.verify()).pid).toBe(process.pid);
  });
  it('accepts prior 256KiB and complete 1MiB descriptors', async () => {
    const f = await fixture();
    expect((await f.verify(262144)).pid).toBe(process.pid);
    expect((await f.verify(1048576)).pid).toBe(process.pid);
  });
  it('rejects 1048577 bytes before SQL', async () => {
    const f = await fixture();
    await expect(f.verify(1048577)).rejects.toThrow('SESSION_API_REJECTED');
    expect(f.query).not.toHaveBeenCalled();
  });
  it('retains the API identity boundary at 65536/65537 bytes', async () => {
    const f = await fixture();
    await f.saveIdentity(65536);
    expect((await f.verify()).pid).toBe(process.pid);
    await f.saveIdentity(65537);
    await expect(f.verify()).rejects.toThrow('SESSION_API_REJECTED');
  });
  it('rejects complete descriptor hash and binding mismatches before SQL', async () => {
    const f = await fixture();
    await expect(f.verify(undefined, '0'.repeat(64))).rejects.toThrow('SESSION_API_REJECTED');
    f.descriptor.head = 'b'.repeat(40);
    await expect(f.verify()).rejects.toThrow('SESSION_API_REJECTED');
    expect(f.query).not.toHaveBeenCalled();
  });
  it('still rejects held lease, changed API identity and oversized socket status', async () => {
    const f = await fixture();
    f.current.held = true;
    await expect(f.verify()).rejects.toThrow('SESSION_API_REJECTED');
    f.current.held = false;
    f.identity.head = 'b'.repeat(40); await f.saveIdentity();
    await expect(f.verify()).rejects.toThrow('SESSION_API_REJECTED');
    f.identity.head = f.descriptor.head; await f.saveIdentity();
    Object.assign(f.current, { padding: 'x'.repeat(65537) });
    await expect(f.verify()).rejects.toThrow('SESSION_API_REJECTED');
  });
});
