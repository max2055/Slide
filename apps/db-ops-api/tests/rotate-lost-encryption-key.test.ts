import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import mysql from 'mysql2/promise';
import { afterAll, describe, expect, it } from 'vitest';
import {
  REFUSAL_MESSAGE,
  USAGE,
  captureInvocationSecrets,
  invocationIsAuthorized,
  parseRecoveryArgs,
  projectEnvAssignments,
} from '../../../scripts/recovery/rotate-lost-encryption-key.ts';

const repoRoot = resolve(import.meta.dirname, '../../..');
const scriptPath = resolve(repoRoot, 'scripts/recovery/rotate-lost-encryption-key.ts');
const tsxPath = resolve(repoRoot, 'apps/db-ops-api/node_modules/.bin/tsx');
const PHRASE = 'CONFIRM_LOST_KEY_ROTATION';
const FILE_KEY = `f${'1'.repeat(31)}`;
const EXPLICIT_KEY = `e${'2'.repeat(31)}`;
const port = Number(process.env.MAX313_TEST_MYSQL_PORT || 0);
const password = process.env.MAX313_TEST_MYSQL_PASSWORD ?? '';

function redact(text: string): string {
  return [PHRASE, FILE_KEY, EXPLICIT_KEY, 'short-key', password].filter((secret) => secret !== '').reduce((output, secret) => output.split(secret).join('[redacted]'), text);
}

describe('lost-key rotation invocation gate', () => {
  it('reads confirmation and the new key only from the supplied environment', () => {
    expect(captureInvocationSecrets({ SLIDE_ROTATE_LOST_ENCRYPTION_KEY: PHRASE, ENCRYPTION_KEY: EXPLICIT_KEY })).toEqual({
      confirmation: PHRASE,
      encryptionKey: EXPLICIT_KEY,
    });
    expect(invocationIsAuthorized({ confirmation: PHRASE, encryptionKey: EXPLICIT_KEY })).toBe(true);
  });

  it('rejects absent, empty, case, space, prefix, and suffix confirmation before any file value matters', () => {
    const rejected = [
      { confirmation: undefined, encryptionKey: EXPLICIT_KEY },
      { confirmation: '', encryptionKey: EXPLICIT_KEY },
      { confirmation: PHRASE.toLowerCase(), encryptionKey: EXPLICIT_KEY },
      { confirmation: `${PHRASE} `, encryptionKey: EXPLICIT_KEY },
      { confirmation: ` ${PHRASE}`, encryptionKey: EXPLICIT_KEY },
      { confirmation: `X${PHRASE}`, encryptionKey: EXPLICIT_KEY },
      { confirmation: `${PHRASE}X`, encryptionKey: EXPLICIT_KEY },
      { confirmation: `"${PHRASE}"`, encryptionKey: EXPLICIT_KEY },
      { confirmation: PHRASE, encryptionKey: undefined },
      { confirmation: PHRASE, encryptionKey: '' },
    ];
    for (const secrets of rejected) expect(invocationIsAuthorized(secrets)).toBe(false);
    expect(REFUSAL_MESSAGE.includes(PHRASE)).toBe(false);
    expect(REFUSAL_MESSAGE.includes(EXPLICIT_KEY)).toBe(false);
    expect(USAGE.includes(PHRASE)).toBe(false);
  });

  it('ignores invocation-only keys in the project env file, including variants, and keeps the first database value', () => {
    const text = [
      'DB_HOST=db-from-file',
      'DB_HOST=later-host',
      `SLIDE_ROTATE_LOST_ENCRYPTION_KEY=${PHRASE}`,
      `ENCRYPTION_KEY=${FILE_KEY}`,
      `encryption_key=${FILE_KEY}`,
      `export SLIDE_ROTATE_LOST_ENCRYPTION_KEY=${PHRASE}`,
      `SLIDE_ROTATE_LOST_ENCRYPTION_KEY=${PHRASE} # note`,
      'DB_PASSWORD=',
      'DB_NAME=scratch',
    ].join('\n');
    const assigned = projectEnvAssignments(text, {});
    expect(assigned.DB_HOST).toBe('db-from-file');
    expect(assigned.DB_PASSWORD).toBe('');
    expect(assigned.DB_NAME).toBe('scratch');
    expect(assigned.SLIDE_ROTATE_LOST_ENCRYPTION_KEY).toBeUndefined();
    expect(assigned.ENCRYPTION_KEY).toBeUndefined();
    expect(JSON.stringify(assigned).includes(PHRASE)).toBe(false);
    expect(JSON.stringify(assigned).includes(FILE_KEY)).toBe(false);
    expect(projectEnvAssignments(`DB_HOST=from-file\nENCRYPTION_KEY=${FILE_KEY}`, { DB_HOST: 'explicit-host' })).toEqual({});
  });

  it('accepts only an optional env file argument', () => {
    expect(parseRecoveryArgs(['node', 'script'], '/repo/scripts/recovery').envFile).toBe('/repo/apps/db-ops-api/.env');
    expect(parseRecoveryArgs(['node', 'script', '--env-file', 'custom.env'], '/repo/scripts/recovery').envFile).toBe(resolve('custom.env'));
    expect(() => parseRecoveryArgs(['node', 'script', '--force'], '/repo/scripts/recovery')).toThrow(USAGE);
    expect(() => parseRecoveryArgs(['node', 'script', '--env-file'], '/repo/scripts/recovery')).toThrow(USAGE);
    expect(() => parseRecoveryArgs(['node', 'script', '--env-file', '--confirm'], '/repo/scripts/recovery')).toThrow(USAGE);
  });

  it('refuses a bare run before the project env file can authorize it', () => {
    const directory = mkdtempSync(join(tmpdir(), 'max313-bare-'));
    try {
      writeFileSync(join(directory, '.env'), `SLIDE_ROTATE_LOST_ENCRYPTION_KEY=${PHRASE}\nENCRYPTION_KEY=${FILE_KEY}\n`);
      const result = spawnSync(tsxPath, [scriptPath], {
        cwd: directory,
        env: { PATH: process.env.PATH ?? '', HOME: directory },
        encoding: 'utf8',
        timeout: 30000,
      });
      const output = redact(`${result.stdout}\n${result.stderr}`);
      expect(result.status, output).toBe(1);
      expect(output).toContain(REFUSAL_MESSAGE);
      expect(output.includes('[redacted]')).toBe(false);
      expect(output.includes('ENOENT')).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('does not statically import the project env loader', () => {
    const beforeMain = readFileSync(scriptPath, 'utf8').split('async function main')[0] ?? '';
    expect(beforeMain.includes('db-connection')).toBe(false);
    expect(beforeMain.includes('mysql2')).toBe(false);
    expect(beforeMain.includes('dotenv')).toBe(false);
  });
});

// MAX-313 independent review: exercise the real entry point beyond the gate.
// The listeners never send a MySQL handshake, so no SQL can be executed.
describe('lost-key rotation target selection', () => {
  it.each(['selected file', 'default file', 'process override', 'no confirmation', 'invalid key'])(
    'uses only the intended target: %s', async (mode) => {
      const directory = realpathSync(mkdtempSync(join(tmpdir(), 'max313-target-')));
      const connections = [0, 0, 0];
      const received = [0, 0, 0];
      const listeners = connections.map((_, index) => createServer((socket) => {
        connections[index]! += 1;
        socket.on('data', (data) => { received[index]! += data.length; });
        socket.on('error', () => {});
        socket.end();
      }));
      try {
        const ports = await Promise.all(listeners.map((server) => new Promise<number>((resolvePort, reject) => {
          server.once('error', reject);
          server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            if (!address || typeof address === 'string') return reject(new Error('TCP address missing'));
            resolvePort(address.port);
          });
        })));
        // Copy the actual source into an isolated project so the default-file
        // test cannot read or modify a developer's platform configuration.
        for (const path of [
          'scripts/recovery/rotate-lost-encryption-key.ts',
          'apps/db-ops-api/src/db-connection.ts',
          'apps/db-ops-api/src/config/security-config.ts',
          'apps/db-ops-api/src/credential-rotation.ts',
        ]) {
          const destination = join(directory, path);
          mkdirSync(dirname(destination), { recursive: true });
          copyFileSync(join(repoRoot, path), destination);
        }
        writeFileSync(join(directory, 'package.json'), '{"type":"module"}');
        symlinkSync(join(repoRoot, 'apps/db-ops-api/node_modules'), join(directory, 'apps/db-ops-api/node_modules'));
        const cwd = join(directory, 'cwd');
        mkdirSync(cwd);
        const settings = (target: number) => [
          'DB_HOST=127.0.0.1', `DB_PORT=${ports[target]}`, 'DB_USER=synthetic',
          'DB_PASSWORD=synthetic', 'DB_NAME=synthetic',
          `SLIDE_ROTATE_LOST_ENCRYPTION_KEY=${PHRASE}`, `ENCRYPTION_KEY=${FILE_KEY}`,
        ].join('\n');
        writeFileSync(join(cwd, '.env'), settings(0));
        writeFileSync(join(cwd, 'selected.env'), settings(1));
        writeFileSync(join(directory, 'apps/db-ops-api/.env'), settings(1));
        const audit = join(directory, 'audit.json');
        const env: Record<string, string> = {
          PATH: process.env.PATH ?? '', HOME: directory,
          ENCRYPTION_KEY: mode === 'invalid key' ? 'short-key' : EXPLICIT_KEY,
          SLIDE_CREDENTIAL_ROTATION_AUDIT_PATH: audit,
        };
        if (mode !== 'no confirmation') env.SLIDE_ROTATE_LOST_ENCRYPTION_KEY = PHRASE;
        if (mode === 'process override') {
          env.DB_HOST = '127.0.0.1';
          env.DB_PORT = String(ports[2]);
          env.DOTENV_CONFIG_OVERRIDE = 'true';
        }
        const args = mode === 'default file' ? [] : ['--env-file', 'selected.env'];
        const child = spawn(tsxPath, [join(directory, 'scripts/recovery/rotate-lost-encryption-key.ts'), ...args], { cwd, env });
        let output = '';
        child.stdout.on('data', (data) => { output += data; });
        child.stderr.on('data', (data) => { output += data; });
        const code = await new Promise<number | null>((resolveCode, reject) => {
          const timer = setTimeout(() => { child.kill('SIGTERM'); }, 10000);
          child.once('error', (error) => { clearTimeout(timer); reject(error); });
          child.once('close', (status) => { clearTimeout(timer); resolveCode(status); });
        });
        const safeOutput = redact(output);
        expect(code, safeOutput).toBe(1);
        expect(connections, safeOutput).toEqual(
          mode === 'no confirmation' || mode === 'invalid key' ? [0, 0, 0]
            : mode === 'process override' ? [0, 0, 1] : [0, 1, 0],
        );
        expect(received).toEqual([0, 0, 0]);
        expect(existsSync(audit)).toBe(false);
        expect(safeOutput).not.toContain('[redacted]');
        if (mode === 'no confirmation') expect(safeOutput).toContain(REFUSAL_MESSAGE);
        if (mode === 'invalid key') expect(safeOutput).toContain('ENCRYPTION_KEY must encode exactly 32 bytes');
      } finally {
        await Promise.all(listeners.map((server) => new Promise<void>((done) => server.close(() => done()))));
        rmSync(directory, { recursive: true, force: true });
      }
    }, 20000,
  );
});

describe.skipIf(!port)('lost-key rotation writes nothing without this invocation', () => {
  const database = `max313_${randomBytes(4).toString('hex')}`;
  const directory = mkdtempSync(join(tmpdir(), 'max313-'));
  const auditPath = join(directory, 'audit.json');
  let admin: mysql.Connection | undefined;
  let initialDigest = '';

  async function snapshot(): Promise<string> {
    const connection = admin;
    if (!connection) throw new Error('admin connection missing');
    const [instances] = await connection.query('SELECT id, password_encrypted, connection_string, status, health_status FROM database_instances');
    const [servers] = await connection.query('SELECT id, credential_encrypted, collection_enabled, status, host_key_fingerprint FROM servers');
    const [providers] = await connection.query('SELECT id, api_key_encrypted, deployment_type, enabled, is_default FROM llm_providers');
    const [backups] = await connection.query('SELECT id, api_key_encrypted FROM llm_providers_backup');
    const [channels] = await connection.query('SELECT id, config, enabled FROM notification_channels');
    const [audits] = await connection.query('SELECT table_name FROM write_audit');
    return JSON.stringify({ instances, servers, providers, backups, channels, audits });
  }

  afterAll(async () => {
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
      await admin.end();
    }
    rmSync(directory, { recursive: true, force: true });
  });

  it('keeps the controlled database unchanged when the file holds the confirmation and key', async () => {
    admin = await mysql.createConnection({ host: '127.0.0.1', port, user: 'root', password, multipleStatements: true });
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
    await admin.query(`USE \`${database}\``);
    await admin.query(`
      CREATE TABLE database_instances (
        id INT PRIMARY KEY,
        password_encrypted TEXT NOT NULL,
        connection_string TEXT NULL,
        status VARCHAR(32) NOT NULL,
        health_status VARCHAR(32) NOT NULL
      );
      CREATE TABLE servers (
        id INT PRIMARY KEY,
        credential_encrypted TEXT NOT NULL,
        collection_enabled TINYINT NOT NULL,
        status VARCHAR(32) NOT NULL,
        host_key_fingerprint VARCHAR(255) NULL
      );
      CREATE TABLE llm_providers (
        id INT PRIMARY KEY,
        api_key_encrypted TEXT NULL,
        deployment_type VARCHAR(32) NOT NULL,
        enabled TINYINT NOT NULL,
        is_default TINYINT NOT NULL
      );
      CREATE TABLE llm_providers_backup (
        id INT PRIMARY KEY,
        api_key_encrypted TEXT NULL
      );
      CREATE TABLE notification_channels (
        id INT PRIMARY KEY,
        config JSON NOT NULL,
        enabled TINYINT NOT NULL
      );
      CREATE TABLE write_audit (
        id INT AUTO_INCREMENT PRIMARY KEY,
        table_name VARCHAR(64) NOT NULL
      );
      CREATE TRIGGER max313_u_instances BEFORE UPDATE ON database_instances FOR EACH ROW INSERT INTO write_audit (table_name) VALUES ('database_instances');
      CREATE TRIGGER max313_u_servers BEFORE UPDATE ON servers FOR EACH ROW INSERT INTO write_audit (table_name) VALUES ('servers');
      CREATE TRIGGER max313_u_providers BEFORE UPDATE ON llm_providers FOR EACH ROW INSERT INTO write_audit (table_name) VALUES ('llm_providers');
      CREATE TRIGGER max313_u_backups BEFORE UPDATE ON llm_providers_backup FOR EACH ROW INSERT INTO write_audit (table_name) VALUES ('llm_providers_backup');
      CREATE TRIGGER max313_u_channels BEFORE UPDATE ON notification_channels FOR EACH ROW INSERT INTO write_audit (table_name) VALUES ('notification_channels');
      INSERT INTO database_instances VALUES (1, 'cipher-instance-keep', 'mysql://synthetic.example/db', 'active', 'healthy');
      INSERT INTO servers VALUES (1, 'cipher-server-keep', 1, 'online', 'aa:bb');
      INSERT INTO llm_providers VALUES (1, 'cipher-provider-keep', 'cloud', 1, 1);
      INSERT INTO llm_providers_backup VALUES (1, 'cipher-backup-keep');
      INSERT INTO notification_channels VALUES (1, JSON_OBJECT('secret', 'channel-secret-keep', 'name', 'ops'), 1);
    `);
    initialDigest = createHash('sha256').update(await snapshot()).digest('hex');
    const envFile = join(directory, '.env');
    writeFileSync(envFile, [
      `SLIDE_ROTATE_LOST_ENCRYPTION_KEY=${PHRASE}`,
      `ENCRYPTION_KEY=${FILE_KEY}`,
      'DB_HOST=127.0.0.1',
      `DB_PORT=${port}`,
      'DB_USER=root',
      `DB_PASSWORD=${password}`,
      `DB_NAME=${database}`,
      `SLIDE_CREDENTIAL_ROTATION_AUDIT_PATH=${auditPath}`,
    ].join('\n'));

    const cases = [
      { name: 'file only', env: {} as Record<string, string>, args: ['--env-file', envFile], expectOutput: REFUSAL_MESSAGE },
      { name: 'confirmation without a new key', env: { SLIDE_ROTATE_LOST_ENCRYPTION_KEY: PHRASE }, args: ['--env-file', envFile], expectOutput: REFUSAL_MESSAGE },
      { name: 'new key without confirmation', env: { ENCRYPTION_KEY: EXPLICIT_KEY }, args: ['--env-file', envFile], expectOutput: REFUSAL_MESSAGE },
      { name: 'lowercase confirmation', env: { SLIDE_ROTATE_LOST_ENCRYPTION_KEY: PHRASE.toLowerCase(), ENCRYPTION_KEY: EXPLICIT_KEY }, args: ['--env-file', envFile], expectOutput: REFUSAL_MESSAGE },
      { name: 'padded confirmation', env: { SLIDE_ROTATE_LOST_ENCRYPTION_KEY: `${PHRASE} `, ENCRYPTION_KEY: EXPLICIT_KEY }, args: ['--env-file', envFile], expectOutput: REFUSAL_MESSAGE },
      { name: 'prefixed confirmation', env: { SLIDE_ROTATE_LOST_ENCRYPTION_KEY: `X${PHRASE}`, ENCRYPTION_KEY: EXPLICIT_KEY }, args: ['--env-file', envFile], expectOutput: REFUSAL_MESSAGE },
      { name: 'empty explicit key', env: { SLIDE_ROTATE_LOST_ENCRYPTION_KEY: PHRASE, ENCRYPTION_KEY: '' }, args: ['--env-file', envFile], expectOutput: REFUSAL_MESSAGE },
      { name: 'explicit key is not a valid encryption key', env: { SLIDE_ROTATE_LOST_ENCRYPTION_KEY: PHRASE, ENCRYPTION_KEY: 'short-key' }, args: ['--env-file', envFile], expectOutput: 'ENCRYPTION_KEY must encode exactly 32 bytes' },
      { name: 'unknown argument', env: {}, args: ['--force', '--env-file', envFile], expectOutput: USAGE },
    ];

    for (const item of cases) {
      const result = spawnSync(tsxPath, [scriptPath, ...item.args], {
        cwd: directory,
        env: { PATH: process.env.PATH ?? '', HOME: directory, ...item.env },
        encoding: 'utf8',
        timeout: 30000,
      });
      const output = redact(`${result.stdout}\n${result.stderr}`);
      expect(result.status, `${item.name} ${output}`).toBe(1);
      expect(output, item.name).toContain(item.expectOutput);
      expect(output.includes('[redacted]'), item.name).toBe(false);
      expect(output.includes(database), item.name).toBe(false);
      const digest = createHash('sha256').update(await snapshot()).digest('hex');
      expect(digest, item.name).toBe(initialDigest);
      expect(existsSync(auditPath), item.name).toBe(false);
    }
  });
});
