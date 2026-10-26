/**
 * Provider 配置备份/恢复管理员入口（issue #244）。
 *
 *   pnpm provider-config backup --out <file>
 *   pnpm provider-config verify <file> [--against-db] [--check-connections all|name,...]
 *   pnpm provider-config restore <file> [--dry-run] [--check-connections all|name,...]
 *   pnpm provider-config rollback <snapshot-file>
 *
 * The artifact never contains api keys, ciphertext, DB passwords or URL
 * credentials. Output contains counts and issue codes only.
 */
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import mysql, { type Pool } from 'mysql2/promise';
import { ProviderConfigBackupError } from './provider-config-backup.js';
import {
  backupProviderConfiguration,
  defaultBackupDirectory,
  inspectProviderArtifact,
  restoreProviderConfiguration,
  verifyProviderConfiguration,
} from './provider-config-backup-service.js';

const COMMANDS = ['backup', 'verify', 'restore', 'rollback'] as const;
type Command = typeof COMMANDS[number];

const VALUE_FLAGS: Record<Command, Set<string>> = {
  backup: new Set(['out', 'actor', 'database']),
  verify: new Set(['sha256', 'actor', 'database', 'check-connections']),
  restore: new Set(['sha256', 'actor', 'database', 'check-connections']),
  rollback: new Set(['sha256', 'actor', 'database', 'check-connections']),
};
const BOOLEAN_FLAGS: Record<Command, Set<string>> = {
  backup: new Set(['force']),
  verify: new Set(['against-db']),
  restore: new Set(['dry-run']),
  rollback: new Set([]),
};

function usage(): never {
  process.stderr.write(`usage:
  provider-config backup --out <file> [--force] [--actor <name>] [--database <name>]
  provider-config verify <file> [--against-db] [--sha256 <hex>] [--check-connections all|name,...]
  provider-config restore <file> [--dry-run] [--sha256 <hex>] [--check-connections all|name,...]
  provider-config rollback <snapshot-file> [--check-connections all|name,...]
`);
  process.exit(2);
}

function parseArguments(argv: string[]): {
  command: Command;
  file?: string;
  values: Record<string, string>;
  booleans: Set<string>;
} {
  const command = argv[0] as Command | undefined;
  if (!command || !COMMANDS.includes(command)) usage();
  const values: Record<string, string> = {};
  const booleans = new Set<string>();
  const positional: string[] = [];
  for (let index = 1; index < argv.length; index++) {
    const argument = argv[index];
    if (!argument.startsWith('--')) {
      positional.push(argument);
      continue;
    }
    const name = argument.slice(2);
    if (VALUE_FLAGS[command].has(name)) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--') || !value.trim()) usage();
      values[name] = value;
      index++;
      continue;
    }
    if (BOOLEAN_FLAGS[command].has(name)) {
      booleans.add(name);
      continue;
    }
    usage();
  }
  if (command === 'backup') {
    if (positional.length > 0) usage();
    return { command, values, booleans };
  }
  if (positional.length !== 1) usage();
  return { command, file: positional[0], values, booleans };
}

async function loadProjectEnv(): Promise<void> {
  const envPath = resolve(import.meta.dirname, '../../.env');
  let text: string;
  try {
    text = await readFile(envPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2];
  }
}

function databaseName(values: Record<string, string>): string {
  return values.database || process.env.DB_NAME || 'db_ops_ai';
}

async function openPool(database: string): Promise<Pool> {
  return mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || '3306'),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database,
    connectionLimit: 3,
    decimalNumbers: true,
    timezone: 'Z',
    charset: 'utf8mb4',
  });
}

function connectionSelection(value: string | undefined): 'all' | string[] | undefined {
  if (!value) return undefined;
  if (value === 'all') return 'all';
  const names = value.split(',').map(name => name.trim()).filter(Boolean);
  if (names.length === 0) usage();
  return names;
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function safeMessage(error: unknown): string {
  if (error instanceof ProviderConfigBackupError) return error.message;
  return 'unexpected failure';
}

function exitCodeFor(error: unknown): number {
  if (!(error instanceof ProviderConfigBackupError)) return 1;
  if (/CHECKSUM|INVALID_ARTIFACT|UNSUPPORTED|SECRET_DETECTED|PATH_INSIDE_REPOSITORY|ARTIFACT_EXISTS|ARTIFACT_MISSING|BINDING_PROVIDER_MISSING/.test(error.code)) {
    return 3;
  }
  return 1;
}

async function run(command: Command, file: string | undefined, values: Record<string, string>, booleans: Set<string>): Promise<number> {
  const database = databaseName(values);
  const checkConnections = connectionSelection(values['check-connections']);
  const actor = values.actor;
  if (command === 'backup') {
    const stamp = new Date().toISOString().replace(/[-:.]/g, '');
    const out = resolve(values.out || join(defaultBackupDirectory(homedir()), `provider-config-${stamp}.json`));
    const pool = await openPool(database);
    try {
      const result = await backupProviderConfiguration(pool, out, {
        database,
        actor,
        force: booleans.has('force'),
      });
      print({ ok: true, command, ...result });
      return 0;
    } finally {
      await pool.end();
    }
  }

  if (!file) usage();
  const artifactPath = resolve(file);
  if (command === 'verify' && !booleans.has('against-db')) {
    const result = await inspectProviderArtifact(artifactPath, values.sha256);
    const metadata = await stat(artifactPath);
    print({
      ok: true,
      command,
      mode: 'artifact',
      artifact: {
        path: artifactPath,
        sha256: result.sha256,
        size_bytes: result.size_bytes,
        mode: (metadata.mode & 0o777).toString(8),
      },
      provider_count: result.document.providers.length,
      binding_count: result.document.scene_bindings.length,
      redactions: result.document.redactions.length,
      secret_findings: result.findings,
    });
    return 0;
  }

  const pool = await openPool(database);
  try {
    if (command === 'verify') {
      const result = await verifyProviderConfiguration(pool, artifactPath, {
        database,
        actor,
        expectedSha256: values.sha256,
        checkConnections,
      });
      const ok = result.verification?.ok ?? true;
      print({
        ok,
        command,
        mode: 'database',
        artifact: { path: artifactPath, sha256: result.sha256 },
        provider_count: result.provider_count,
        binding_count: result.binding_count,
        redactions: result.redactions,
        verification: result.verification,
        connections: result.connections,
        audit_id: result.audit_id,
      });
      return ok ? 0 : 4;
    }
    const result = await restoreProviderConfiguration(pool, artifactPath, {
      database,
      actor,
      expectedSha256: values.sha256,
      dryRun: booleans.has('dry-run'),
      rollback: command === 'rollback',
      checkConnections,
      now: new Date(),
    });
    const ok = result.verification?.ok ?? true;
    print({
      ok,
      command,
      applied: result.applied,
      dry_run: result.dry_run,
      plan: result.plan,
      snapshot: result.snapshot,
      verification: result.verification,
      connections: result.connections,
      audit_id: result.audit_id,
      verification_audit_id: result.verification_audit_id,
    });
    return ok ? 0 : 4;
  } finally {
    await pool.end();
  }
}

export async function main(argv: string[]): Promise<number> {
  const parsed = parseArguments(argv);
  await loadProjectEnv();
  try {
    return await run(parsed.command, parsed.file, parsed.values, parsed.booleans);
  } catch (error) {
    if (process.env.SLIDE_PROVIDER_CONFIG_DEBUG === '1' && error instanceof Error) {
      process.stderr.write(`${error.stack ?? error.message}\n`);
    }
    print({
      ok: false,
      command: parsed.command,
      code: error instanceof ProviderConfigBackupError ? error.code : 'PROVIDER_CONFIG_BACKUP_FAILED',
      message: safeMessage(error),
    });
    return exitCodeFor(error);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
