/**
 * Database, file and audit operations for provider configuration backup /
 * restore (issue #244). Kept separate from the pure artifact logic so unit
 * tests can cover sanitization and verification without MySQL.
 */
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import type { Pool, PoolConnection } from 'mysql2/promise';
import { decryptData } from '../db-connection.js';
import type { LLMProvider } from '../llm-database-service.js';
import { llmService } from '../llm-service.js';
import type { SceneBinding } from './scene-routing.js';
import {
  PROVIDER_CONFIG_BACKUP_FORMAT,
  PROVIDER_CONFIG_BACKUP_VERSION,
  PROVIDER_MANAGED_FIELDS,
  ProviderConfigBackupError,
  assertNoSecrets,
  backupChecksum,
  buildBackupDocument,
  buildRestorePlan,
  changedProviderFields,
  findSecretLeaks,
  managedFields,
  parseBackupArtifact,
  serializeBackupDocument,
  storedAuth,
  verifyRestoredConfiguration,
  type ManagedProviderFields,
  type ProviderBackupEntry,
  type ProviderConfigBackupDocument,
  type ProviderConfigRecord,
  type RestorePlan,
  type VerificationIssue,
  type VerificationResult,
} from './provider-config-backup.js';

export const PROVIDER_SELECT = `SELECT id, name, display_name, deployment_type, api_format, api_base_url,
  default_model, models_supported, context_window, supports_function_call, supports_vision,
  input_cost_per_1k, output_cost_per_1k, enabled, is_default, temperature, max_tokens, timeout_ms,
  rate_limit_per_minute, daily_quota, daily_quota_alert_threshold,
  api_key_encrypted IS NOT NULL AS stored_auth
  FROM llm_providers`;

const CONNECTION_SELECT = `SELECT name, display_name, deployment_type, api_format, api_base_url, default_model,
  models_supported, context_window, supports_function_call, supports_vision, max_tokens,
  api_key_encrypted, enabled FROM llm_providers`;

export interface ArtifactFile {
  path: string;
  text: string;
  sha256: string;
  size_bytes: number;
}

export interface ConnectionCheck {
  provider: string;
  checked: boolean;
  success: boolean;
  skipped?: boolean;
  model?: string;
  duration_ms?: number;
  error?: string;
}

export interface BackupResult {
  artifact: { path: string; sha256: string; size_bytes: number; mode: string };
  provider_count: number;
  binding_count: number;
  redactions: number;
  audit_id: string;
}

export interface RestoreResult {
  applied: boolean;
  dry_run: boolean;
  plan: RestorePlan;
  snapshot?: { path: string; sha256: string };
  verification?: VerificationResult;
  connections?: ConnectionCheck[];
  audit_id?: string;
  verification_audit_id?: string;
}

export interface VerifyResult {
  sha256: string;
  provider_count: number;
  binding_count: number;
  redactions: number;
  verification?: VerificationResult;
  connections?: ConnectionCheck[];
  audit_id?: string;
}

export interface ActorOptions {
  actor?: string;
  database: string;
}

export function defaultBackupDirectory(home: string): string {
  return process.env.SLIDE_PROVIDER_CONFIG_BACKUP_DIR || join(home, '.config', 'slide', 'backups', 'llm-provider-config');
}

/**
 * The backup must never be committed. Refuse any path inside a git worktree,
 * including linked worktrees where `.git` is a file.
 */
export async function assertOutsideRepository(target: string): Promise<void> {
  let directory = dirname(resolve(target));
  // Resolve the nearest existing ancestor so a symlink into the repository
  // cannot bypass the check for a not-yet-created output directory.
  for (;;) {
    try {
      directory = await realpath(directory);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  }
  for (;;) {
    try {
      await stat(join(directory, '.git'));
      throw new ProviderConfigBackupError(
        'PROVIDER_CONFIG_BACKUP_PATH_INSIDE_REPOSITORY',
        'backup artifacts must not be written inside a git worktree',
      );
    } catch (error) {
      if (error instanceof ProviderConfigBackupError) throw error;
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const parent = dirname(directory);
    if (parent === directory) return;
    directory = parent;
  }
}

async function writeFileExclusive(path: string, text: string, force: boolean): Promise<string> {
  await assertOutsideRepository(path);
  if (!force) {
    try {
      await stat(path);
      throw new ProviderConfigBackupError('PROVIDER_CONFIG_BACKUP_ARTIFACT_EXISTS', 'artifact already exists; use --force to replace it');
    } catch (error) {
      if (error instanceof ProviderConfigBackupError) throw error;
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  await mkdir(dirname(resolve(path)), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`;
  await writeFile(temporary, text, { encoding: 'utf8', mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
  await chmod(path, 0o600);
  const checksum = backupChecksum(text);
  await writeFile(`${path}.sha256`, `${checksum}  ${basename(path)}\n`, { encoding: 'utf8', mode: 0o600 });
  return checksum;
}

export async function readArtifactWithChecksum(path: string, expectedSha256?: string): Promise<ArtifactFile> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new ProviderConfigBackupError('PROVIDER_CONFIG_BACKUP_ARTIFACT_MISSING', 'artifact file does not exist');
    }
    throw error;
  }
  const sha256 = backupChecksum(text);
  let expected = expectedSha256?.toLowerCase();
  if (expected && !/^[0-9a-f]{64}$/.test(expected)) {
    throw new ProviderConfigBackupError('PROVIDER_CONFIG_BACKUP_CHECKSUM_INVALID', 'expected checksum is not a SHA-256 hex value');
  }
  if (!expected) {
    let sidecar: string;
    try {
      sidecar = await readFile(`${path}.sha256`, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new ProviderConfigBackupError(
          'PROVIDER_CONFIG_BACKUP_CHECKSUM_MISSING',
          'checksum file is missing; provide --sha256 <hex> or restore the .sha256 file',
        );
      }
      throw error;
    }
    const [hash, name] = sidecar.trim().split(/\s+/);
    if (!/^[0-9a-f]{64}$/i.test(hash ?? '')) {
      throw new ProviderConfigBackupError('PROVIDER_CONFIG_BACKUP_CHECKSUM_INVALID', 'checksum file is invalid');
    }
    if (name && name !== basename(path)) {
      throw new ProviderConfigBackupError('PROVIDER_CONFIG_BACKUP_CHECKSUM_MISMATCH', 'checksum file names a different artifact');
    }
    expected = hash.toLowerCase();
  }
  if (sha256 !== expected) {
    throw new ProviderConfigBackupError('PROVIDER_CONFIG_BACKUP_CHECKSUM_MISMATCH', 'artifact checksum does not match');
  }
  const metadata = await stat(path);
  return { path, text, sha256, size_bytes: metadata.size };
}

type Queryable = Pick<Pool | PoolConnection, 'execute' | 'query'>;

async function readProviders(executor: Queryable, lock = false): Promise<ProviderConfigRecord[]> {
  const [rows] = await executor.query(`${PROVIDER_SELECT}${lock ? ' FOR UPDATE' : ''}`) as any;
  return rows as ProviderConfigRecord[];
}

async function readBindings(executor: Queryable, lock = false): Promise<SceneBinding[]> {
  const [rows] = await executor.query(`SELECT scene, provider_id, model FROM llm_scene_bindings${lock ? ' FOR UPDATE' : ''}`) as any;
  return rows as SceneBinding[];
}

function safeDbError(error: unknown): ProviderConfigBackupError {
  if (error instanceof ProviderConfigBackupError) return error;
  const code = (error as { code?: unknown })?.code;
  return new ProviderConfigBackupError(
    'PROVIDER_CONFIG_BACKUP_DB_ERROR',
    `database operation failed${typeof code === 'string' && /^[A-Z0-9_]+$/.test(code) ? ` (${code})` : ''}`,
    { cause: error },
  );
}

function auditId(): string {
  return `audit_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
}

function actorName(options: ActorOptions): string {
  return options.actor?.trim() || process.env.SLIDE_OPERATOR?.trim() || process.env.USER?.trim() || 'provider-config-operator';
}

async function insertAudit(
  executor: Queryable,
  input: {
    action: string;
    eventType: 'config_backup_access' | 'config_change';
    level: 'info' | 'warning' | 'error';
    result: 'success' | 'failure';
    resourceId: string;
    details: Record<string, unknown>;
    errorMessage?: string;
    actor: string;
    at: Date;
  },
): Promise<string> {
  assertNoSecrets(input.details);
  const id = auditId();
  await executor.execute(
    `INSERT INTO audit_log_entries
     (id, event_type, level, user_id, username, user_role, action, resource_type, resource_id,
      details_json, approval_request_id, client_ip, user_agent, result, error_message, timestamp_ms)
     VALUES (?, ?, ?, NULL, ?, NULL, ?, 'llm_provider_config', ?, ?, NULL, NULL, NULL, ?, ?, ?)`,
    [
      id, input.eventType, input.level, input.actor, input.action, input.resourceId.slice(0, 255),
      JSON.stringify(input.details), input.result, input.errorMessage?.slice(0, 1000) ?? null, input.at.getTime(),
    ],
  );
  return id;
}

export async function backupProviderConfiguration(
  pool: Pool,
  outPath: string,
  options: ActorOptions & { now?: Date; force?: boolean },
): Promise<BackupResult> {
  const now = options.now ?? new Date();
  let connection: PoolConnection | undefined;
  let providers: ProviderConfigRecord[];
  let bindings: SceneBinding[];
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();
    providers = await readProviders(connection);
    bindings = await readBindings(connection);
    await connection.commit();
  } catch (error) {
    if (connection) await connection.rollback().catch(() => {});
    throw safeDbError(error);
  } finally {
    connection?.release();
  }
  const document = buildBackupDocument(providers, bindings, { database: options.database, now });
  const text = serializeBackupDocument(document);
  const sha256 = await writeFileExclusive(outPath, text, Boolean(options.force));
  const metadata = await stat(outPath);
  let id: string;
  try {
    id = await insertAudit(pool, {
      action: 'llm_provider_config_backup',
      eventType: 'config_backup_access',
      level: 'info',
      result: 'success',
      resourceId: basename(outPath),
      details: {
        format: PROVIDER_CONFIG_BACKUP_FORMAT,
        version: PROVIDER_CONFIG_BACKUP_VERSION,
        database: options.database,
        sha256,
        size_bytes: metadata.size,
        provider_count: document.providers.length,
        binding_count: document.scene_bindings.length,
        redactions: document.redactions.length,
      },
      actor: actorName(options),
      at: now,
    });
  } catch (error) {
    // The artifact is already written and verifiable; report the audit failure
    // without deleting the only current backup.
    throw new ProviderConfigBackupError(
      'PROVIDER_CONFIG_BACKUP_AUDIT_FAILED',
      `artifact written (${sha256}) but audit write failed`,
      { cause: error },
    );
  }
  return {
    artifact: { path: outPath, sha256, size_bytes: metadata.size, mode: (metadata.mode & 0o777).toString(8) },
    provider_count: document.providers.length,
    binding_count: document.scene_bindings.length,
    redactions: document.redactions.length,
    audit_id: id,
  };
}

function sqlValue(field: keyof ManagedProviderFields, value: unknown): string | number | null {
  if (field === 'models_supported') return value === null ? null : JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 1 : 0;
  return (value ?? null) as string | number | null;
}

async function applyProviderEntries(
  connection: PoolConnection,
  entries: ProviderBackupEntry[],
  currentProviders: ProviderConfigRecord[],
): Promise<RestorePlan> {
  const byName = new Map(currentProviders.map(provider => [provider.name, provider]));
  const backupNames = new Set(entries.map(entry => entry.name));
  const plan: RestorePlan = {
    create: [], update: [], unchanged: [], disable_extra: [], credentials_required: [],
    bindings_upsert: [], bindings_changed: [], bindings_delete: [], dangling_bindings: [],
  };
  for (const entry of entries) {
    const current = byName.get(entry.name);
    const values = PROVIDER_MANAGED_FIELDS.map(field => sqlValue(field, entry[field]));
    if (!current) {
      plan.create.push(entry.name);
      if (entry.stored_auth) plan.credentials_required.push(entry.name);
      const columns = [entry.name, ...PROVIDER_MANAGED_FIELDS] as string[];
      await connection.execute(
        `INSERT INTO llm_providers (name, ${PROVIDER_MANAGED_FIELDS.join(', ')})
         VALUES (${columns.map(() => '?').join(', ')})`,
        [entry.name, ...values],
      );
      continue;
    }
    const changed = changedProviderFields(current, entry);
    if (changed.length === 0) {
      plan.unchanged.push(entry.name);
    } else {
      plan.update.push({ name: entry.name, changed_fields: changed });
      await connection.execute(
        `UPDATE llm_providers SET ${PROVIDER_MANAGED_FIELDS.map(field => `${field} = ?`).join(', ')} WHERE name = ?`,
        [...values, entry.name],
      );
    }
    if (entry.stored_auth && !storedAuth(current)) plan.credentials_required.push(entry.name);
  }
  const extras = currentProviders.filter(provider => !backupNames.has(provider.name) && managedFields(provider).enabled).map(provider => provider.name);
  plan.disable_extra = extras;
  if (extras.length) {
    // A disabled provider must not stay `is_default`: routing would pick it and
    // fail with "provider disabled" instead of falling back to the backup state.
    await connection.execute(
      `UPDATE llm_providers SET enabled = 0, is_default = 0 WHERE name IN (${extras.map(() => '?').join(', ')})`,
      extras,
    );
  }
  return plan;
}

async function applySceneBindings(
  connection: PoolConnection,
  document: ProviderConfigBackupDocument,
  plan: RestorePlan,
): Promise<void> {
  const [providerRows] = await connection.query('SELECT id, name FROM llm_providers') as any;
  const idByName = new Map<string, number>((providerRows as Array<{ id: number; name: string }>).map(row => [row.name, Number(row.id)]));
  const currentBindings = await readBindings(connection, true);
  const currentByScene = new Map(currentBindings.map(binding => [binding.scene, binding]));
  const backupScenes = new Set(document.scene_bindings.map(binding => binding.scene));
  for (const binding of document.scene_bindings) {
    const providerId = binding.provider === null
      ? binding.dangling_provider_id ?? 0
      : idByName.get(binding.provider);
    if (providerId === undefined) {
      throw new ProviderConfigBackupError(
        'PROVIDER_CONFIG_BACKUP_BINDING_PROVIDER_MISSING',
        `scene ${binding.scene} references a provider that is not in the artifact`,
      );
    }
    const current = currentByScene.get(binding.scene);
    if (!current || current.provider_id !== providerId || current.model !== binding.model) {
      plan.bindings_changed.push(binding.scene);
    }
    await connection.execute(
      `INSERT INTO llm_scene_bindings (scene, provider_id, model) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE provider_id = VALUES(provider_id), model = VALUES(model)`,
      [binding.scene, providerId, binding.model],
    );
  }
  const removals = currentBindings.map(binding => binding.scene).filter(scene => !backupScenes.has(scene));
  plan.bindings_delete = removals;
  if (removals.length) {
    await connection.execute(
      `DELETE FROM llm_scene_bindings WHERE scene IN (${removals.map(() => '?').join(', ')})`,
      removals,
    );
  }
  plan.bindings_upsert = document.scene_bindings;
  plan.dangling_bindings = document.scene_bindings.filter(binding => binding.provider === null);
}

function snapshotPathFor(artifactPath: string, now: Date): string {
  const stamp = now.toISOString().replace(/[-:.]/g, '');
  const base = basename(artifactPath).replace(/\.json$/i, '');
  return join(dirname(resolve(artifactPath)), `${base}.pre-restore.${stamp}.json`);
}

export async function checkProviderConnections(
  pool: Pool,
  selection: 'all' | string[],
): Promise<ConnectionCheck[]> {
  const [rows] = await pool.query(`${CONNECTION_SELECT} ORDER BY name`) as any;
  const providers = rows as Array<ProviderConfigRecord & { api_key_encrypted?: string | null }>;
  const requested = selection === 'all' ? null : new Set(selection);
  const results: ConnectionCheck[] = [];
  for (const provider of providers) {
    const name = provider.name;
    const explicitlyRequested = requested?.has(name) ?? false;
    if (requested && !explicitlyRequested) continue;
    if (!requested && !managedFields(provider).enabled) continue;
    if (requested && !provider.enabled) {
      results.push({ provider: name, checked: false, success: false, error: 'PROVIDER_NOT_ENABLED' });
      continue;
    }
    const key = provider.api_key_encrypted;
    const local = provider.deployment_type === 'local';
    if (!key && !local) {
      results.push(explicitlyRequested
        ? { provider: name, checked: false, success: false, error: 'CREDENTIAL_NOT_CONFIGURED' }
        : { provider: name, checked: false, success: false, skipped: true, error: 'CREDENTIAL_NOT_CONFIGURED' });
      continue;
    }
    let apiKey: string;
    try {
      apiKey = key ? decryptData(key) : '';
    } catch {
      results.push({ provider: name, checked: false, success: false, error: 'CREDENTIAL_UNREADABLE' });
      continue;
    }
    if (!apiKey && local) apiKey = 'ollama';
    const fields = managedFields(provider);
    const providerConfig = { ...provider, ...fields } as unknown as LLMProvider;
    const started = Date.now();
    const result = await llmService.testConnectionWithConfig(
      name,
      apiKey,
      fields.api_base_url ?? undefined,
      fields.default_model ?? undefined,
      { providerConfig },
    );
    results.push({
      provider: name,
      checked: true,
      success: result.success,
      model: result.model,
      duration_ms: Date.now() - started,
      error: result.success ? undefined : 'LLM_TEST_CONNECTION_FAILED',
    });
  }
  if (requested) {
    const seen = new Set(results.map(result => result.provider));
    for (const name of requested) {
      if (!seen.has(name)) results.push({ provider: name, checked: false, success: false, error: 'PROVIDER_NOT_FOUND' });
    }
  }
  return results;
}

function connectionIssues(checks: ConnectionCheck[]): VerificationIssue[] {
  return checks
    .filter(check => !check.success && !check.skipped)
    .map(check => ({
      code: 'CONNECTION_CHECK_FAILED',
      severity: 'error' as const,
      provider: check.provider,
      message: `提供商 ${check.provider} 连接测试未通过：${check.error ?? 'LLM_TEST_CONNECTION_FAILED'}`,
    }));
}

export async function restoreProviderConfiguration(
  pool: Pool,
  artifactPath: string,
  options: ActorOptions & {
    now?: Date;
    dryRun?: boolean;
    expectedSha256?: string;
    rollback?: boolean;
    checkConnections?: 'all' | string[];
  },
): Promise<RestoreResult> {
  const now = options.now ?? new Date();
  const artifact = await readArtifactWithChecksum(artifactPath, options.expectedSha256);
  const document = parseBackupArtifact(artifact.text);
  if (options.dryRun) {
    const connection = await pool.getConnection();
    try {
      const providers = await readProviders(connection);
      const bindings = await readBindings(connection);
      return { applied: false, dry_run: true, plan: buildRestorePlan(providers, bindings, document) };
    } catch (error) {
      throw safeDbError(error);
    } finally {
      connection.release();
    }
  }

  let snapshot: { path: string; sha256: string } | undefined;
  let audit: string | undefined;
  let connection: PoolConnection | undefined;
  let plan: RestorePlan;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();
    const currentProviders = await readProviders(connection, true);
    const currentBindings = await readBindings(connection, true);
    // Snapshot under the same locks as the apply: rollback restores exactly the
    // state this transaction observed, with no window for a concurrent change.
    const snapshotDocument = buildBackupDocument(currentProviders, currentBindings, { database: options.database, now });
    const snapshotText = serializeBackupDocument(snapshotDocument);
    const snapshotBase = snapshotPathFor(artifactPath, now);
    let snapshotPath = snapshotBase;
    let attempt = 0;
    while (true) {
      try {
        await stat(snapshotPath);
        attempt++;
        snapshotPath = snapshotBase.replace(/\.json$/, `-${attempt}.json`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        break;
      }
    }
    const snapshotSha = await writeFileExclusive(snapshotPath, snapshotText, false);
    snapshot = { path: snapshotPath, sha256: snapshotSha };

    plan = await applyProviderEntries(connection, document.providers, currentProviders);
    await applySceneBindings(connection, document, plan);
    audit = await insertAudit(connection, {
      action: 'llm_provider_config_restore',
      eventType: 'config_change',
      level: 'info',
      result: 'success',
      resourceId: basename(artifactPath),
      details: {
        rollback: Boolean(options.rollback),
        database: options.database,
        artifact_sha256: artifact.sha256,
        snapshot: basename(snapshotPath),
        snapshot_sha256: snapshotSha,
        providers_created: plan.create.length,
        providers_updated: plan.update.length,
        providers_unchanged: plan.unchanged.length,
        providers_disabled_extra: plan.disable_extra.length,
        bindings_upserted: document.scene_bindings.length,
        bindings_deleted: plan.bindings_delete.length,
        dangling_bindings: plan.dangling_bindings.length,
        redactions: document.redactions.length,
        providers_requiring_auth: plan.credentials_required,
      },
      actor: actorName(options),
      at: now,
    });
    await connection.commit();
  } catch (error) {
    if (connection) await connection.rollback().catch(() => {});
    const failure = safeDbError(error);
    try {
      await insertAudit(pool, {
        action: 'llm_provider_config_restore_failed',
        eventType: 'config_change',
        level: 'error',
        result: 'failure',
        resourceId: basename(artifactPath),
        details: {
          rollback: Boolean(options.rollback),
          database: options.database,
          artifact_sha256: artifact.sha256,
          ...(snapshot ? { snapshot: basename(snapshot.path), snapshot_sha256: snapshot.sha256 } : {}),
        },
        errorMessage: failure.code,
        actor: actorName(options),
        at: now,
      });
    } catch {
      // Preserve the original failure; the audit path is best effort.
    }
    throw failure;
  } finally {
    connection?.release();
  }

  const postConnection = await pool.getConnection();
  let verification: VerificationResult;
  try {
    const providers = await readProviders(postConnection);
    const bindings = await readBindings(postConnection);
    verification = verifyRestoredConfiguration(providers, bindings, document);
  } catch (error) {
    const failure = safeDbError(error);
    throw new ProviderConfigBackupError(
      'PROVIDER_CONFIG_BACKUP_VERIFY_FAILED',
      `restore applied but verification could not run; rollback snapshot: ${basename(snapshot?.path ?? artifactPath)}`,
      { cause: failure },
    );
  } finally {
    postConnection.release();
  }
  const connections = options.checkConnections
    ? await checkProviderConnections(pool, options.checkConnections)
    : undefined;
  if (connections) verification.issues.push(...connectionIssues(connections));
  if (connections) verification.ok = verification.issues.every(issue => issue.severity !== 'error');

  let verificationAudit: string | undefined;
  try {
    verificationAudit = await insertAudit(pool, {
      action: 'llm_provider_config_verify',
      eventType: 'config_change',
      level: verification.ok ? 'info' : 'error',
      result: verification.ok ? 'success' : 'failure',
      resourceId: basename(artifactPath),
      details: {
        restore_audit_id: audit,
        artifact_sha256: artifact.sha256,
        issue_codes: [...new Set(verification.issues.map(issue => issue.code))],
        providers_requiring_auth: verification.summary.credentials_required,
        connections: connections?.map(check => ({ provider: check.provider, checked: check.checked, success: check.success })) ?? [],
      },
      errorMessage: verification.ok ? undefined : 'PROVIDER_CONFIG_BACKUP_VERIFY_FAILED',
      actor: actorName(options),
      at: now,
    });
  } catch {
    // The restore is already committed; the primary audit row exists.
  }
  return {
    applied: true,
    dry_run: false,
    plan,
    snapshot,
    verification,
    connections,
    audit_id: audit,
    verification_audit_id: verificationAudit,
  };
}

export async function verifyProviderConfiguration(
  pool: Pool,
  artifactPath: string,
  options: ActorOptions & { expectedSha256?: string; checkConnections?: 'all' | string[] },
): Promise<VerifyResult> {
  const artifact = await readArtifactWithChecksum(artifactPath, options.expectedSha256);
  const document = parseBackupArtifact(artifact.text);
  const connection = await pool.getConnection();
  let verification: VerificationResult;
  try {
    const providers = await readProviders(connection);
    const bindings = await readBindings(connection);
    verification = verifyRestoredConfiguration(providers, bindings, document);
  } catch (error) {
    throw safeDbError(error);
  } finally {
    connection.release();
  }
  const connections = options.checkConnections
    ? await checkProviderConnections(pool, options.checkConnections)
    : undefined;
  if (connections) {
    verification.issues.push(...connectionIssues(connections));
    verification.ok = verification.issues.every(issue => issue.severity !== 'error');
  }
  const id = await insertAudit(pool, {
    action: 'llm_provider_config_verify',
    eventType: 'config_change',
    level: verification.ok ? 'info' : 'error',
    result: verification.ok ? 'success' : 'failure',
    resourceId: basename(artifactPath),
    details: {
      database: options.database,
      artifact_sha256: artifact.sha256,
      issue_codes: [...new Set(verification.issues.map(issue => issue.code))],
      providers_requiring_auth: verification.summary.credentials_required,
      connections: connections?.map(check => ({ provider: check.provider, checked: check.checked, success: check.success })) ?? [],
    },
    errorMessage: verification.ok ? undefined : 'PROVIDER_CONFIG_BACKUP_VERIFY_FAILED',
    actor: actorName(options),
    at: new Date(),
  });
  return {
    sha256: artifact.sha256,
    provider_count: document.providers.length,
    binding_count: document.scene_bindings.length,
    redactions: document.redactions.length,
    verification,
    connections,
    audit_id: id,
  };
}

/** Artifact-only check: checksum, format, structure and the secret deny-list. */
export async function inspectProviderArtifact(
  artifactPath: string,
  expectedSha256?: string,
): Promise<{ sha256: string; size_bytes: number; document: ProviderConfigBackupDocument; findings: number }> {
  const artifact = await readArtifactWithChecksum(artifactPath, expectedSha256);
  const document = parseBackupArtifact(artifact.text);
  return {
    sha256: artifact.sha256,
    size_bytes: artifact.size_bytes,
    document,
    findings: findSecretLeaks(document).length,
  };
}
