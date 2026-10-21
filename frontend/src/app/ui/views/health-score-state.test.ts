import { describe, expect, it } from 'vitest';
import { currentHealthStatus, evidenceTimeState, resolveHealthScoreState } from './health-score-state.js';
import type { OverviewItem } from './dashboard-model.js';

const now = Date.parse('2026-10-21T03:00:00Z');
const at = new Date(now - 60_000).toISOString();
const instance = { health_status: 'healthy', hasCredential: true, status: 'active', last_health_check_at: at };
const evidence: OverviewItem = { resource: { type: 'instance', id: 7 }, label: 'MySQL', status: 'healthy', quality: 'good', freshness: 'fresh', observedAt: at, unresolvedAlerts: 0, relationCount: 0, impactScope: [], gaps: [] };
describe('current health evidence', () => {
  it('accepts a fresh observed score and separates missing observation from stored health', () => {
    expect(resolveHealthScoreState(instance, 100, evidence, now)).toEqual({ ready: true, score: 100, status: 'healthy' });
    expect(resolveHealthScoreState(instance, 100, null, now).score).toBeNull();
    expect(currentHealthStatus(instance, null, now)).toBe('unknown');
  });
  it.each(['inactive', 'paused', 'disabled', 'pending_credentials', 'error'])('does not promote stored 100 when instance is %s', status => {
    expect(resolveHealthScoreState({ ...instance, status }, 100, evidence, now).score).toBeNull();
  });
  it.each([undefined, 'bad-date', new Date(now + 1).toISOString(), new Date(now - 300_001).toISOString()])('rejects missing, invalid, future or stale check timestamp %s', last_health_check_at => {
    expect(resolveHealthScoreState({ ...instance, last_health_check_at }, 100, evidence, now).score).toBeNull();
  });
  it('rejects stale and partial formal evidence even when the saved check says healthy', () => {
    for (const delta of [{ freshness: 'stale' as const }, { quality: 'partial' }, { gaps: ['ALERTS_UNAVAILABLE'] }, { observedAt: new Date(now - 300_001).toISOString() }]) {
      expect(resolveHealthScoreState(instance, 100, { ...evidence, ...delta }, now).score).toBeNull();
    }
  });
  it.each([NaN, Infinity, -1, 101])('rejects invalid score %s', score => {
    expect(resolveHealthScoreState(instance, score, evidence, now).score).toBeNull();
  });
  it('withholds a stored perfect score when current alerts contradict it', () => {
    expect(resolveHealthScoreState(instance, 100, { ...evidence, unresolvedAlerts: 1, alertSeverity: 'critical' }, now).score).toBeNull();
  });
  it('ages data without needing a new server snapshot', () => {
    expect(evidenceTimeState(at, now)).toContain('新鲜');
    expect(currentHealthStatus(instance, evidence, now + 300_000)).toBe('unknown');
    expect(evidenceTimeState(at, now + 300_000)).toContain('过期');
  });
});
