export interface HealthScoreInstanceState {
  health_status?: string | null;
  hasCredential?: boolean;
  status?: string | null;
}

export interface HealthScoreState {
  ready: boolean;
  score: number | null;
  status: string;
}

/** Resolve a display score from current instance readiness and stored history. */
export function resolveHealthScoreState(
  instance: HealthScoreInstanceState | null | undefined,
  latestScore: number | null | undefined,
): HealthScoreState {
  const status = instance?.health_status || 'unknown';
  const ready = status !== 'unknown'
    && status !== 'error'
    && instance?.hasCredential === true
    && instance?.status !== 'pending_credentials'
    && instance?.status !== 'inactive'
    && instance?.status !== 'error';

  return {
    ready,
    score: ready && typeof latestScore === 'number' ? latestScore : null,
    status,
  };
}
