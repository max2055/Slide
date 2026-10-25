import { describe, expect, it, vi } from 'vitest';
import type { ActorContext } from '../auth/actor-context.js';
import {
  CONSERVATIVE_PROFILE_LIMITS, InvestigationEffectiveBudgetError, InvestigationEffectiveBudgetService,
  type InvestigationProviderCapacity,
} from './effective-budget.js';

const capability: InvestigationProviderCapacity = {
  model: 'deepseek-v4-flash', contextWindowTokens: 1_000_000, maxOutputTokens: 393_216,
  preferredOutputTokens: 393_216, source: 'configuration',
};
const actor = { userId: 7, username: 'admin', roles: ['admin'], permissions: ['ai:view', 'config:manage'],
  sessionVersion: 1, instanceScopes: {}, requestId: 'request-1' } as ActorContext;
const runtime = { contextWindowTokens: 1_000_000, outputTokens: 393_216, summaryOutputTokens: 393_216, maxExecutionTokens: 1_000_000 };
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
    async () => source === 'configuration' ? capability : { ...capability, maxOutputTokens: undefined, source }, now);
  return { service, connection, pool, audits, get stored() { return stored; } };
}

describe('investigation effective budget', () => {
  it('derives relaxed defaults from verified provider capacity', async () => {
    const { service } = fixture();
    expect(await service.defaults()).toMatchObject({ schemaVersion: 1, version: 0, runtime, profileLimits: CONSERVATIVE_PROFILE_LIMITS, updatedAt: now() });
  });

  it('keeps conservative runtime defaults when capacity is not verified', async () => {
    const { service } = fixture(undefined, 'conservative-fallback');
    expect((await service.defaults()).runtime).toEqual({ contextWindowTokens: 8192, outputTokens: 4096, summaryOutputTokens: 4096, maxExecutionTokens: 1_000_000 });
    await expect(service.save(actor, { expectedVersion: 0, runtime, profileLimits: CONSERVATIVE_PROFILE_LIMITS }))
      .rejects.toMatchObject({ code: 'INVESTIGATION_BUDGET_CAPABILITY_UNAVAILABLE' });
  });

  it('saves a versioned document and writes who/when/old/new audit details', async () => {
    const { service, audits } = fixture();
    const saved = await service.save(actor, { expectedVersion: 0, runtime, profileLimits: { ...CONSERVATIVE_PROFILE_LIMITS, deadlineMs: 600_000 } },
      { clientIp: '127.0.0.1', userAgent: 'vitest' });
    expect(saved).toMatchObject({ version: 1, runtime, updatedBy: 7, updatedAt: now() });
    expect(audits).toHaveLength(1);
    expect(audits[0][1]).toBe('7'); expect(audits[0][2]).toBe('admin'); expect(audits[0][3]).toBe('admin');
    expect(JSON.parse(String(audits[0][4]))).toMatchObject({ previousVersion: 0, version: 1, previous: null, next: { runtime } });
  });

  it('rejects a stale version and leaves the stored document untouched', async () => {
    const previous = { schemaVersion: 1, version: 4, runtime, profileLimits: CONSERVATIVE_PROFILE_LIMITS, updatedAt: now() };
    const { service, audits } = fixture(previous);
    await expect(service.save(actor, { expectedVersion: 3, runtime, profileLimits: CONSERVATIVE_PROFILE_LIMITS }))
      .rejects.toMatchObject({ code: 'INVESTIGATION_BUDGET_CONFLICT' });
    expect(audits).toHaveLength(0);
  });

  it('rejects values beyond verified provider capacity or an invalid relation', async () => {
    const { service } = fixture();
    await expect(service.save(actor, { expectedVersion: 0,
      runtime: { ...runtime, contextWindowTokens: 2_000_000 }, profileLimits: CONSERVATIVE_PROFILE_LIMITS }))
      .rejects.toMatchObject({ code: 'INVESTIGATION_BUDGET_CONFIGURATION_INVALID' });
    await expect(service.save(actor, { expectedVersion: 0,
      runtime: { ...runtime, outputTokens: 393_217, summaryOutputTokens: 393_217 }, profileLimits: CONSERVATIVE_PROFILE_LIMITS }))
      .rejects.toMatchObject({ code: 'INVESTIGATION_BUDGET_CAPABILITY_EXCEEDED' });
    await expect(service.save(actor, { expectedVersion: 0,
      runtime: { ...runtime, maxExecutionTokens: 500_000 }, profileLimits: CONSERVATIVE_PROFILE_LIMITS }))
      .rejects.toMatchObject({ code: 'INVESTIGATION_BUDGET_CONFIGURATION_INVALID' });
    await expect(service.save(actor, { expectedVersion: 0,
      runtime: { ...runtime, contextWindowTokens: 393_216, outputTokens: 393_216, summaryOutputTokens: 393_216 }, profileLimits: CONSERVATIVE_PROFILE_LIMITS }))
      .rejects.toBeInstanceOf(InvestigationEffectiveBudgetError);
  });

  it('reads persisted settings and rejects a corrupt stored document', async () => {
    const previous = { schemaVersion: 1, version: 2, runtime, profileLimits: CONSERVATIVE_PROFILE_LIMITS, updatedAt: now() };
    const { service } = fixture(previous);
    await expect(service.get()).resolves.toMatchObject({ source: 'settings', budget: previous });
    const corrupt = fixture('{"schemaVersion":1,"version":2}');
    await expect(corrupt.service.get()).rejects.toMatchObject({ code: 'INVESTIGATION_BUDGET_CONFIGURATION_INVALID' });
  });

  it('reports the effective source and verified provider capacity', async () => {
    const { service } = fixture();
    await expect(service.view()).resolves.toMatchObject({ source: 'defaults', capabilityVerified: true,
      provider: { model: 'deepseek-v4-flash', contextWindowTokens: 1_000_000, maxOutputTokens: 393_216 } });
  });
});
