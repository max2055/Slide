import { describe, expect, it, vi } from 'vitest';
import type { ActorContext } from '../auth/actor-context.js';
import {
  CONSERVATIVE_PROFILE_LIMITS, InvestigationEffectiveBudgetError, InvestigationEffectiveBudgetService,
  admissionDomain, resolveAdmissionConfiguration, type InvestigationProviderCapacity,
} from './effective-budget.js';
import type { BudgetPolicy } from './budget-ledger.js';

const capability: InvestigationProviderCapacity = {
  model: 'deepseek-v4-flash', contextWindowTokens: 1_000_000, maxOutputTokens: 393_216,
  preferredOutputTokens: 393_216, source: 'configuration',
};
const actor = { userId: 7, username: 'admin', roles: ['admin'], permissions: ['ai:view', 'config:manage'],
  sessionVersion: 1, instanceScopes: {}, requestId: 'request-1' } as ActorContext;
const runtime = { contextWindowTokens: 1_000_000, outputTokens: 393_216, summaryOutputTokens: 393_216, maxExecutionTokens: 1_000_000 };
const basePolicy: BudgetPolicy = { currency: 'USD', maxConcurrent: 4, manualReserved: 1, maxPerResourceConcurrent: 2,
  maxAutomaticRequestsPerHour: 20, maxAutomaticTokensPerDay: 5_000_000, maxTotalTokensPerDay: 5_000_000,
  maxCostMicrosPerDay: 10_000_000 };
const admissionPolicy = { maxConcurrent: 4, manualReserved: 1, maxPerResourceConcurrent: 2, maxAutomaticRequestsPerHour: 20,
  maxAutomaticTokensPerDay: 5_000_000, maxTotalTokensPerDay: 5_000_000, maxCostMicrosPerDay: 10_000_000 };
const input = (change: Partial<typeof admissionPolicy> = {}) => ({ expectedVersion: 0, runtime,
  profileLimits: CONSERVATIVE_PROFILE_LIMITS, admissionPolicy: { ...admissionPolicy, ...change } });
const now = () => '2026-10-25T00:00:00.000Z';

function fixture(initial?: unknown, source: 'configuration' | 'conservative-fallback' = 'configuration') {
  let stored = initial === undefined ? undefined : typeof initial === 'string' ? initial : JSON.stringify(initial);
  const audits: unknown[][] = [];
  const connection = {
    beginTransaction: vi.fn(async () => {}), commit: vi.fn(async () => {}), rollback: vi.fn(async () => {}), release: vi.fn(),
    execute: vi.fn(async (sql: string, params: unknown[]) => {
      if (sql.includes('SELECT config_value')) return [stored === undefined ? [] : [{ config_value: stored }]];
      if (sql.includes('REPLACE INTO system_config')) { stored = String(params[1]); return [{}]; }
      if (sql.includes('INSERT INTO audit_log_entries')) { audits.push(params); return [{}]; }
      return [{}];
    }),
  };
  const pool = {
    execute: vi.fn(async () => [stored === undefined ? [] : [{ config_value: stored }]]),
    getConnection: vi.fn(async () => connection),
  };
  const service = new InvestigationEffectiveBudgetService(() => pool as any,
    async () => source === 'configuration' ? capability : { ...capability, maxOutputTokens: undefined, source }, now,
    () => ({ domain: 'investigation-v1', policy: basePolicy, reserveCostMicros: 1_000_000 }));
  return { service, connection, pool, audits, get stored() { return stored; } };
}

describe('investigation effective budget', () => {
  it('derives relaxed defaults from verified provider capacity, including the admission quota', async () => {
    const { service } = fixture();
    expect(await service.defaults()).toMatchObject({ schemaVersion: 1, version: 0, runtime, profileLimits: CONSERVATIVE_PROFILE_LIMITS,
      admission: { revision: 1, policy: admissionPolicy }, updatedAt: now() });
  });

  it('keeps conservative runtime defaults when capacity is not verified', async () => {
    const { service } = fixture(undefined, 'conservative-fallback');
    expect((await service.defaults()).runtime).toEqual({ contextWindowTokens: 8192, outputTokens: 4096, summaryOutputTokens: 4096, maxExecutionTokens: 1_000_000 });
    await expect(service.save(actor, input()))
      .rejects.toMatchObject({ code: 'INVESTIGATION_BUDGET_CAPABILITY_UNAVAILABLE' });
  });

  it('saves a versioned document and writes who/when/old/new audit details', async () => {
    const { service, audits } = fixture();
    const saved = await service.save(actor, { ...input(), profileLimits: { ...CONSERVATIVE_PROFILE_LIMITS, deadlineMs: 600_000 } },
      { clientIp: '127.0.0.1', userAgent: 'vitest' });
    expect(saved).toMatchObject({ version: 1, runtime, updatedBy: 7, updatedAt: now(),
      admission: { revision: 1, policy: admissionPolicy } });
    expect(audits).toHaveLength(1);
    expect(audits[0][1]).toBe('7'); expect(audits[0][2]).toBe('admin'); expect(audits[0][3]).toBe('admin');
    expect(JSON.parse(String(audits[0][4]))).toMatchObject({ previousVersion: 0, version: 1, previous: null,
      next: { runtime, admission: { revision: 1, policy: admissionPolicy } }, rotation: null });
  });

  it('rotates the domain revision only when the admission policy changes', async () => {
    const first = fixture();
    await first.service.save(actor, input());
    const saved = await first.service.save(actor, { ...input({ maxTotalTokensPerDay: 8_000_000, maxAutomaticTokensPerDay: 8_000_000 }),
      expectedVersion: 1 });
    expect(saved.admission).toMatchObject({ revision: 2, policy: { maxTotalTokensPerDay: 8_000_000 } });
    const details = JSON.parse(String(first.audits[1][4]));
    expect(details.rotation).toMatchObject({ previousRevision: 1, revision: 2,
      previousDomain: 'investigation-v1', domain: 'investigation-v1:v2' });
    expect(admissionDomain('investigation-v1', 3)).toBe('investigation-v1:v3');
    expect(admissionDomain('investigation-v1', 1)).toBe('investigation-v1');
  });

  it('keeps the revision for runtime/profile edits and resolves the current domain', async () => {
    const { service } = fixture();
    await service.save(actor, input());
    const saved = await service.save(actor, { ...input(), expectedVersion: 1,
      runtime: { ...runtime, contextWindowTokens: 500_000, outputTokens: 100_000, summaryOutputTokens: 100_000 } });
    expect(saved.admission?.revision).toBe(1);
    const view = await service.view();
    expect(view).toMatchObject({ source: 'settings', admission: { domain: 'investigation-v1', revision: 1, source: 'settings' } });
    expect(view.effective.admission?.policy).toEqual(admissionPolicy);
  });

  it('rejects cross-field policy conflicts explicitly instead of clamping', async () => {
    const { service, audits } = fixture();
    await expect(service.save(actor, input({ manualReserved: 9 })))
      .rejects.toMatchObject({ code: 'INVESTIGATION_BUDGET_POLICY_INVALID' });
    await expect(service.save(actor, input({ maxAutomaticTokensPerDay: 6_000_000 })))
      .rejects.toMatchObject({ code: 'INVESTIGATION_BUDGET_POLICY_INVALID' });
    await expect(service.save(actor, { ...input(), runtime: { ...runtime, maxExecutionTokens: 1_000_000 },
      admissionPolicy: { ...admissionPolicy, maxTotalTokensPerDay: 500_000, maxAutomaticTokensPerDay: 500_000 } }))
      .rejects.toMatchObject({ code: 'INVESTIGATION_BUDGET_POLICY_INVALID' });
    expect(audits).toHaveLength(0);
  });

  it('treats a legacy document without admission as revision 1 and adds it on save', async () => {
    const previous = { schemaVersion: 1, version: 4, runtime, profileLimits: CONSERVATIVE_PROFILE_LIMITS, updatedAt: now() };
    const { service } = fixture(previous);
    expect(resolveAdmissionConfiguration(previous as any, { domain: 'investigation-v1', policy: basePolicy, reserveCostMicros: 1_000_000 }))
      .toMatchObject({ domain: 'investigation-v1', revision: 1, source: 'defaults', policy: basePolicy });
    expect((await service.get()).budget.admission).toEqual({ revision: 1, policy: admissionPolicy });
    const saved = await service.save(actor, { ...input(), expectedVersion: 4 });
    expect(saved.admission?.revision).toBe(1);
  });

  it('rejects a stale version and leaves the stored document untouched', async () => {
    const previous = { schemaVersion: 1, version: 4, runtime, profileLimits: CONSERVATIVE_PROFILE_LIMITS, updatedAt: now() };
    const { service, audits } = fixture(previous);
    await expect(service.save(actor, { ...input(), expectedVersion: 3 }))
      .rejects.toMatchObject({ code: 'INVESTIGATION_BUDGET_CONFLICT' });
    expect(audits).toHaveLength(0);
  });

  it('rejects values beyond verified provider capacity or an invalid relation', async () => {
    const { service } = fixture();
    await expect(service.save(actor, { ...input(), runtime: { ...runtime, contextWindowTokens: 2_000_000 } }))
      .rejects.toMatchObject({ code: 'INVESTIGATION_BUDGET_CONFIGURATION_INVALID' });
    await expect(service.save(actor, { ...input(), runtime: { ...runtime, outputTokens: 393_217, summaryOutputTokens: 393_217 } }))
      .rejects.toMatchObject({ code: 'INVESTIGATION_BUDGET_CAPABILITY_EXCEEDED' });
    await expect(service.save(actor, { ...input(), runtime: { ...runtime, maxExecutionTokens: 500_000 } }))
      .rejects.toMatchObject({ code: 'INVESTIGATION_BUDGET_CONFIGURATION_INVALID' });
    await expect(service.save(actor, { ...input(), runtime: { ...runtime, contextWindowTokens: 393_216, outputTokens: 393_216, summaryOutputTokens: 393_216 } }))
      .rejects.toBeInstanceOf(InvestigationEffectiveBudgetError);
  });

  it('reads persisted settings and rejects a corrupt stored document', async () => {
    const previous = { schemaVersion: 1, version: 2, runtime, profileLimits: CONSERVATIVE_PROFILE_LIMITS,
      admission: { revision: 2, policy: admissionPolicy }, updatedAt: now() };
    const { service } = fixture(previous);
    await expect(service.get()).resolves.toMatchObject({ source: 'settings', budget: previous });
    const corrupt = fixture('{"schemaVersion":1,"version":2}');
    await expect(corrupt.service.get()).rejects.toMatchObject({ code: 'INVESTIGATION_BUDGET_CONFIGURATION_INVALID' });
  });

  it('reports the effective source and verified provider capacity', async () => {
    const { service } = fixture();
    await expect(service.view()).resolves.toMatchObject({ source: 'defaults', capabilityVerified: true,
      admission: { domain: 'investigation-v1', revision: 1, source: 'defaults' },
      provider: { model: 'deepseek-v4-flash', contextWindowTokens: 1_000_000, maxOutputTokens: 393_216 } });
  });
});
