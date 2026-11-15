import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { assertSourceClock, assertSourceDeadline, sourceDefinitions, sourcePackageSchema } from './config.js';

import { sourceTestConfig } from './config.fixture.js';

describe('source package configuration and UTC gates', () => {
  it('binds exact raw definition bytes, fixed windows and policy version', () => {
    const d = sourceDefinitions();
    for (const [name, digest] of [['policy', d.policyHash], ['verifier', d.verifierHash]])
      expect(digest).toBe(createHash('sha256').update(readFileSync(new URL(`./definitions/${name}.json`, import.meta.url))).digest('hex'));
    expect(d.verifier).toMatchObject({ beforeSeconds: 120, readinessSeconds: 60, observationSeconds: 300,
      intervalSeconds: 10, maxExtraRestarts: 0, requireAllHealthy: true, definitionHash: d.verifierHash });
    expect(d.policy.dispatch).toBe(false);
  });
  it.each([{ database: 'mysql' }, { database: 'slide_v23_source_x;DROP' }, { serverId: 4 },
    { api: 'http://localhost:3000' }, { api: 'https://other.invalid' }, { maxMetricJobs: 13 },
    { phase: 'execute' }, { phase: 'investigate' }, { phase: 'plan' }, { alertRules: [] },
    { alertRules: [sourceTestConfig().alertRules[0], sourceTestConfig().alertRules[0]] }, { extra: true }])('rejects out of bounds input %j', value => {
    expect(sourcePackageSchema.safeParse({ ...sourceTestConfig(), ...value }).success).toBe(false);
  });
  it('accepts bounded skew but refuses future, slow, reversed, invalid and expired clocks without offsetting', () => {
    expect(() => assertSourceClock(10000, 10200, 10100)).not.toThrow();
    for (const clock of [[0, 1001, 500], [0, 1, 2002], [100, 99, 100], [0, 0, NaN]])
      expect(() => assertSourceClock(...clock as [number, number, number])).toThrow('CLOCK_UNTRUSTED');
    // PR #972 CI: use one injected clock for all deadline boundaries.
    const now = 1_000_000;
    expect(() => assertSourceDeadline({ ...sourceTestConfig(), deadline: new Date(0).toISOString() }, now)).toThrow('DEADLINE');
    expect(() => assertSourceDeadline({ ...sourceTestConfig(), deadline: new Date(now + 3_600_000).toISOString() }, now)).not.toThrow();
    expect(() => assertSourceDeadline({ ...sourceTestConfig(), deadline: new Date(now + 3_600_001).toISOString() }, now)).toThrow('DEADLINE');
    expect(() => assertSourceDeadline(sourceTestConfig(), NaN)).toThrow('DEADLINE');
  });
  it('MAX-559: covers deadline boundaries with the default clock held fixed', () => {
    const now = 1_000_000;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
      const config = sourceTestConfig();
      for (const remaining of [1, 3_600_000])
        expect(() => assertSourceDeadline({ ...config, deadline: new Date(now + remaining).toISOString() })).not.toThrow();
      for (const remaining of [-1, 0, 3_600_001])
        expect(() => assertSourceDeadline({ ...config, deadline: new Date(now + remaining).toISOString() })).toThrow('DEADLINE');
    } finally {
      clock.mockRestore();
    }
  });
});
