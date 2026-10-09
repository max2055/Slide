import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SourceManagementService } from './source-management-service.js';
import { registerSourceRoutes } from './source-routes.js';
import { GitSourceConnector } from './git-source-connector.js';
import { auditLogManager } from '../audit/audit-log.js';
import { decryptData } from '../db-connection.js';

const actor = { userId: 1, username: 'admin', permissions: ['admin:*'], roles: [], instanceScopes: {}, requestId: 'fixture', sessionVersion: 1 };
const base = { provider: 'gitlab' as const, baseUrl: 'https://gitlab.example.test', repositoryPath: 'group/repo', allowedPaths: ['src/'], allowModelContent: true };
const origins = [base.baseUrl, 'https://github.com', 'https://other.example.test'];
let values: Map<string, string>;
let service: SourceManagementService;
const connect = () => new SourceManagementService(() => ({ execute: async (sql: string, params: string[] = []) => {
  if (sql.startsWith('REPLACE')) values.set(params[0], params[1]);
  if (sql.startsWith('DELETE')) values.delete(params[0]);
  return [sql.startsWith('SELECT') && values.has(params[0]) ? [{ config_value: values.get(params[0]) }] : [], []];
} }), origins);
let fetchFiles: ReturnType<typeof vi.spyOn>;
beforeEach(async () => {
  values = new Map(); service = connect();
  vi.stubEnv('ENCRYPTION_KEY', 'ab'.repeat(32));
  vi.spyOn(console, 'info').mockImplementation(() => {}); vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(auditLogManager, 'logConfigChange').mockResolvedValue(undefined as any);
  vi.spyOn(auditLogManager, 'logToolCall').mockResolvedValue(undefined as any);
  fetchFiles = vi.spyOn(GitSourceConnector.prototype, 'fetchFiles').mockResolvedValue({ commitSha: 'a'.repeat(40), ref: 'main', files: [], skippedFiles: [] });
  const manifest = { releaseId: 'fixture', commitSha: 'a'.repeat(40), treeDigest: 'b'.repeat(64), files: [], projectId: base.repositoryPath, completeness: 'complete' };
  vi.spyOn(service as any, 'snapshots').mockReturnValue({ publish: async () => manifest, manifest: async () => manifest });
  await service.save(actor, base);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('saved source credentials', () => {
  it('encrypts separately, survives service recreation, and never exposes the token to config, manifest, audit or logs', async () => {
    const token = 'fixture-saved-token';
    await service.saveCredential(actor, token);
    const row = JSON.parse(values.get('source.sync-credential')!);
    expect(row.encrypted).toMatch(/^v2:/);
    expect(JSON.parse(decryptData(row.encrypted))).toMatchObject({ token, identity: row.identity });
    const restored = connect();
    expect(await restored.credentialStatus(actor)).toMatchObject({ hasSavedToken: true });
    expect(await restored.load(actor)).toEqual(base);
    await service.sync(actor, '');
    expect(fetchFiles).toHaveBeenCalledWith(expect.objectContaining({ token }));
    const modelManifest = await service.inspect(actor, 'manifest', {}, true);
    expect(JSON.stringify([await restored.load(actor), await restored.credentialStatus(actor), modelManifest, [...values], vi.mocked(console.info).mock.calls, vi.mocked(console.error).mock.calls, vi.mocked(auditLogManager.logConfigChange).mock.calls, vi.mocked(auditLogManager.logToolCall).mock.calls])).not.toContain(token);
  });
  it('keeps single-use and explicit overrides separate from persistence; empty save does not delete', async () => {
    await service.sync(actor, 'one-use'); expect(values.has('source.sync-credential')).toBe(false);
    await service.saveCredential(actor, 'saved-one');
    const first = values.get('source.sync-credential');
    await service.sync(actor, 'override'); expect(values.get('source.sync-credential')).toBe(first);
    await service.saveCredential(actor, ''); expect(values.get('source.sync-credential')).toBe(first);
    await service.sync(actor, 'replacement', { retainToken: true });
    await service.sync(actor, ''); expect(fetchFiles).toHaveBeenLastCalledWith(expect.objectContaining({ token: 'replacement' }));
    await service.deleteCredential(actor); expect(values.has('source.sync-credential')).toBe(false);
    await expect(service.sync(actor, '')).rejects.toThrow('SOURCE_CREDENTIAL_INVALID');
  });
  it.each([{ provider: 'github' }, { baseUrl: origins[2] }, { repositoryPath: 'group/other' }, { gitUsername: 'deploy-user' }])('does not reuse credentials after identity change %j', async change => {
    await service.saveCredential(actor, 'saved-token');
    const { identity } = await service.credentialStatus(actor);
    await service.save(actor, { ...base, ...change });
    expect(await service.credentialStatus(actor)).toMatchObject({ hasSavedToken: false, hasStoredToken: true });
    await expect(service.sync(actor, '')).rejects.toThrow('SOURCE_CREDENTIAL_INVALID');
    await expect(service.sync(actor, 'new-token', { expectedIdentity: identity })).rejects.toThrow('SOURCE_CONFIG_CHANGED');
    await expect(service.saveCredential(actor, 'new-token', identity)).rejects.toThrow('SOURCE_CONFIG_CHANGED');
    await expect(service.deleteCredential(actor, identity)).rejects.toThrow('SOURCE_CONFIG_CHANGED');
    expect(fetchFiles).not.toHaveBeenCalled();
  });
  it('keeps credentials when only ref or directory policy changes', async () => {
    await service.saveCredential(actor, 'saved-token');
    await service.save(actor, { ...base, ref: 'release', allowedPaths: [] });
    expect(await service.credentialStatus(actor)).toMatchObject({ hasSavedToken: true });
    await service.sync(actor, ''); expect(fetchFiles).toHaveBeenCalledWith(expect.objectContaining({ token: 'saved-token', ref: 'release' }));
  });
  it('fails closed for tampered identity/ciphertext and changed encryption keys; replacement recovers', async () => {
    await service.saveCredential(actor, 'saved-token');
    vi.stubEnv('ENCRYPTION_KEY', 'cd'.repeat(32));
    await expect(service.sync(actor, '')).rejects.toThrow('SOURCE_SAVED_CREDENTIAL_UNAVAILABLE');
    await service.saveCredential(actor, 'new-token');
    await service.sync(actor, ''); expect(fetchFiles).toHaveBeenCalledWith(expect.objectContaining({ token: 'new-token' }));
    const stored = JSON.parse(values.get('source.sync-credential')!);
    values.set('source.sync-credential', JSON.stringify({ ...stored, encrypted: stored.encrypted.slice(0, -2) + 'ff' }));
    await expect(service.sync(actor, '')).rejects.toThrow('SOURCE_SAVED_CREDENTIAL_UNAVAILABLE');
    await service.saveCredential(actor, 'new-token');
    const bound = JSON.parse(values.get('source.sync-credential')!);
    await service.save(actor, { ...base, repositoryPath: 'group/other' });
    bound.identity = (await service.credentialStatus(actor)).identity;
    values.set('source.sync-credential', JSON.stringify(bound));
    await expect(service.sync(actor, '')).rejects.toThrow('SOURCE_SAVED_CREDENTIAL_UNAVAILABLE');
    await service.deleteCredential(actor);
    expect(await service.credentialStatus(actor)).toMatchObject({ hasSavedToken: false });
  });
  it('keeps corrupt records deletable and permits encrypted replacement without loading secrets', async () => {
    values.set('source.sync-credential', '{invalid');
    expect(await service.credentialStatus(actor)).toMatchObject({ hasStoredToken: true, hasSavedToken: false, error: 'SOURCE_SAVED_CREDENTIAL_UNAVAILABLE' });
    await service.deleteCredential(actor);
    expect(await service.credentialStatus(actor)).toMatchObject({ hasStoredToken: false });
    await service.saveCredential(actor, 'replacement-fixture');
    expect(await service.credentialStatus(actor)).toMatchObject({ hasSavedToken: true });
  });
  it('does not persist failed upstream credentials and lets an invalid saved token be replaced', async () => {
    fetchFiles.mockRejectedValue(new Error('SOURCE_CREDENTIAL_INVALID'));
    await expect(service.sync(actor, 'expired-fixture', { retainToken: true })).rejects.toThrow('SOURCE_CREDENTIAL_INVALID');
    expect(values.has('source.sync-credential')).toBe(false);
    await service.saveCredential(actor, 'expired-fixture');
    await expect(service.sync(actor, '')).rejects.toThrow('SOURCE_CREDENTIAL_INVALID');
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain('expired-fixture');
  });
  it('rejects all credential mutations and sync from readers', async () => {
    const reader = { ...actor, permissions: ['config:view'] };
    await expect(service.saveCredential(reader, 'fixture')).rejects.toThrow('SOURCE_ADMIN_REQUIRED');
    await expect(service.deleteCredential(reader)).rejects.toThrow('SOURCE_ADMIN_REQUIRED');
    await expect(service.sync(reader, '')).rejects.toThrow('SOURCE_ADMIN_REQUIRED');
    expect(values.has('source.sync-credential')).toBe(false);
  });
  it('rejects credential/config mutations while sync runs, preventing deleted token resurrection', async () => {
    let finish!: (value: any) => void;
    fetchFiles.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const pending = service.sync(actor, 'fixture', { retainToken: true });
    await vi.waitFor(() => expect(finish).toBeDefined());
    await expect(service.deleteCredential(actor)).rejects.toThrow('SOURCE_SYNC_BUSY');
    await expect(service.saveCredential(actor, 'other')).rejects.toThrow('SOURCE_SYNC_BUSY');
    await expect(service.save(actor, base)).rejects.toThrow('SOURCE_SYNC_BUSY');
    finish({ commitSha: 'a'.repeat(40), ref: 'main', files: [], skippedFiles: [] }); await pending;
  });
});

it('HTTP endpoints return only status, clear request bodies and reject malformed/unauthorized writes', async () => {
  const app = Fastify(); let permissions = ['admin:*']; const bodies: any[] = [];
  await registerSourceRoutes(app, async request => { (request as any).user = { ...actor, permissions }; }, service);
  app.addHook('onResponse', async request => { if (request.body) bodies.push(request.body); });
  try {
    const put = (payload: Record<string, unknown>) => app.inject({ method: 'PUT', url: '/api/platform/source/credential', payload });
    expect((await put({ token: 'http-fixture' })).json()).toMatchObject({ hasSavedToken: true });
    const loaded = await app.inject('/api/platform/source/config');
    expect(loaded.json()).toMatchObject({ config: base, credential: { hasSavedToken: true } });
    expect(loaded.body).not.toContain('http-fixture'); expect(loaded.body).not.toContain('encrypted');
    expect((await app.inject({ method: 'POST', url: '/api/platform/source/sync', payload: {} })).statusCode).toBe(200);
    for (const payload of [{ token: null }, { token: 5 }, { token: 'x', retainToken: 'yes' }, { token: 'x', extra: 'x' }, { token: 'x', expectedIdentity: 'wrong' }]) expect((await put(payload)).statusCode).toBe(400);
    permissions = ['config:view']; expect((await put({ token: 'forbidden-fixture' })).statusCode).toBe(403);
    expect((await app.inject({ method: 'DELETE', url: '/api/platform/source/credential', payload: {} })).statusCode).toBe(403);
    permissions = ['admin:*']; expect((await app.inject({ method: 'DELETE', url: '/api/platform/source/credential', payload: {} })).json()).toMatchObject({ hasSavedToken: false });
    expect(bodies.filter(body => 'token' in body).every(body => body.token === '')).toBe(true);
  } finally { await app.close(); }
});
