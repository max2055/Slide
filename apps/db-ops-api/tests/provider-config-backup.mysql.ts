/**
 * Provider configuration backup / restore drill (#244).
 *
 * Creates its own disposable schema, seeds two providers and a scene binding,
 * then runs: backup -> tamper -> restore -> verify -> rollback -> verify.
 * It never prints secrets and drops only its own schema.
 *
 * Run: pnpm --filter slide-api exec tsx tests/provider-config-backup.mysql.ts
 */
import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import mysql from 'mysql2/promise';
import { encryptData } from '../src/db-connection.js';
import { ProviderConfigBackupError } from '../src/llm/provider-config-backup.js';
import {
  assertOutsideRepository,
  backupProviderConfiguration,
  inspectProviderArtifact,
  restoreProviderConfiguration,
} from '../src/llm/provider-config-backup-service.js';

const schema = `slide_pcfg_${process.pid}_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
const config = {
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
};
const alphaSecret = 'sk-drill-alpha-0123456789';
let admin: mysql.Pool | undefined;
let pool: mysql.Pool | undefined;
let directory: string | undefined;
let created = false;

const query = async <T = any>(sql: string, values: any[] = []) => (await pool!.query(sql, values))[0] as T;

function expectCode(code: string) {
  return (error: unknown) => error instanceof ProviderConfigBackupError && error.code === code;
}

try {
  admin = mysql.createPool({ ...config, connectionLimit: 2 });
  await admin.query(`CREATE DATABASE \`${schema}\` CHARACTER SET utf8mb4`);
  created = true;
  pool = mysql.createPool({ ...config, database: schema, connectionLimit: 4, decimalNumbers: true, timezone: 'Z' });
  await query(`
    CREATE TABLE llm_providers (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT,
      name VARCHAR(50) NOT NULL,
      display_name VARCHAR(100) NOT NULL,
      deployment_type ENUM('local','cloud','api') NOT NULL DEFAULT 'api',
      api_format ENUM('openai-completions','anthropic-messages','google-generative-ai') DEFAULT NULL,
      api_key_encrypted VARCHAR(255) DEFAULT NULL,
      api_base_url VARCHAR(255) DEFAULT NULL,
      default_model VARCHAR(100) DEFAULT NULL,
      models_supported JSON DEFAULT NULL,
      context_window INT DEFAULT 4096,
      supports_function_call BOOLEAN DEFAULT FALSE,
      supports_vision BOOLEAN DEFAULT FALSE,
      input_cost_per_1k DECIMAL(10,6) DEFAULT 0,
      output_cost_per_1k DECIMAL(10,6) DEFAULT 0,
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      is_default BOOLEAN NOT NULL DEFAULT FALSE,
      temperature DECIMAL(3,2) DEFAULT 0.70,
      max_tokens INT DEFAULT 2048,
      timeout_ms INT DEFAULT 30000,
      rate_limit_per_minute INT DEFAULT 60,
      daily_quota INT DEFAULT NULL,
      daily_quota_alert_threshold INT DEFAULT 80,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id), UNIQUE KEY idx_name (name)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await query('CREATE TABLE llm_scene_bindings (scene VARCHAR(32) NOT NULL, provider_id INT NOT NULL, model VARCHAR(255) NOT NULL, updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, PRIMARY KEY (scene)) ENGINE=InnoDB');
  await query(`CREATE TABLE audit_log_entries (
    id VARCHAR(64) NOT NULL, event_type VARCHAR(64) NOT NULL, level ENUM('info','warning','error','critical') NOT NULL,
    user_id VARCHAR(64) DEFAULT NULL, username VARCHAR(255) DEFAULT NULL, user_role VARCHAR(32) DEFAULT NULL,
    action VARCHAR(128) NOT NULL, resource_type VARCHAR(64) DEFAULT NULL, resource_id VARCHAR(255) DEFAULT NULL,
    details_json JSON DEFAULT NULL, approval_request_id VARCHAR(64) DEFAULT NULL, client_ip VARCHAR(64) DEFAULT NULL,
    user_agent VARCHAR(512) DEFAULT NULL, result ENUM('success','failure','pending') NOT NULL,
    error_message VARCHAR(1000) DEFAULT NULL, timestamp_ms BIGINT UNSIGNED NOT NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), PRIMARY KEY (id)) ENGINE=InnoDB`);

  const models = JSON.stringify([
    { id: 'deepseek-chat', name: 'DeepSeek Chat' },
    { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner' },
  ]);
  await query(`INSERT INTO llm_providers
    (name, display_name, deployment_type, api_format, api_key_encrypted, api_base_url, default_model, models_supported,
     context_window, supports_function_call, supports_vision, enabled, is_default, max_tokens)
    VALUES ('alpha', 'Alpha Provider', 'api', 'openai-completions', ?, 'https://api.deepseek.com/v1', 'deepseek-chat', ?,
      128000, TRUE, FALSE, TRUE, TRUE, 2048)`, [encryptData(alphaSecret), models]);
  await query(`INSERT INTO llm_providers
    (name, display_name, deployment_type, api_format, api_key_encrypted, api_base_url, default_model, models_supported,
     context_window, supports_function_call, enabled, is_default)
    VALUES ('beta', 'Beta Provider', 'api', 'openai-completions', NULL,
      'https://user:pa55@api.example.test/v1?api_key=hidden&region=cn', 'deepseek-chat', ?, 128000, TRUE, FALSE, FALSE)`, [models]);
  await query(`INSERT INTO llm_providers
    (name, display_name, deployment_type, api_format, enabled, is_default)
    VALUES ('gamma', 'Gamma Local', 'local', NULL, FALSE, FALSE)`);
  await query("INSERT INTO llm_scene_bindings (scene, provider_id, model) VALUES ('chat', 1, 'deepseek-chat'), ('sql_analysis', 1, 'deepseek-chat'), ('fault_diagnosis', 999, 'gone')");

  directory = await mkdtemp(join(tmpdir(), 'slide-provider-backup-'));
  const artifactPath = join(directory, 'provider-config.json');
  const backupAt = new Date('2026-10-25T08:00:00.000Z');
  const backup = await backupProviderConfiguration(pool, artifactPath, { database: schema, actor: 'drill', now: backupAt });
  assert.equal(backup.provider_count, 3);
  assert.equal(backup.binding_count, 3);
  assert.equal(backup.redactions, 2);
  assert.equal(backup.artifact.mode, '600');
  const artifactText = await readFile(artifactPath, 'utf8');
  assert.equal(artifactText.includes(alphaSecret), false);
  assert.equal(artifactText.includes('v2:'), false);
  assert.equal(artifactText.includes('pa55'), false);
  assert.equal(artifactText.includes('hidden'), false);
  assert.equal((await stat(`${artifactPath}.sha256`)).isFile(), true);
  const inspected = await inspectProviderArtifact(artifactPath);
  assert.equal(inspected.findings, 0);
  assert.equal(inspected.document.providers.find(provider => provider.name === 'alpha')?.stored_auth, true);
  assert.equal(inspected.document.providers.find(provider => provider.name === 'beta')?.api_base_url,
    'https://api.example.test/v1?region=cn');
  assert.equal(inspected.document.scene_bindings.find(binding => binding.scene === 'fault_diagnosis')?.provider, null);
  console.log('PASS: backup is secret-free, checksummed, mode 0600 and keeps URL redactions');

  await assert.rejects(
    backupProviderConfiguration(pool, artifactPath, { database: schema, actor: 'drill', now: backupAt }),
    expectCode('PROVIDER_CONFIG_BACKUP_ARTIFACT_EXISTS'),
  );
  const insideRepository = join(import.meta.dirname, '..', 'provider-backup-should-not-exist.json');
  await assert.rejects(assertOutsideRepository(insideRepository), expectCode('PROVIDER_CONFIG_BACKUP_PATH_INSIDE_REPOSITORY'));
  await assert.rejects(
    backupProviderConfiguration(pool, insideRepository, { database: schema, actor: 'drill', now: backupAt }),
    expectCode('PROVIDER_CONFIG_BACKUP_PATH_INSIDE_REPOSITORY'),
  );

  const tamperedPath = join(directory, 'tampered.json');
  await writeFile(tamperedPath, `${artifactText}\n`, { mode: 0o600 });
  await writeFile(`${tamperedPath}.sha256`, `${backup.artifact.sha256}  tampered.json\n`, { mode: 0o600 });
  await assert.rejects(inspectProviderArtifact(tamperedPath), expectCode('PROVIDER_CONFIG_BACKUP_CHECKSUM_MISMATCH'));
  console.log('PASS: overwrite and repository-path guards, checksum tamper rejection');

  const alphaKeyBefore = (await query<Array<{ api_key_encrypted: string }>>("SELECT api_key_encrypted FROM llm_providers WHERE name='alpha'"))[0].api_key_encrypted;
  await query("UPDATE llm_providers SET display_name='Alpha Changed' WHERE name='alpha'");
  await query(`INSERT INTO llm_providers
    (name, display_name, deployment_type, api_format, api_key_encrypted, api_base_url, default_model, models_supported,
     context_window, supports_function_call, enabled, is_default)
    VALUES ('delta', 'Delta Extra', 'api', 'openai-completions', ?, 'https://api.example.test/v1', 'deepseek-chat', ?,
      128000, TRUE, TRUE, FALSE)`, [encryptData('sk-drill-delta-0123456789'), models]);
  await query("DELETE FROM llm_scene_bindings WHERE scene='chat'");
  await query("UPDATE llm_scene_bindings SET model='deepseek-reasoner' WHERE scene='sql_analysis'");

  const dryRun = await restoreProviderConfiguration(pool, artifactPath, {
    database: schema, actor: 'drill', dryRun: true, now: new Date('2026-10-25T08:05:00.000Z'),
  });
  assert.equal(dryRun.applied, false);
  assert.deepEqual(dryRun.plan.update, [
    { name: 'alpha', changed_fields: ['display_name'] },
    { name: 'beta', changed_fields: ['api_base_url'] },
  ]);
  assert.deepEqual(dryRun.plan.base_url_redactions, ['beta']);
  assert.deepEqual(dryRun.plan.disable_extra, ['delta']);
  assert.deepEqual(dryRun.plan.bindings_changed.sort(), ['chat', 'sql_analysis']);
  assert.equal(dryRun.plan.bindings_delete.length, 0);

  const restored = await restoreProviderConfiguration(pool, artifactPath, {
    database: schema, actor: 'drill', now: new Date('2026-10-25T08:06:00.000Z'),
  });
  assert.equal(restored.applied, true);
  assert.equal(restored.verification?.ok, true, JSON.stringify(restored.verification?.issues));
  assert.equal(restored.plan.disable_extra.includes('delta'), true);
  assert.equal(restored.plan.bindings_upsert.length, 3);
  assert.deepEqual(restored.plan.base_url_redactions, ['beta']);
  assert.equal(restored.verification?.issues.some(issue =>
    issue.code === 'BASE_URL_CREDENTIALS_REMOVED' && issue.provider === 'beta'), true);
  const betaRow = (await query<Array<any>>("SELECT api_base_url FROM llm_providers WHERE name='beta'"))[0];
  assert.equal(betaRow.api_base_url, 'https://api.example.test/v1?region=cn');
  const alphaRow = (await query<Array<any>>("SELECT display_name, enabled, is_default, api_key_encrypted FROM llm_providers WHERE name='alpha'"))[0];
  assert.equal(alphaRow.display_name, 'Alpha Provider');
  assert.equal(Boolean(alphaRow.enabled), true);
  assert.equal(Boolean(alphaRow.is_default), true);
  assert.equal(alphaRow.api_key_encrypted, alphaKeyBefore, 'same-environment restore must preserve the encrypted key');
  const deltaRow = (await query<Array<any>>("SELECT enabled, is_default FROM llm_providers WHERE name='delta'"))[0];
  assert.equal(Boolean(deltaRow.enabled), false);
  assert.equal(Boolean(deltaRow.is_default), false);
  const bindingsAfter = await query<Array<any>>('SELECT scene, provider_id, model FROM llm_scene_bindings ORDER BY scene');
  assert.deepEqual(bindingsAfter.map(row => [row.scene, Number(row.provider_id), row.model]), [
    ['chat', 1, 'deepseek-chat'],
    ['fault_diagnosis', 999, 'gone'],
    ['sql_analysis', 1, 'deepseek-chat'],
  ]);
  assert.equal(restored.plan.dangling_bindings.length, 1);
  assert.ok(restored.snapshot);
  assert.equal((await stat(restored.snapshot!.path)).mode & 0o777, 0o600);
  const snapshotText = await readFile(restored.snapshot!.path, 'utf8');
  assert.equal(snapshotText.includes(alphaSecret), false);
  assert.equal(snapshotText.includes('v2:'), false);
  assert.equal(snapshotText.includes('pa55'), false);
  console.log('PASS: restore applies non-secret fields, preserves keys, disables extras and verifies bindings');

  const auditRows = await query<Array<{ action: string; details_json: any; result: string }>>(
    "SELECT action, details_json, result FROM audit_log_entries WHERE resource_type='llm_provider_config' ORDER BY timestamp_ms, created_at");
  assert.deepEqual(auditRows.map(row => row.action), [
    'llm_provider_config_backup', 'llm_provider_config_restore', 'llm_provider_config_verify',
  ]);
  assert.equal(auditRows.every(row => row.result === 'success'), true);
  const auditText = JSON.stringify(auditRows);
  assert.equal(auditText.includes(alphaSecret), false);
  assert.equal(auditText.includes('v2:'), false);
  assert.equal(auditText.includes('pa55'), false);
  console.log('PASS: backup/restore/verification audit rows contain no secrets');

  await query("UPDATE llm_providers SET display_name='After Restore' WHERE name='alpha'");
  await query("DELETE FROM llm_scene_bindings WHERE scene='chat'");
  const rollback = await restoreProviderConfiguration(pool, restored.snapshot!.path, {
    database: schema, actor: 'drill', rollback: true, now: new Date('2026-10-25T08:10:00.000Z'),
  });
  assert.equal(rollback.applied, true);
  assert.equal(rollback.verification?.ok, true, JSON.stringify(rollback.verification?.issues));
  const rolledBack = (await query<Array<any>>("SELECT display_name, enabled, is_default, api_key_encrypted FROM llm_providers WHERE name='alpha'"))[0];
  assert.equal(rolledBack.display_name, 'Alpha Changed');
  assert.equal(Boolean(rolledBack.enabled), true);
  assert.equal(rolledBack.api_key_encrypted, alphaKeyBefore);
  const deltaRolledBack = (await query<Array<any>>("SELECT enabled FROM llm_providers WHERE name='delta'"))[0];
  assert.equal(Boolean(deltaRolledBack.enabled), true);
  const bindingsRolledBack = await query<Array<any>>('SELECT scene, model FROM llm_scene_bindings ORDER BY scene');
  assert.deepEqual(bindingsRolledBack.map(row => [row.scene, row.model]), [
    ['fault_diagnosis', 'gone'], ['sql_analysis', 'deepseek-reasoner'],
  ]);
  console.log('PASS: rollback restores the pre-restore snapshot exactly (providers, bindings, enabled/default)');
} finally {
  await pool?.end();
  if (created && admin) await admin.query(`DROP DATABASE \`${schema}\``);
  await admin?.end();
  if (directory) await rm(directory, { recursive: true, force: true });
}
