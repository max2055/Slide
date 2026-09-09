import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { resolve } from 'node:path';
import { dbConnection } from '../db-connection.js';
import type { ActorContext } from '../auth/actor-context.js';
import { credentialReferenceService } from '../security/credential-reference-service.js';
import { auditLogManager } from '../audit/audit-log.js';
import { GitLabSourceConnector } from './gitlab-source-connector.js';
import { GitHubSourceConnector } from './github-source-connector.js';
import { SourceSnapshotService, describeSourceFiles } from './source-snapshot-service.js';
import { readDeploymentBinding } from './deployment-binding.js';
import { FixedWindowRateLimiter } from '../security/agent-runtime-limits.js';

const ConfigSchema = Type.Object({
  provider: Type.Optional(Type.Union([Type.Literal('gitlab'), Type.Literal('github')])),
  baseUrl: Type.String({ maxLength: 512 }), projectId: Type.String({ minLength: 1, maxLength: 128 }),
  allowedPaths: Type.Array(Type.String({ pattern: '^[A-Za-z0-9_/-]+/$', maxLength: 256 }), { minItems: 1, maxItems: 32, uniqueItems: true }),
  allowModelContent: Type.Boolean(),
}, { additionalProperties: false });
export type SourceConfig = Static<typeof ConfigSchema>;
interface Executor { execute(sql: string, values?: string[]): Promise<any> }
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
    let url: URL; try { url = new URL(input.baseUrl); } catch { throw new Error('SOURCE_ORIGIN_DENIED'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/' || !this.allowedOrigins.includes(url.origin)) throw new Error('SOURCE_ORIGIN_DENIED');
    if ((input.provider ?? 'gitlab') === 'gitlab' && !/^\d{1,20}$/.test(input.projectId)) throw new Error('SOURCE_CONFIG_INVALID');
    if (input.provider === 'github' && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.projectId)) throw new Error('SOURCE_CONFIG_INVALID');
    if (input.allowedPaths.some(path => path.split('/').slice(0, -1).some(part => !part || part === '..'))) throw new Error('SOURCE_CONFIG_INVALID');
    return { ...input, baseUrl: url.origin };
  }
  async load(actor: ActorContext): Promise<SourceConfig | null> {
    requireSourceReader(actor);
    const [rows] = await this.executor().execute('SELECT config_value FROM system_config WHERE config_key = ?', ['source.gitlab']);
    if (!rows.length) return null;
    try { return this.validate(JSON.parse(rows[0].config_value)); } catch { throw new Error('SOURCE_CONFIG_INVALID'); }
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
  async sync(actor: ActorContext, credentialRef: string) {
    requireSourceAdmin(actor);
    if (this.syncing) throw new Error('SOURCE_SYNC_BUSY');
    const deployment = this.deployment(); const config = await this.load(actor);
    if (!config) throw new Error('SOURCE_NOT_CONFIGURED');
    this.syncing = true;
    try {
      const token = await credentialReferenceService.consume(credentialRef, actor.userId, 'gitlab_source_sync');
      if (!token) throw new Error('SOURCE_CREDENTIAL_INVALID');
      const sourceConfig = { ...config, commitSha: deployment.commitSha, token, tokenExpiresAt: new Date(Date.now() + 15 * 60_000).toISOString() };
      const files = config.provider === 'github' ? await new GitHubSourceConnector(this.allowedOrigins).fetchFiles(sourceConfig) : await new GitLabSourceConnector(this.allowedOrigins).fetchFiles(sourceConfig as any);
      // Validate the expected deployment digest before publishing a usable snapshot.
      const { createHash } = await import('node:crypto');
      const hash = (value: string) => createHash('sha256').update(value).digest('hex');
      const descriptors = describeSourceFiles(files);
      if (hash(JSON.stringify(descriptors)) !== deployment.treeDigest) throw new Error('SOURCE_COMMIT_MISMATCH');
      const manifest = await this.snapshots().publish({ releaseId: deployment.releaseId, commitSha: deployment.commitSha, projectId: config.projectId }, files);
      await auditLogManager.logToolCall({ userId: String(actor.userId), username: actor.username, toolName: 'source_sync', toolParams: deployment, result: 'success' });
      return manifest;
    } catch (error) {
      await auditLogManager.logToolCall({ userId: String(actor.userId), username: actor.username, toolName: 'source_sync', toolParams: deployment, result: 'failure', errorMessage: 'SOURCE_SYNC_FAILED' });
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
      const binding = this.deployment(); const snapshots = this.snapshots();
      const manifest = await snapshots.manifest(binding.releaseId, binding);
      if (manifest.projectId !== config.projectId || manifest.files.some(file => !config.allowedPaths.some(path => file.path.startsWith(path)))) throw new Error('SOURCE_SNAPSHOT_POLICY_CHANGED');
      const result = mode === 'manifest' ? manifest
        : mode === 'search' ? await snapshots.search(binding.releaseId, binding, args.query as string)
        : mode === 'symbol' ? await snapshots.symbols(binding.releaseId, binding, args.name as string)
        : await snapshots.read(binding.releaseId, binding, args.path as string, args.startLine as number, args.endLine as number);
      await auditLogManager.logToolCall({ ...audit, toolParams: binding, result: 'success' });
      return result;
    } catch (error) {
      await auditLogManager.logToolCall({ ...audit, result: 'failure', errorMessage: 'SOURCE_READ_FAILED' });
      throw error;
    } finally { this.readsInFlight--; }
  }
}
export const sourceManagementService = new SourceManagementService();
