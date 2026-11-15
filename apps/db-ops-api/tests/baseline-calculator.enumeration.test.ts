import { afterEach, describe, expect, it, vi } from 'vitest';
import { baselineCalculator, type BaselineResult } from '../src/baseline-calculator';
import { instanceDatabaseService, type DatabaseInstance } from '../src/instance-database-service';
import { metricRegistry } from '../src/metric-registry';

afterEach(() => vi.restoreAllMocks());

describe('computeAllBaselines enumeration (#526)', () => {
  it('computes each applicable instance metric once and preserves other target identities', async () => {
    const instances = [{ id: 71, db_type: 'mysql' }, { id: 72, db_type: 'redis' }];
    vi.spyOn(instanceDatabaseService, 'getAllInstances').mockResolvedValue(instances as DatabaseInstance[]);
    const compute = vi.spyOn(baselineCalculator, 'computeBaselineForMetric').mockImplementation(async (instanceId, metricName) => ({
      success: true,
      result: { instanceId, metricName } as BaselineResult,
    }));

    // The real default registry contains cpu_usage under both instance and server.
    const instanceCpu = metricRegistry.getById('cpu_usage', 'instance');
    const serverCpu = metricRegistry.getById('cpu_usage', 'server');
    expect(instanceCpu).not.toBeNull();
    expect(serverCpu).not.toBeNull();
    expect(serverCpu).not.toBe(instanceCpu);
    const expected = instances.flatMap(instance => metricRegistry.getAll()
      .filter(metric => (metric.target_type ?? 'instance') === 'instance' && metric.db_types.includes(instance.db_type))
      .map(metric => [instance.id, metric.id, 3, 5]));

    const result = await baselineCalculator.computeAllBaselines(3, 5);

    expect(compute.mock.calls).toEqual(expected);
    expect(new Set(compute.mock.calls.map(([id, metric]) => `${id}:${metric}`)).size).toBe(expected.length);
    expect(result).toEqual({ success: expected.length, failed: 0, results: expected.map(([instanceId, metricName]) => ({ instanceId, metricName })) });
    expect(metricRegistry.getById('cpu_usage', 'server')).toBe(serverCpu);
    expect(metricRegistry.getAll('network_device').length).toBeGreaterThan(0);
  });

  it('counts each failed pair once and returns successful results only', async () => {
    vi.spyOn(instanceDatabaseService, 'getAllInstances').mockResolvedValue([{ id: 73, db_type: 'mysql' }] as DatabaseInstance[]);
    const compute = vi.spyOn(baselineCalculator, 'computeBaselineForMetric').mockImplementation(async (instanceId, metricName) => (
      metricName === 'cpu_usage' ? { success: false, error: 'METRIC_BASELINE_INSUFFICIENT_SAMPLES' }
        : { success: true, result: { instanceId, metricName } as BaselineResult }
    ));
    const result = await baselineCalculator.computeAllBaselines();
    expect(result.failed).toBe(1);
    expect(result.success).toBe(metricRegistry.getByDbType('mysql').length - 1);
    expect(result.results).toHaveLength(result.success);
    expect(result.results.some(row => row.metricName === 'cpu_usage')).toBe(false);
    expect(compute.mock.calls.filter(([, metric]) => metric === 'cpu_usage')).toEqual([[73, 'cpu_usage', 2, 7]]);
  });

  it('does no work for an empty instance list', async () => {
    vi.spyOn(instanceDatabaseService, 'getAllInstances').mockResolvedValue([]);
    const compute = vi.spyOn(baselineCalculator, 'computeBaselineForMetric');
    expect(await baselineCalculator.computeAllBaselines()).toEqual({ success: 0, failed: 0, results: [] });
    expect(compute).not.toHaveBeenCalled();
  });
});
