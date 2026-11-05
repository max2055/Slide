import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

const script = resolve(import.meta.dirname, '../../../scripts/recovery/rotate-lost-encryption-key.ts');
const require = createRequire(import.meta.url);

// Execute the unchanged CLI orchestration; only OS/filesystem/SQL I/O is simulated.
async function run(env: Record<string, string | undefined>, home: () => string) {
  const homedir = vi.fn(home);
  const db = { query: vi.fn(async () => [[], []]), execute: vi.fn(), beginTransaction: vi.fn(), commit: vi.fn(), rollback: vi.fn(), end: vi.fn() };
  const createConnection = vi.fn(async () => db);
  const mkdir = vi.fn();
  const writeFile = vi.fn();
  const dependencies: Record<string, object> = {
    'node:os': { homedir },
    'node:fs/promises': { readFile: async () => '', mkdir, writeFile },
    '../../apps/db-ops-api/src/config/security-config.js': { requireEncryptionKey: () => {} },
    '../../apps/db-ops-api/src/credential-rotation.js': { LOST_KEY_ROTATION_SENTINEL: 'marker' },
    '../../apps/db-ops-api/src/db-connection.js': { encryptData: () => 'encrypted-marker' },
    '../../apps/db-ops-api/node_modules/mysql2/promise.js': { createConnection },
  };
  const source = readFileSync(script, 'utf8').replaceAll('import.meta.dirname', JSON.stringify(resolve(script, '..')))
    .replaceAll('import.meta.url', JSON.stringify(`file://${script}`));
  const code = ts.transpileModule(`${source}\nglobalThis.result = main();`, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const sandbox = {
    require: (id: string) => dependencies[id] ?? require(id.startsWith('.') ? resolve(script, '..', id) : id),
    exports: {}, console: { log: vi.fn(), error: vi.fn() },
    process: { argv: ['node'], env: { ENCRYPTION_KEY: 'a'.repeat(32), SLIDE_ROTATE_LOST_ENCRYPTION_KEY: 'CONFIRM_LOST_KEY_ROTATION', ...env } },
    result: undefined as Promise<void> | undefined,
  };
  runInNewContext(code, sandbox);
  let error: unknown;
  try { await sandbox.result; } catch (caught) { error = caught; }
  return { error, homedir, mkdir, writeFile, createConnection, db };
}

describe('MAX-326 / #695 recovery audit directory', () => {
  it.each([undefined, ''])('uses the OS home when HOME=%s', async (HOME) => {
    const result = await run({ HOME }, () => '/os-user');
    expect(result.error).toBeUndefined();
    expect(result.writeFile.mock.calls[0]?.[0]).toBe('/os-user/.config/slide/recovery/lost-encryption-key-rotation.json');
    expect(result.db.commit).toHaveBeenCalledOnce();
  });

  it.each(['/explicit/audit.json', 'relative/audit.json'])('keeps configured path %s even without an OS home', async (path) => {
    const result = await run({ SLIDE_CREDENTIAL_ROTATION_AUDIT_PATH: path }, () => { throw new Error('no user'); });
    expect(result.error).toBeUndefined();
    expect(result.writeFile.mock.calls[0]?.[0]).toBe(resolve(path));
    expect(result.homedir).not.toHaveBeenCalled();
  });

  it('treats an empty configured path as the default', async () => {
    const result = await run({ SLIDE_CREDENTIAL_ROTATION_AUDIT_PATH: '', HOME: '/os-user' }, () => '/os-user');
    expect(result.error).toBeUndefined();
    expect(result.writeFile.mock.calls[0]?.[0]).toBe('/os-user/.config/slide/recovery/lost-encryption-key-rotation.json');
  });

  it.each(['empty', 'blank', 'throws'])('refuses before connecting or writing when OS home %s', async (mode) => {
    const result = await run({ HOME: '' }, () => { if (mode === 'throws') throw new Error('no user'); return mode === 'blank' ? '  ' : ''; });
    expect(String(result.error)).toContain('Cannot determine the recovery audit directory');
    expect(String(result.error)).toContain('SLIDE_CREDENTIAL_ROTATION_AUDIT_PATH');
    expect(result.createConnection).not.toHaveBeenCalled();
    expect(result.mkdir).not.toHaveBeenCalled();
    expect(result.writeFile).not.toHaveBeenCalled();
  });
});
