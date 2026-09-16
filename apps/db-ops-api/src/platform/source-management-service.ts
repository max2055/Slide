import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { dbConnection } from '../db-connection.js';
import type { ActorContext } from '../auth/actor-context.js';
import { auditLogManager } from '../audit/audit-log.js';
import { assertRepositoryPath } from './source-repository-path.js';
import { GitSourceConnector } from './git-source-connector.js';
import { SourceSnapshotService, describeSourceFiles, type SourceManifest } from './source-snapshot-service.js';
import { sourceOrigin, sourceRef } from './source-policy.js';
import { readDeploymentBinding } from './deployment-binding.js';
import { FixedWindowRateLimiter } from '../security/agent-runtime-limits.js';

const ConfigSchema = Type.Object({
  provider: Type.Optional(Type.Union([Type.Literal('gitlab'), Type.Literal('github')])),
  baseUrl: Type.String({ maxLength: 512 }), repositoryPath: Type.String({ minLength: 1, maxLength: 256 }),
  gitUsername: Type.Optional(Type.String({ pattern: '^[A-Za-z0-9_.@+-]+$', minLength: 1, maxLength: 128 })),
  ref: Type.Optional(Type.String({ maxLength: 256 })),
  allowedPaths: Type.Array(Type.String({ pattern: '^[A-Za-z0-9_/-]+/$', maxLength: 256 }), { maxItems: 32, uniqueItems: true }),
  allowModelContent: Type.Boolean(),
  httpProxy: Type.Optional(Type.String({ maxLength: 512 })), httpsProxy: Type.Optional(Type.String({ maxLength: 512 })), allProxy: Type.Optional(Type.String({ maxLength: 512 })),
}, { additionalProperties: false });
export type SourceConfig = Static<typeof ConfigSchema>;
interface Executor { execute(sql: string, values?: string[]): Promise<any> }
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
interface SnapshotReference { releaseId: string; commitSha: string; treeDigest: string }
export function requireSourceAdmin(actor: ActorContext) {
  if (!actor?.permissions?.some(value => value === '*' || value === 'admin:*')) throw new Error('SOURCE_ADMIN_REQUIRED');
}
export function requireSourceReader(actor: ActorContext) {
  if (!actor?.permissions?.some(value => ['*', 'admin:*', 'config:*', 'config:view'].includes(value))) throw new Error('SOURCE_READ_FORBIDDEN');
}

export class SourceManagementService {
  private syncing = false;
  private readsInFlight = 0;
  private readonly readBudget = new FixedWindowRateLimiter(30, 60_000);
  constructor(private readonly pool: () => Executor | null = () => dbConnection.getPool(), private readonly allowedOrigins = `${process.env.SLIDE_GITLAB_ORIGINS ?? ''},${process.env.SLIDE_GITHUB_ORIGINS ?? 'https://github.com'}`.split(',').map(value => value.trim()).filter(Boolean)) {}
  private executor() { const executor = this.pool(); if (!executor) throw new Error('SOURCE_STORAGE_UNAVAILABLE'); return executor; }
  private validate(input: unknown): SourceConfig {
    if (!Value.Check(ConfigSchema, input)) throw new Error('SOURCE_CONFIG_INVALID');
    const url = sourceOrigin(input.baseUrl, this.allowedOrigins);
    sourceRef(input.ref);
    assertRepositoryPath(input.repositoryPath, input.provider ?? 'gitlab');
    if (input.allowedPaths.some(path => path.split('/').slice(0, -1).some(part => !part || part === '..'))) throw new Error('SOURCE_CONFIG_INVALID');
    for (const key of ['httpProxy', 'httpsProxy', 'allProxy'] as const) if (input[key] && !/^https?:\/\/[^\s]+$/.test(input[key])) throw new Error('SOURCE_CONFIG_INVALID');
    return { ...input, provider: input.provider ?? 'gitlab', baseUrl: url.origin };
  }
  async load(actor: ActorContext): Promise<SourceConfig | null> {
    requireSourceReader(actor);
    const [rows] = await this.executor().execute('SELECT config_value FROM system_config WHERE config_key = ?', ['source.gitlab']);
    if (!rows.length) return null;
    try {
      const stored = JSON.parse(rows[0].config_value);
      if (!stored.repositoryPath && stored.projectId) {
        if (/^\d+$/.test(stored.projectId)) throw new Error('SOURCE_REPOSITORY_PATH_REQUIRED');
        stored.repositoryPath = stored.projectId;
        delete stored.projectId;
      }
      return this.validate(stored);
    } catch (error) {
      if (error instanceof Error && error.message === 'SOURCE_REPOSITORY_PATH_REQUIRED') throw error;
      throw new Error('SOURCE_CONFIG_INVALID');
    }
  }
  async save(actor: ActorContext, input: unknown) {
    requireSourceAdmin(actor); const config = this.validate(input);
    await this.executor().execute('REPLACE INTO system_config (config_key, config_value) VALUES (?, ?)', ['source.gitlab', JSON.stringify(config)]);
    await auditLogManager.logConfigChange({ userId: String(actor.userId), username: actor.username, configKey: 'source.gitlab', newValue: config });
    return config;
  }
  private deployment() {
    return readDeploymentBinding();
  }
  private snapshots() {
    return new SourceSnapshotService(resolve(process.env.SLIDE_SOURCE_ROOT ?? './data/source-snapshots'), process.env.SLIDE_SOURCE_SIGNING_KEY ?? '');
  }
  private repository(config: SourceConfig) {
    return { origin: config.baseUrl, provider: config.provider ?? 'gitlab', ref: sourceRef(config.ref), allowedPaths: [...config.allowedPaths].sort() };
  }
  private snapshotKey(config: SourceConfig) {
    return 'source.snapshot.' + hash({ ...this.repository(config), projectId: config.repositoryPath });
  }
  private verification(manifest: SourceManifest) {
    let deployment: ReturnType<typeof readDeploymentBinding>;
    try { deployment = this.deployment(); }
    catch { return { status: 'repository-unbound' as const, reason: 'SOURCE_DEPLOYMENT_UNKNOWN' }; }
    const reason = manifest.commitSha !== deployment.commitSha ? 'SOURCE_COMMIT_MISMATCH'
      : manifest.treeDigest !== deployment.treeDigest ? 'SOURCE_TREE_MISMATCH'
      : manifest.completeness === 'partial' ? 'SOURCE_SNAPSHOT_PARTIAL' : undefined;
    return { status: reason ? 'repository-unbound' as const : 'deployment-verified' as const, reason, deployment };
  }
  private async current(config: SourceConfig, snapshots: SourceSnapshotService): Promise<SourceManifest> {
    const [rows] = await this.executor().execute('SELECT config_value FROM system_config WHERE config_key = ?', [this.snapshotKey(config)]);
    let reference: SnapshotReference;
    if (rows.length) {
      try { reference = JSON.parse(rows[0].config_value); } catch { throw new Error('SOURCE_SNAPSHOT_UNTRUSTED'); }
      if (!reference || typeof reference.releaseId !== 'string' || !/^[a-f0-9]{40}$/.test(reference.commitSha)
        || !/^[a-f0-9]{64}$/.test(reference.treeDigest)) throw new Error('SOURCE_SNAPSHOT_UNTRUSTED');
    } else {
      // Legacy manifests have no origin/ref identity; require one sync instead of guessing.
      throw new Error('SOURCE_NOT_SYNCED');
    }
    const manifest = await snapshots.manifest(reference.releaseId, reference);
    if (manifest.projectId !== config.repositoryPath
      || (manifest.repository && JSON.stringify(manifest.repository) !== JSON.stringify(this.repository(config)))
      || (config.allowedPaths.length > 0 && manifest.files.some(file => !config.allowedPaths.some(path => file.path.startsWith(path))))) {
      throw new Error('SOURCE_SNAPSHOT_POLICY_CHANGED');
    }
    return manifest;
  }
  async sync(actor: ActorContext, token: string) {
    requireSourceAdmin(actor);
    if (this.syncing) throw new Error('SOURCE_SYNC_BUSY');
    this.syncing = true;
    const startedAt = Date.now(); let stageStartedAt = startedAt; let stage = 'config';
    const reportStage = () => {
      const now = Date.now();
      console.info('[source-sync]', { stage, elapsedMs: now - startedAt, stageMs: now - stageStartedAt });
      stageStartedAt = now;
    };
    try {
      const config = await this.load(actor);
      if (!config) throw new Error('SOURCE_NOT_CONFIGURED');
      if (!token) throw new Error('SOURCE_CREDENTIAL_INVALID');
      const snapshots = this.snapshots(); // Fail missing signing configuration before fetching credentials upstream.
      reportStage();
      stage = 'fetch';
      const fetched = await new GitSourceConnector(this.allowedOrigins, resolve(process.env.SLIDE_SOURCE_ROOT ?? './data/source-snapshots')).fetchFiles({ ...config, provider: config.provider ?? 'gitlab', token, tokenExpiresAt: new Date(Date.now() + 15 * 60_000).toISOString() });
      reportStage();
      const repository = this.repository(config);
      const releaseId = 'source-' + hash({ repository, projectId: config.repositoryPath, commitSha: fetched.commitSha, files: describeSourceFiles(fetched.files), skippedFiles: fetched.skippedFiles });
      stage = 'snapshot';
      const manifest = await snapshots.publish({ releaseId, commitSha: fetched.commitSha, projectId: config.repositoryPath, repository }, fetched.files, fetched.skippedFiles);
      reportStage();
      const reference = { releaseId, commitSha: manifest.commitSha, treeDigest: manifest.treeDigest };
      stage = 'manifest';
      await this.executor().execute('REPLACE INTO system_config (config_key, config_value) VALUES (?, ?)', [this.snapshotKey(config), JSON.stringify(reference)]);
      reportStage();
      const verification = this.verification(manifest);
      await auditLogManager.logToolCall({ userId: String(actor.userId), username: actor.username, toolName: 'source_sync', toolParams: { ...reference, verification, completeness: manifest.completeness, skippedCount: fetched.skippedFiles.length }, result: 'success' });
      console.info('[source-sync]', { stage, elapsedMs: Date.now() - startedAt, commitSha: manifest.commitSha, files: manifest.files.length, skipped: fetched.skippedFiles.length });
      return { ...manifest, verification };
    } catch (error) {
      const errorCode = error instanceof Error && /^SOURCE_[A-Z_]+$/.test(error.message) ? error.message : 'SOURCE_SYNC_FAILED';
      console.error('[source-sync]', { stage, elapsedMs: Date.now() - startedAt, errorCode });
      await auditLogManager.logToolCall({ userId: String(actor.userId), username: actor.username, toolName: 'source_sync', toolParams: { stage }, result: 'failure', errorMessage: errorCode });
      throw error;
    } finally { this.syncing = false; }
  }
  async inspect(actor: ActorContext, mode: 'manifest' | 'search' | 'read' | 'symbol', args: Record<string, unknown> = {}, model = false) {
    requireSourceReader(actor);
    if (!this.readBudget.allow()) throw new Error('SOURCE_RATE_LIMITED');
    if (this.readsInFlight >= 2) throw new Error('SOURCE_READ_BUSY');
    this.readsInFlight++;
    const audit = { userId: String(actor.userId), username: actor.username, toolName: 'source_' + mode };
    try {
      const config = await this.load(actor);
      if (!config) throw new Error('SOURCE_NOT_CONFIGURED');
      if (model && !config.allowModelContent) throw new Error('SOURCE_MODEL_EGRESS_DENIED');
      const snapshots = this.snapshots(); const manifest = await this.current(config, snapshots);
      const source = { releaseId: manifest.releaseId, commitSha: manifest.commitSha, treeDigest: manifest.treeDigest,
        completeness: manifest.completeness ?? 'complete', verification: this.verification(manifest), interpretation: 'implementation-intent' as const };
      const result = mode === 'manifest' ? { ...manifest, verification: source.verification }
        : mode === 'search' ? { matches: await snapshots.search(manifest.releaseId, manifest, args.query as string), source }
        : mode === 'symbol' ? { matches: await snapshots.symbols(manifest.releaseId, manifest, args.name as string), source }
        : { ...await snapshots.read(manifest.releaseId, manifest, args.path as string, args.startLine as number, args.endLine as number), source };
      await auditLogManager.logToolCall({ ...audit, toolParams: source, result: 'success' });
      return result;
    } catch (error) {
      await auditLogManager.logToolCall({ ...audit, result: 'failure', errorMessage: 'SOURCE_READ_FAILED' });
      throw error;
    } finally { this.readsInFlight--; }
  }
}
export const sourceManagementService = new SourceManagementService();
