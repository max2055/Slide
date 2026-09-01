import { describe, expect, it } from 'vitest';
import { resolveHealthScoreState } from './health-score-state.js';

describe('resolveHealthScoreState', () => {
  it('does not expose stale history as a score when the instance is unknown', () => {
    expect(resolveHealthScoreState({ health_status: 'unknown', hasCredential: false }, 100)).toEqual({
      ready: false,
      score: null,
      status: 'unknown',
    });
  });

  it('uses the current score only for a credentialed healthy instance', () => {
    expect(resolveHealthScoreState({ health_status: 'healthy', hasCredential: true }, 96)).toEqual({
      ready: true,
      score: 96,
      status: 'healthy',
    });
  });

  it('rejects pending credentials even if a stale status says healthy', () => {
    expect(resolveHealthScoreState({ health_status: 'healthy', hasCredential: true, status: 'pending_credentials' }, 100).ready).toBe(false);
  });

  it('does not expose a score when the current health status is an error', () => {
    expect(resolveHealthScoreState({ health_status: 'error', hasCredential: true, status: 'active' }, 100)).toEqual({
      ready: false,
      score: null,
      status: 'error',
    });
  });
});
