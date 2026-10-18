import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActorContextService } from '../../auth/actor-context.js';
import { InvestigationResultStore } from '../../investigations/result-schema.js';
import { InvestigationEvidenceStore } from '../../investigations/evidence-store.js';
import { operationsContentHash } from '../contracts.js';
import { sourceTestConfig } from './config.fixture.js';
import { exactSource, investigateSource, proposeSource, sourceHostClock } from './runtime.js';
import type { SourceControl } from './control.js';

describe('exact source and durable proposal boundaries (synthetic)', () => {
  const requestId = randomUUID(), investigationId = randomUUID(), runId = randomUUID(), evidenceId = randomUUID();
  let proof: any;
  const control = () => ({ config: { ...sourceTestConfig(), phase: 'plan', requestId, investigationId },
    signal: new AbortController().signal, assertActive: async () => {},
    pool: { query: async () => [[]], execute: async () => [[]] } }) as unknown as SourceControl;
  beforeEach(() => {
    proof = { id: evidenceId, investigationId, requestId, runId, status: 'available', contentHash: 'a'.repeat(64),
      expiresAt: new Date(Date.now() + 600_000).toISOString(), collectedAt: new Date().toISOString(),
      observedTo: new Date().toISOString(), resources: [{ type: 'server', id: 3 }] };
    vi.spyOn(ActorContextService.prototype, 'loadInvestigationActorFrom').mockResolvedValue({} as never);
    vi.spyOn(InvestigationResultStore.prototype, 'list').mockResolvedValue({ items: [{ investigationId, requestId, runId, version: 2,
      result: { facts: [{ evidenceIds: [evidenceId] }], hypotheses: [], claims: [], recommendations: [],
        rootCauseVerification: { status: 'unverified' } } }] } as never);
    vi.spyOn(InvestigationEvidenceStore.prototype, 'get').mockImplementation(async () => proof);
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  it.each(['request', 'run', 'resource', 'expired', 'future', 'stale'])('rejects %s evidence before any HTTP send', async kind => {
    if (kind === 'request') proof.requestId = randomUUID();
    if (kind === 'run') proof.runId = randomUUID();
    if (kind === 'resource') proof.resources = [{ type: 'instance', id: 101 }];
    if (kind === 'expired') proof.expiresAt = new Date(0).toISOString();
    if (kind === 'future') proof.collectedAt = new Date(Date.now() + 10_000).toISOString();
    if (kind === 'stale') proof.observedTo = new Date(Date.now() - 121_000).toISOString();
    const send = vi.fn(); vi.stubGlobal('fetch', send);
    await expect(proposeSource(control(), 'synthetic-no-token', async () => {})).rejects.toThrow('EVIDENCE_BINDING');
    expect(send).not.toHaveBeenCalled();
  });
  it('binds the latest version and exact evidence instead of investigation-wide ACL', async () => {
    expect(await exactSource(control())).toMatchObject({ investigationId, requestId, runId, resultVersion: 2,
      evidence: [{ id: evidenceId, version: 1, hash: proof.contentHash }] });
  });
  it('fsync callback precedes submit and a lost submit response is never retried', async () => {
    const order: string[] = [], id = randomUUID();
    const send = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/api/health')) return new Response('{}', { headers: { date: new Date().toUTCString() } });
      if (url.endsWith('/submit')) { order.push('submit'); throw new Error('lost acknowledgement'); }
      const body = JSON.parse(init!.body as string);
      order.push('create');
      return Response.json({ plan: { id, version: 1, content: body.content, contentHash: operationsContentHash(body.content) } });
    });
    vi.stubGlobal('fetch', send);
    await expect(proposeSource(control(), 'synthetic-no-token', async value => {
      expect(value).toMatchObject({ planId: id, version: 1 }); order.push('durable');
    })).rejects.toThrow('lost acknowledgement');
    expect(order).toEqual(['create', 'durable', 'submit']); expect(send).toHaveBeenCalledTimes(3);
  });
  it('does not submit if durable recording fails', async () => {
    const send = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/api/health')) return new Response('{}', { headers: { date: new Date().toUTCString() } });
      const body = JSON.parse(init!.body as string);
      return Response.json({ plan: { id: randomUUID(), version: 1, content: body.content, contentHash: operationsContentHash(body.content) } });
    });
    vi.stubGlobal('fetch', send);
    await expect(proposeSource(control(), 'synthetic-no-token', async () => { throw new Error('fsync failed'); })).rejects.toThrow('fsync failed');
    expect(send).toHaveBeenCalledTimes(2);
  });
  it('rejects a malformed SSH clock protocol', async () => {
    await expect(sourceHostClock({ resolve: async () => ({ resource: {} as never, credential_ref: 'synthetic', evidence: {},
      resolve: async () => ({ method: 'ssh', client: {} as never,
        pool: { execCommands: async () => [{ stdout: 'unknown', stderr: '', exitCode: 0 }] as never } }) }) })).rejects.toThrow('CLOCK_PROTOCOL');
  });
});


describe('standalone investigation bootstrap precedes any claim or provider send', () => {
  afterEach(() => vi.restoreAllMocks());
  it('loads persisted policy and tools before reading the batch budget', async () => {
    const { agentSecurityPolicyService: policy } = await import('../../security/agent-security-policy-service.js');
    const engine = await import('../../adapter/get-agent-engine.js');
    const { OperationsBudgetJournal } = await import('../product-budget.js');
    const order: string[] = [];
    vi.spyOn(policy, 'initialize').mockImplementation(async () => { order.push('policy'); });
    vi.spyOn(engine, 'loadPlatformTools').mockImplementation(async () => { order.push('tools'); return {} as never; });
    vi.spyOn(OperationsBudgetJournal.prototype, 'read').mockImplementation(() => { order.push('budget'); throw Error('stop before send'); });
    await expect(investigateSource({} as SourceControl)).rejects.toThrow('stop before send');
    expect(order).toEqual(['policy', 'tools', 'budget']);
  });
  it('refuses initialization failure before budget/claim even if an old cache exists', async () => {
    const { agentSecurityPolicyService: policy } = await import('../../security/agent-security-policy-service.js');
    const { OperationsBudgetJournal } = await import('../product-budget.js');
    vi.spyOn(policy, 'initialize').mockRejectedValue(Error('AGENT_POLICY_STORE_UNAVAILABLE'));
    const read = vi.spyOn(OperationsBudgetJournal.prototype, 'read').mockImplementation(() => { throw Error('budget must not be reached'); });
    await expect(investigateSource({} as SourceControl)).rejects.toThrow('AGENT_POLICY_STORE_UNAVAILABLE');
    expect(read).not.toHaveBeenCalled();
  });
  it('rejects an absent policy instead of inheriting version zero', async () => {
    const { agentSecurityPolicyService: policy } = await import('../../security/agent-security-policy-service.js');
    const engine = await import('../../adapter/get-agent-engine.js');
    const { OperationsBudgetJournal } = await import('../product-budget.js');
    vi.spyOn(policy, 'initialize').mockResolvedValue();
    vi.spyOn(engine, 'loadPlatformTools').mockResolvedValue({} as never);
    vi.spyOn(policy, 'get').mockReturnValue({ version: 0 } as never);
    vi.spyOn(OperationsBudgetJournal.prototype, 'read').mockImplementation(() => { throw Error('budget reached'); });
    await expect(investigateSource({} as SourceControl)).rejects.toThrow('AGENT_POLICY_REQUIRED');
  });

});
