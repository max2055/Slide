/**
 * MAX-238 / NATIVE-CONFIGURATION-FLOW-R3 — the disposable-database ownership rule.
 *
 * These are controlled stand-ins for the SQL server; the real MySQL chain is
 * proven separately. What they bind is the decision logic: only a schema created
 * by this exact nonce on this exact server may be dropped, and every unknown
 * state is a non-zero refusal that keeps the handle.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  OWNED_FIXTURE_FORMAT, createOwnedDatabase, dropOwnedDatabase, generateRunNonce, ownedDatabaseName,
} from './owned-fixture.js';

const NONCE = 'abcdef0123456789';

function fakeServer(options: {
  schemas?: string[]; serverUuid?: string; port?: number; createFails?: boolean;
  dropLeavesSchema?: boolean;
} = {}) {
  const schemas = new Set(options.schemas ?? []);
  const statements: string[] = [];
  const server = { server_uuid: options.serverUuid ?? 'uuid-run-1', hostname: 'fixture-host', port: options.port ?? 13361 };
  return {
    schemas, statements,
    async query(sql: string, values: unknown[] = []): Promise<[unknown, unknown]> {
      const key = sql.replace(/\s+/g, ' ').trim();
      statements.push(key);
      if (/^SELECT @@server_uuid/.test(key)) return [[server], []];
      if (/^SELECT SCHEMA_NAME/.test(key)) return [schemas.has(String(values[0])) ? [{ name: values[0] }] : [], []];
      if (/^CREATE DATABASE/.test(key)) {
        if (options.createFails) throw new Error('fixture create failed');
        const name = key.match(/`([^`]+)`/)![1];
        schemas.add(name);
        return [{}, []];
      }
      if (/^DROP DATABASE/.test(key)) {
        if (!options.dropLeavesSchema) schemas.delete(key.match(/`([^`]+)`/)![1]);
        return [{}, []];
      }
      throw new Error(`unexpected SQL: ${key}`);
    },
  };
}

let dir: string | null = null;
const handleDir = () => dir ??= mkdtempSync(join(process.cwd(), '.max238-handles-test-'));
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = null; });

describe('owned disposable database', () => {
  it('derives the name from a run-random nonce, never a PID or a prefix', () => {
    expect(ownedDatabaseName(NONCE, 'first')).toBe(`max238_first_${NONCE}`);
    expect(generateRunNonce()).toMatch(/^[a-z0-9]{16}$/);
    expect(() => ownedDatabaseName('123', 'first')).toThrow(/run-random nonce/);
    expect(() => ownedDatabaseName(NONCE, 'First-Purpose')).toThrow(/purpose/);
  });

  it('records a handle before creating and cleans up only the exact schema', async () => {
    const server = fakeServer();
    const owned = await createOwnedDatabase(server, { nonce: NONCE, purpose: 'first', handleDir: handleDir() });
    // CREATE never follows a DROP, and the handle existed before it.
    expect(server.statements[0]).toMatch(/^SELECT @@server_uuid/);
    expect(server.statements.some(statement => /^DROP/.test(statement))).toBe(false);
    const handle = JSON.parse(readFileSync(owned.handlePath, 'utf8'));
    expect(handle).toMatchObject({ format: OWNED_FIXTURE_FORMAT, nonce: NONCE, purpose: 'first',
      database: owned.database, state: 'created', server: { server_uuid: 'uuid-run-1', port: 13361 } });
    await owned.drop();
    expect(server.schemas.has(owned.database)).toBe(false);
    expect(existsSync(owned.handlePath)).toBe(false);
  });

  it('refuses to reuse a nonce whose handle already exists', async () => {
    const server = fakeServer();
    const first = await createOwnedDatabase(server, { nonce: NONCE, purpose: 'first', handleDir: handleDir() });
    await expect(createOwnedDatabase(server, { nonce: NONCE, purpose: 'first', handleDir: handleDir() }))
      .rejects.toThrow(/already recorded/);
    await first.drop();
  });

  it('refuses to drop on another server even with a valid-looking handle', async () => {
    const home = fakeServer();
    const owned = await createOwnedDatabase(home, { nonce: NONCE, purpose: 'first', handleDir: handleDir() });
    const neighbour = fakeServer({ serverUuid: 'uuid-neighbour', schemas: [owned.database] });
    await expect(dropOwnedDatabase(neighbour, { nonce: NONCE, purpose: 'first', handleDir: handleDir() }))
      .rejects.toThrow(/does not describe this run on this server/);
    // The neighbour's schema is untouched and the handle survives.
    expect(neighbour.schemas.has(owned.database)).toBe(true);
    expect(existsSync(owned.handlePath)).toBe(true);
    await owned.drop();
  });

  it('keeps the handle and refuses when the drop cannot be verified', async () => {
    const server = fakeServer({ dropLeavesSchema: true });
    const owned = await createOwnedDatabase(server, { nonce: NONCE, purpose: 'first', handleDir: handleDir() });
    await expect(owned.drop()).rejects.toThrow(/FAILED to verify removal/);
    expect(existsSync(owned.handlePath)).toBe(true);
  });

  it('a planned handle is never dropped', async () => {
    const server = fakeServer();
    const owned = await createOwnedDatabase(server, { nonce: NONCE, purpose: 'first', handleDir: handleDir() });
    const raw = JSON.parse(readFileSync(owned.handlePath, 'utf8'));
    writeFileSync(owned.handlePath, JSON.stringify({ ...raw, state: 'planned' }));
    await expect(owned.drop()).rejects.toThrow(/state is planned/);
    expect(existsSync(owned.handlePath)).toBe(true);
    writeFileSync(owned.handlePath, JSON.stringify({ ...raw, state: 'created' }));
    await owned.drop();
  });
});
