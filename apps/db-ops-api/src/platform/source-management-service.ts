import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { resolve } from 'node:path';
import { dbConnection } from '../db-connection.js';
import type { ActorContext } from '../auth/actor-context.js';
import { credentialReferenceService } from '../security/credential-reference-service.js';
import { auditLogManager } from '../audit/audit-log.js';
import { GitLabSourceConnector } from './gitlab-source-connector.js';
import { SourceSnapshotService } from './source-snapshot-service.js';

const ConfigSchema = Type.Object({
  baseUrl: Type.String({ maxLength: 512 }), projectId: Type.String({ pattern: '^[0-9]{1,20}$' }),
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
  constructor(private readonly pool: () => Executor | null = () => dbConnection.getPool(), private readonly allowedOrigins = (process.env.SLIDE_GITLAB_ORIGINS ?? '').split(',').map(value => value.trim()).filter(Boolean)) {}
  private executor() { const executor = this.pool(); if (!executor) throw new Error('SOURCE_STORAGE_UNAVAILABLE'); return executor; }
  private validate(input: unknown): SourceConfig {
    if (!Value.Check(ConfigSchema, input)) throw new Error('SOURCE_CONFIG_INVALID');
    let url: URL; try { url = new URL(input.baseUrl); } catch { throw new Error('SOURCE_ORIGIN_DENIED'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/' || !this.allowedOrigins.includes(url.origin)) throw new Error('SOURCE_ORIGIN_DENIED');
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
    return config;
  }
  private deployment() {
    const releaseId = process.env.SLIDE_RELEASE_ID ?? ''; const commitSha = process.env.SLIDE_COMMIT_SHA ?? ''; const treeDigest = process.env.SLIDE_SOURCE_DIGEST ?? '';
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(releaseId) || !/^[a-f0-9]{40}$/.test(commitSha) || !/^[a-f0-9]{64}$/.test(treeDigest)) throw new Error('SOURCE_DEPLOYMENT_UNKNOWN');
    return { releaseId, commitSha, treeDigest };
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
      const files = await new GitLabSourceConnector(this.allowedOrigins).fetchFiles({ ...config, commitSha: deployment.commitSha, token, tokenExpiresAt: new Date(Date.now() + 15 * 60_000).toISOString() });
      // Validate the expected deployment digest before publishing a usable snapshot.
      const { createHash } = await import('node:crypto');
      const hash = (value: string) => createHash('sha256').update(value).digest('hex');
      const descriptors = [...files].sort((a, b) => a.path.localeCompare(b.path)).map(file => ({ path: file.path, digest: hash(file.content), bytes: Buffer.byteLength(file.content) }));
      if (hash(JSON.stringify(descriptors)) !== deployment.treeDigest) throw new Error('SOURCE_COMMIT_MISMATCH');
      return await this.snapshots().publish({ releaseId: deployment.releaseId, commitSha: deployment.commitSha, projectId: config.projectId }, files);
    } finally { this.syncing = false; }
  }
  async inspect(actor: ActorContext, mode: 'manifest' | 'search' | 'read' | 'symbol', args: Record<string, unknown> = {}, model = false) {
    requireSourceReader(actor); const config = await this.load(actor);
    if (!config) throw new Error('SOURCE_NOT_CONFIGURED');
    if (model && !config.allowModelContent) throw new Error('SOURCE_MODEL_EGRESS_DENIED');
    const binding = this.deployment(); const snapshots = this.snapshots();
    await auditLogManager.logToolCall({ userId: String(actor.userId), username: actor.username, toolName: 'source_' + mode,
      toolParams: { releaseId: binding.releaseId, commitSha: binding.commitSha }, result: 'pending' });
    if (mode === 'manifest') return snapshots.manifest(binding.releaseId, binding);
    if (mode === 'search') return snapshots.search(binding.releaseId, binding, args.query as string);
    if (mode === 'symbol') return snapshots.symbols(binding.releaseId, binding, args.name as string);
    return snapshots.read(binding.releaseId, binding, args.path as string, args.startLine as number, args.endLine as number);
  }
}
export const sourceManagementService = new SourceManagementService();
