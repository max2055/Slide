import { mkdtemp, writeFile, chmod, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
