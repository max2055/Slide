import type { WorkflowJobInput } from './workflows/worker-runtime.js';
import type { ConsistencyCheck } from './consistency-checker.js';

const SOURCE = 'capacity-consistency-monitor';
const METRIC = 'capacity_sum_match';

interface PoolLike {
  execute<T = unknown>(sql: string, values?: unknown[]): Promise<[T, unknown?]>;
}

interface AlertWriter {
  createAlert(data: Record<string, unknown>): Promise<{ success: boolean; alertId?: number; error?: string }>;
  resolveAlert(alertId: number): Promise<{ success: boolean; error?: string }>;
}

export function createCapacityConsistencyJob(availableAt = new Date()): WorkflowJobInput {
  const slot = Math.floor(availableAt.getTime() / 300_000);
  return {
    id: `capacity-consistency-${slot}`,
    type: 'capacity.consistency',
    schemaVersion: 1,
    payload: {},
    idempotencyKey: `capacity-consistency:${slot}`,
    maxAttempts: 5,
    availableAt,
  };
}

export class CapacityConsistencyMonitor {
  constructor(
    private readonly poolProvider: () => PoolLike | null,
    private readonly checker: { _checkCapacitySumMatch(): Promise<ConsistencyCheck> },
    private readonly alerts: AlertWriter,
  ) {}

  async runOnce(): Promise<ConsistencyCheck> {
    const check = await this.checker._checkCapacitySumMatch();
    const activeIds = await this.activeAlertIds();
    if (check.status === 'pass') {
      await Promise.all(activeIds.map((id) => this.alerts.resolveAlert(id)));
      return check;
    }
    if (activeIds.length === 0) {
      const result = await this.alerts.createAlert({
        alert_type: 'capacity',
        level: check.severity === 'critical' ? 'critical' : 'warning',
        title: '容量一致性异常',
        message: check.summary,
        description: check.recommendation,
        source: SOURCE,
        metric_name: METRIC,
        metric_value: check.status,
        threshold_value: 'pass',
        tags: { checkId: check.id, details: check.details ?? null },
      });
      if (!result.success) throw new Error(result.error || 'CAPACITY_CONSISTENCY_ALERT_CREATE_FAILED');
    }
    return check;
  }

  private async activeAlertIds(): Promise<number[]> {
    const pool = this.poolProvider();
    if (!pool) throw new Error('CAPACITY_CONSISTENCY_DATABASE_UNAVAILABLE');
    const [rows] = await pool.execute<Array<{ id: number }>>(
      `SELECT id FROM alerts
       WHERE source = ? AND metric_name = ? AND status NOT IN ('resolved', 'closed')`,
      [SOURCE, METRIC],
    );
    return rows.map((row) => Number(row.id));
  }
}
