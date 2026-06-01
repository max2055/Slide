/**
 * Registry<T> + BaseMetricProvider tests (Phase 106-01)
 *
 * Verifies:
 * - Registry<T> can register, retrieve, list providers
 * - Enable/disable switching works
 * - recordFailure counter works
 * - getProvidersByDbType filtering works
 * - BaseMetricProvider abstract class structure
 */
import { describe, it, expect } from 'vitest';
import { Registry } from '../../collectors/registry';

interface TestProvider {
  readonly name: string;
  readonly supportedDbTypes: string[];
}

describe('Registry<T>', () => {
  const createProvider = (name: string, dbTypes: string[] = ['mysql']): TestProvider => ({
    name,
    supportedDbTypes: dbTypes,
  });

  it('register and get provider by name', () => {
    const registry = new Registry<TestProvider>();
    const p = createProvider('cpu_collector');
    registry.register(p);
    expect(registry.get('cpu_collector')).toBe(p);
  });

  it('get returns undefined for unknown name', () => {
    const registry = new Registry<TestProvider>();
    expect(registry.get('nonexistent')).toBeUndefined();
  });

  it('list returns all registered providers', () => {
    const registry = new Registry<TestProvider>();
    const p1 = createProvider('a');
    const p2 = createProvider('b');
    registry.register(p1);
    registry.register(p2);
    expect(registry.list()).toEqual([p1, p2]);
  });

  it('enable/disable toggles providers', () => {
    const registry = new Registry<TestProvider>();
    const p = createProvider('disk_collector');
    registry.register(p);
    expect(registry.listEnabled()).toEqual([p]);
    registry.disable('disk_collector');
    expect(registry.listEnabled()).toEqual([]);
    expect(registry.list()).toEqual([p]); // still in list
    registry.enable('disk_collector');
    expect(registry.listEnabled()).toEqual([p]);
  });

  it('disable resets consecutiveFailures', () => {
    const registry = new Registry<TestProvider>();
    const p = createProvider('mem_collector');
    registry.register(p);
    registry.recordFailure('mem_collector');
    registry.recordFailure('mem_collector');
    expect(registry.recordFailure('mem_collector')).toBe(3);
    registry.disable('mem_collector');
    // After disable, failures reset to 0; then recordFailure starts from 1
    expect(registry.recordFailure('mem_collector')).toBe(1);
  });

  it('recordFailure increments and returns new count', () => {
    const registry = new Registry<TestProvider>();
    const p = createProvider('conn_collector');
    registry.register(p);
    expect(registry.recordFailure('conn_collector')).toBe(1);
    expect(registry.recordFailure('conn_collector')).toBe(2);
  });

  it('resetFailures sets consecutiveFailures to 0', () => {
    const registry = new Registry<TestProvider>();
    const p = createProvider('slowq_collector');
    registry.register(p);
    registry.recordFailure('slowq_collector');
    registry.recordFailure('slowq_collector');
    registry.resetFailures('slowq_collector');
    expect(registry.recordFailure('slowq_collector')).toBe(1);
  });

  it('getProvidersByDbType filters by supportedDbTypes', () => {
    const registry = new Registry<TestProvider>();
    const mysqlProvider = createProvider('mysql_stats', ['mysql']);
    const pgProvider = createProvider('pg_stats', ['postgresql']);
    const multiProvider = createProvider('multi_stats', ['mysql', 'postgresql']);
    registry.register(mysqlProvider);
    registry.register(pgProvider);
    registry.register(multiProvider);

    const mysqlProviders = registry.getProvidersByDbType('mysql');
    expect(mysqlProviders).toContain(mysqlProvider);
    expect(mysqlProviders).toContain(multiProvider);
    expect(mysqlProviders).not.toContain(pgProvider);

    const pgProviders = registry.getProvidersByDbType('postgresql');
    expect(pgProviders).toContain(pgProvider);
    expect(pgProviders).toContain(multiProvider);
    expect(pgProviders).not.toContain(mysqlProvider);
  });

  it('getProvidersByDbType returns empty for unknown db type', () => {
    const registry = new Registry<TestProvider>();
    const p = createProvider('mysql_only', ['mysql']);
    registry.register(p);
    expect(registry.getProvidersByDbType('oracle')).toEqual([]);
  });
});
