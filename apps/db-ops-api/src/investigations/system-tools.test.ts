import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createSystemTools, systemInvestigationHistory } from './system-tools.js';
import { InvestigationStoreError } from './store.js';

function fixture() {
  const commitSha = 'a'.repeat(40), treeDigest = 'b'.repeat(64);
  const deployment = { releaseId: 'runtime-release', commitSha, treeDigest };
  const manifest = { schemaVersion: 1, releaseId: 'snapshot-release', commitSha, treeDigest, completeness: 'complete',
    verification: { status: 'deployment-verified', deployment }, files: [{ path: 'src/a.ts' }] };
  const fact: any = { event: { commitSha, releaseId: deployment.releaseId } };
  const connection = { beginTransaction: vi.fn(), commit: vi.fn(), rollback: vi.fn(), release: vi.fn() };
  const pool: any = { getConnection: vi.fn(async () => connection) };
  const authority: any = { load: vi.fn(async () => ({ profileId: 'system' })), authorize: vi.fn(async () => ({ actor: {},
    tools: ['get_platform_observations', 'get_deployment_manifest', 'search_source', 'read_source_region', 'get_symbol_definition'] })) };
  const bridge = { readFacts: vi.fn(async () => [fact]) };
  const source = { inspect: vi.fn(async (_actor, mode) => mode === 'manifest' ? manifest : ({ content: 'export const original = 1;', source: manifest })) };
  const options: any = { caller: { userId: 1, roles: [], permissions: ['config:view'], instanceScopes: {}, sessionVersion: 1 },
    pool: () => pool, scope: { investigationId: randomUUID(), component: 'api', from: '2026-10-13T12:00:00Z', to: '2026-10-13T12:05:00Z' },
    authorization: authority, bridge, source, deployment: () => deployment };
  const tools = createSystemTools(options);
  const call = (name = 'read_source_region', args: any = { path: 'src/a.ts', startLine: 1, endLine: 5 }) => tools.find(t => t.name === name)!.handler(args);
  return { options, deployment, manifest, fact, bridge, source, authority, call, tools };
}
describe('System evidence tools', () => {
  it('projects historical tool bodies to immutable references without modifying stored facts or replaying their authority', () => {
    const original = {id:randomUUID(),role:'tool' as const,name:'read_source_region',tool_call_id:'original-call',content:JSON.stringify({success:true,data:{content:'untrusted source'.repeat(1000),quality:'good'}})};
    const before=JSON.stringify(original), projected=systemInvestigationHistory([
      {id:'original-assistant',role:'assistant',content:null,tool_calls:[{id:'original-call',type:'function',function:{name:'read_source_region',arguments:'{}'}}]},original,
    ]);
    expect(JSON.stringify(original)).toBe(before);expect(projected).toHaveLength(2);
    expect(projected[1].content!.length).toBeLessThan(600);expect(projected[1].content).not.toContain('untrusted source');
    expect(projected[1].content).toContain(original.id);expect(projected[1].source).toBe('derived');
    expect(projected[1].content).toContain('requiresCurrentRead');
    expect(systemInvestigationHistory([original])).toHaveLength(0);
  });
  it('returns only exact event/deployment/signed-manifest content and labels implementation intent', async () => {
    const f = fixture(); const result = await f.call();
    expect(result).toMatchObject({ success: true, data: { content: 'export const original = 1;', rootCauseVerified: false, interpretation: 'implementation-intent' } });
    expect(f.source.inspect.mock.calls.map(c => c[1])).toEqual(['manifest', 'read']);
    expect(f.authority.authorize).toHaveBeenCalledTimes(3);
    expect(f.tools).toHaveLength(5); expect(f.tools.every(t => t.readOnly && !t.requiresApproval)).toBe(true);
  });
  it.each(['missing', 'mismatch', 'mixed', 'deployment'] as const)('%s version returns a gap before any repository content read', async kind => {
    const f = fixture();
    if (kind === 'missing') delete f.fact.event.commitSha;
    if (kind === 'mismatch') f.fact.event.commitSha = 'c'.repeat(40);
    if (kind === 'mixed') f.bridge.readFacts.mockResolvedValue([f.fact, { event: { commitSha: 'c'.repeat(40), releaseId: 'other' } }] as any);
    if (kind === 'deployment') f.options.deployment = () => { throw new Error('SOURCE_DEPLOYMENT_UNKNOWN'); };
    const result = await f.call();
    expect(result).toMatchObject({ success: true, status: 'warning', data: { quality: 'unknown', gaps: [expect.stringMatching(/^SOURCE_/)] } });
    expect(f.source.inspect).not.toHaveBeenCalled();
  });
  it.each(['partial', 'wrong-commit', 'wrong-digest', 'unbound'])('%s manifest never yields content', async kind => {
    const f = fixture();
    if (kind === 'partial') f.manifest.completeness = 'partial';
    if (kind === 'wrong-commit') f.manifest.commitSha = 'c'.repeat(40);
    if (kind === 'wrong-digest') f.manifest.treeDigest = 'c'.repeat(64);
    if (kind === 'unbound') f.manifest.verification.status = 'repository-unbound';
    expect(await f.call()).toMatchObject({ data: { quality: 'unknown', gaps: [expect.any(String)] } });
    expect(f.source.inspect).toHaveBeenCalledTimes(1);
  });
  it('drops content if current snapshot changes between manifest and region read', async () => {
    const f = fixture();
    f.source.inspect.mockImplementation(async (_a, mode) => mode === 'manifest' ? f.manifest :
      ({ content: 'wrong-version', source: { ...f.manifest, commitSha: 'c'.repeat(40) } }) as any);
    const result = await f.call();
    expect(result).toMatchObject({ data: { gaps: ['SOURCE_COMMIT_MISMATCH'] } });
    expect(JSON.stringify(result)).not.toContain('wrong-version');
  });
  it('drops content if deployment changes during IO', async () => {
    const f = fixture(); let count = 0;
    f.options.deployment = () => count++ ? { ...f.deployment, releaseId: 'other' } : f.deployment;
    expect(await f.call()).toMatchObject({ data: { gaps: ['SOURCE_COMMIT_MISMATCH'] } });
  });
  it('rechecks live grants/tool policy and withholds content when revoked during IO', async () => {
    const f = fixture();
    f.source.inspect.mockImplementation(async (_a, mode) => {
      if (mode === 'read') f.authority.authorize.mockRejectedValue(new InvestigationStoreError('INVESTIGATION_NOT_FOUND'));
      return mode === 'manifest' ? f.manifest : { content: 'must-not-send', source: f.manifest } as any;
    });
    await expect(f.call()).rejects.toMatchObject({ code: 'INVESTIGATION_NOT_FOUND' });
    const denied = fixture(); denied.authority.authorize.mockResolvedValue({ actor: {}, tools: [] });
    await expect(denied.call()).rejects.toMatchObject({ code: 'INVESTIGATION_OPERATION_FORBIDDEN' });
    expect(denied.source.inspect).not.toHaveBeenCalled();
  });
  it('forbids model-selected context/version and forwards cancellation before IO', async () => {
    const f = fixture();
    await expect(f.call('read_source_region', { path: 'src/a.ts', startLine: 1, endLine: 5, ref: 'main' })).rejects.toThrow('SYSTEM_TOOL_ARGUMENT_INVALID');
    const controller = new AbortController(); controller.abort();
    await expect(f.tools[0].handler({}, { signal: controller.signal })).rejects.toThrow();
    expect(f.bridge.readFacts).not.toHaveBeenCalled();
  });
  it('turns source errors into bounded gaps without propagating credentials', async () => {
    const f = fixture(); f.source.inspect.mockRejectedValue(new Error('password=private'));
    const result = await f.call();
    expect(result).toMatchObject({ data: { gaps: ['SOURCE_UNAVAILABLE'] } });
    expect(JSON.stringify(result)).not.toContain('private');
  });
  it('marks missing logs unknown and bounds durable facts without pretending complete coverage', async () => {
    const f = fixture(); f.options.logs = { query: () => ({ gaps: ['LOG_EVIDENCE_MISSING'], groups: [], quality: 'unknown' }) };
    f.bridge.readFacts.mockResolvedValue(Array.from({ length: 101 }, () => ({ ...f.fact, raw: { outcome: 'x'.repeat(1000) } })) as any);
    const result = await f.call('get_platform_observations', {});
    expect(result).toMatchObject({ data: { persistence: 'mysql', quality: 'degraded', gaps: expect.arrayContaining(['LOG_EVIDENCE_MISSING', 'DURABLE_EVENTS_TRUNCATED']) } });
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(128_000);
    expect((result.data as any).facts.length).toBeLessThan(100);
    expect(f.source.inspect).not.toHaveBeenCalled();
  });
});
