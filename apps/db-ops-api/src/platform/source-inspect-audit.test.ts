import Fastify from 'fastify';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuditLogManager, MemoryAuditLogStore, auditLogManager } from '../audit/audit-log.js';
import { SourceManagementService, sourceManagementService } from './source-management-service.js';
import { SourceSnapshotService } from './source-snapshot-service.js';
import { registerSourceRoutes } from './source-routes.js';
import { platformTools } from '../tools/generated/slide-self-mgmt/platform_tools.js';

const actor = { userId: 1, username: 'admin', permissions: ['admin:*'], roles: [], instanceScopes: {}, requestId: 'max439', sessionVersion: 1 };
const config = { baseUrl: 'https://gitlab.example.test', repositoryPath: 'group/project', allowedPaths: ['src/'], allowModelContent: true };
const secret = 'fixture-private-diagnostic';
const signingKey = 'fixture-signing-key-'.repeat(3);
let root: string;
let store: MemoryAuditLogStore;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'slide-inspect-audit-'));
  vi.stubEnv('SLIDE_SOURCE_ROOT', root);
  vi.stubEnv('SLIDE_SOURCE_SIGNING_KEY', signingKey);
  store = new MemoryAuditLogStore();
  const manager = new AuditLogManager(store);
  // Exercise the real audit writer and queryable store without shared persistence.
  vi.spyOn(auditLogManager, 'logToolCall').mockImplementation(manager.logToolCall.bind(manager));
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

// GitHub #543 / MAX-439: real routes, inspect, signed snapshots and memory audit;
// only configuration SQL and authentication are supplied by the fixture.
describe.each([
  ['manifest', 'manifest'],
  ['search', 'search?query=selected'],
  ['read', 'region?path=src/a.ts&startLine=1&endLine=1'],
  ['symbol', 'symbol?name=selected'],
] as const)('inspect %s failure audit', (mode, path) => {
  it.each([
    ['missing config', 'SOURCE_NOT_CONFIGURED', 409],
    ['untrusted snapshot', 'SOURCE_SNAPSHOT_UNTRUSTED', 409],
    ['changed policy', 'SOURCE_SNAPSHOT_POLICY_CHANGED', 409],
    ['unknown exception', 'SOURCE_UNAVAILABLE', 503],
    ['unlisted SOURCE code', 'SOURCE_UNAVAILABLE', 503],
    ['non Error value', 'SOURCE_UNAVAILABLE', 503],
    ['filesystem failure', 'SOURCE_STORAGE_UNAVAILABLE', 503],
  ] as const)('matches API and audit for %s', async (scenario, code, status) => {
    const snapshots = new SourceSnapshotService(root, signingKey);
    const manifest = await snapshots.publish({ releaseId: 'audit-fixture', commitSha: 'a'.repeat(40), projectId: 'group/project' }, [
      { path: 'src/a.ts', content: 'export const selected = 1;\n' },
    ]);
    const reference = { releaseId: manifest.releaseId, commitSha: manifest.commitSha, treeDigest: manifest.treeDigest };
    const execute = async (_sql: string, values: string[] = []) => {
      if (values[0] === 'source.gitlab') return [scenario === 'missing config' ? [] : [{ config_value: JSON.stringify(config) }], []];
      return [[{ config_value: JSON.stringify(scenario === 'untrusted snapshot' ? { ...reference, treeDigest: 'b'.repeat(64) } : reference) }], []];
    };
    const failure = scenario === 'unknown exception' ? new Error(`Authorization: ${secret}`)
      : scenario === 'unlisted SOURCE code' ? new Error(`SOURCE_${secret.toUpperCase().replaceAll('-', '_')}`)
      : scenario === 'non Error value' ? { message: 'SOURCE_NOT_CONFIGURED', credential: secret }
      : scenario === 'filesystem failure' ? Object.assign(new Error(secret), { code: 'EACCES' }) : undefined;
    const service = new SourceManagementService(() => {
      if (failure) throw failure;
      return { execute };
    }, [config.baseUrl]);
    if (scenario === 'changed policy') {
      // Validly signed snapshot with a different repository identity.
      await snapshots.publish({ releaseId: 'other-project', commitSha: reference.commitSha, projectId: 'group/other' }, [
        { path: 'src/a.ts', content: 'export const other = 1;\n' },
      ]);
      reference.releaseId = 'other-project';
      const other = await snapshots.manifest('other-project');
      reference.treeDigest = other.treeDigest;
    }
    const app = Fastify();
    await registerSourceRoutes(app, async request => { (request as any).user = actor; }, service);
    try {
      const response = await app.inject({ method: 'GET', url: '/api/platform/source/' + path });
      expect(response.statusCode).toBe(status);
      expect(response.json()).toEqual({ error: code });
      const audit = await store.query({ action: 'source_' + mode, result: 'failure' });
      expect(audit.total).toBe(1);
      expect(audit.entries[0]).toMatchObject({ userId: '1', username: actor.username, errorMessage: response.json().error });
      expect(audit.entries[0].details).toBeUndefined();
      expect(JSON.stringify(audit)).not.toContain(secret);
      expect(JSON.stringify(audit)).not.toContain(secret.toUpperCase().replaceAll('-', '_'));
      expect(JSON.stringify(audit)).not.toContain('export const');
      expect(JSON.stringify(audit)).not.toContain(signingKey);
      expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(secret);
    } finally { await app.close(); }
  });
});

it.each(['get_deployment_manifest', 'search_source', 'read_source_region', 'get_symbol_definition'])('matches model tool %s and audit when egress is denied', async name => {
  vi.spyOn(sourceManagementService, 'load').mockResolvedValue({ ...config, allowModelContent: false });
  const tool = platformTools.find(tool => tool.name === name)!;
  const result = await tool.handler({ query: secret, path: secret, name: secret }, { actor } as any);
  expect(result).toMatchObject({ success: false, error: 'SOURCE_MODEL_EGRESS_DENIED', errorCode: 'SOURCE_MODEL_EGRESS_DENIED' });
  const audit = await store.query({ result: 'failure' });
  expect(audit.total).toBe(1);
  expect(audit.entries[0].errorMessage).toBe(result.errorCode);
  expect(audit.entries[0].details).toBeUndefined();
  expect(JSON.stringify(audit)).not.toContain(secret);
});
