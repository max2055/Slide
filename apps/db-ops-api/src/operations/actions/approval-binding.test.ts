import { describe, expect, it } from 'vitest';
import {
  actionApprovalHash,
  approvalAuthority,
  assertPlanFresh,
  proposedContent,
} from './approval-binding.js';
import { operationsContentHash, type ActionPlanVersion } from '../contracts.js';
import type { ActorContext } from '../../auth/actor-context.js';
const actor: ActorContext = {
  userId: 1,
  username: 'author',
  roles: [],
  permissions: ['servers:manage'],
  sessionVersion: 1,
  instanceScopes: {},
  requestId: 'test',
};
const now = new Date('2026-10-17T00:00:00.000Z');
const proposal = () => ({
  schemaVersion: 1,
  investigationId: 'i',
  resultVersion: 1,
  target: { type: 'server', id: 1 },
  tool: { name: 'restart_demo_service', version: '1', hash: 'a'.repeat(64) },
  parameters: { unit: 'slide-action-demo.service' },
  evidence: [{ id: 'e', version: 1, hash: 'b'.repeat(64), validUntil: '2026-10-17T01:00:00.000Z' }],
  relations: [],
  baselines: [],
  preconditions: [{ kind: 'target_config_hash', expected: 'c'.repeat(64) }],
  risk: 'medium',
  impact: 'Dedicated demo service restart',
  policyVersion: '1',
  verifier: {
    id: 'demo-service',
    version: '1',
    definitionHash: 'd'.repeat(64),
    beforeSeconds: 120,
    readinessSeconds: 60,
    observationSeconds: 300,
    intervalSeconds: 10,
    maxExtraRestarts: 0,
    requireAllHealthy: true,
  },
  rollback: { capability: 'none', description: 'Process memory cannot be restored' },
});
describe('action approval binding', () => {
  it('uses server identity/UTC, defaults 15m, permits shortening and rejects >30m or supplied identities', () => {
    const content = proposedContent(proposal(), actor, now);
    expect(content.validUntil).toBe('2026-10-17T00:15:00.000Z');
    expect(content.author).toEqual({ kind: 'user', id: 1 });
    expect(proposedContent(proposal(), actor, now, 1000).validUntil).toBe('2026-10-17T00:00:01.000Z');
    expect(proposedContent(proposal(), actor, now, 30 * 60_000)).toBeTruthy();
    for (const ms of [0, -1, NaN, Infinity, 30 * 60_000 + 1])
      expect(() => proposedContent(proposal(), actor, now, ms)).toThrow();
    for (const key of ['author', 'requester', 'validFrom', 'validUntil'])
      expect(() => proposedContent({ ...proposal(), [key]: null }, actor, now)).toThrow();
  });
  it('hashes every field including nested verifier/precondition/identity/reference fields and plan identity', () => {
    const content = proposedContent(proposal(), actor, now);
    const plan: ActionPlanVersion = {
      id: 'p',
      version: 1,
      schemaVersion: 1,
      state: 'draft',
      content,
      contentHash: operationsContentHash(content),
    };
    const auth = approvalAuthority(actor),
      original = actionApprovalHash(plan, auth);
    const changes = [
      { investigationId: 'i2' },
      { resultVersion: 2 },
      { target: { type: 'server', id: 2 } },
      { tool: { ...content.tool, version: '2' } },
      { tool: { ...content.tool, hash: 'e'.repeat(64) } },
      { evidence: [{ ...content.evidence[0], hash: 'e'.repeat(64) }] },
      { evidence: [{ ...content.evidence[0], version: 2 }] },
      { evidence: [{ ...content.evidence[0], validUntil: '2026-10-17T00:16:00.000Z' }] },
      { relations: content.evidence },
      { baselines: content.evidence },
      { preconditions: [{ kind: 'target_config_hash', expected: 'new' }] },
      { preconditions: [] },
      { risk: 'high' },
      { impact: 'New impact' },
      { policyVersion: '2' },
      { validFrom: '2026-10-17T00:01:00.000Z' },
      { validUntil: '2026-10-17T00:14:00.000Z' },
      { verifier: { ...content.verifier, version: '2' } },
      { verifier: { ...content.verifier, definitionHash: 'e'.repeat(64) } },
      { rollback: { ...content.rollback, description: 'Different limitation' } },
      { author: { kind: 'user', id: 2 } },
      { requester: { kind: 'user', id: 2 } },
    ];
    for (const change of changes) {
      const next = { ...content, ...change } as typeof content;
      expect(
        actionApprovalHash({ ...plan, content: next, contentHash: operationsContentHash(next) }, auth),
      ).not.toBe(original);
      expect(() => actionApprovalHash({ ...plan, content: next }, auth)).toThrow();
    }
    expect(actionApprovalHash({ ...plan, id: 'other' }, auth)).not.toBe(original);
    expect(actionApprovalHash({ ...plan, version: 2 }, auth)).not.toBe(original);
    expect(actionApprovalHash(plan, { ...auth, sessionVersion: 2 })).not.toBe(original);
    expect(actionApprovalHash(plan, { ...auth, permissions: [] })).not.toBe(original);
    expect(() =>
      proposedContent({ ...proposal(), parameters: { unit: 'ssh.service' } }, actor, now),
    ).toThrow();
  });
  it('rejects expired plans/references, not-yet-valid time and tampered content', () => {
    const content = proposedContent(proposal(), actor, now);
    const p: ActionPlanVersion = {
      id: 'p',
      version: 1,
      schemaVersion: 1,
      state: 'approved',
      content,
      contentHash: operationsContentHash(content),
    };
    expect(() => assertPlanFresh(p, new Date(content.validUntil))).toThrow('OPERATIONS_EXPIRED');
    expect(() => assertPlanFresh(p, new Date(now.getTime() - 1))).toThrow('OPERATIONS_PRECONDITION_FAILED');
    expect(() => assertPlanFresh({ ...p, contentHash: 'f'.repeat(64) }, now)).toThrow();
  });
});
