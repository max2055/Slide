import { describe, expect, it, vi } from 'vitest';
import { builtinReleases } from '../packages/builtins.js';
import { databaseReleases } from '../database/catalog.js';
import {
  MetricPortfolioService,
  type ManagedMetricResource,
  type PortfolioDependencies,
} from './portfolio.js';

const actor = {
  userId: 7,
  username: 'admin',
  roles: ['admin'],
  permissions: ['*'],
  sessionVersion: 1,
  instanceScopes: {},
  requestId: 'portfolio-test',
};

const pins = [...builtinReleases(), ...databaseReleases()].map(({ package: item }) => ({
  id: item.id,
  version: item.version,
  digest: item.digest,
  resource_type: item.resource_type,
}));

const managed = (overrides: Partial<ManagedMetricResource> = {}): ManagedMetricResource => ({
  ref: { type: 'instance', id: 1 },
  attributes: { 'db.engine': 'mysql', 'db.version': '8.4.10' },
  collection_enabled: true,
  credential_ready: true,
  policy: null,
  rollout: null,
  ...overrides,
});

function dependencies(resources: ManagedMetricResource[]): PortfolioDependencies {
  return {
    inventory: { list: vi.fn(async () => structuredClone(resources)) },
    packages: pins,
    publish: vi.fn(async () => undefined),
    startShadow: vi.fn(async () => undefined),
    cutover: vi.fn(async () => undefined),
    confirm: vi.fn(async () => undefined),
  };
}

describe('Metrics V2 portfolio rollout', () => {
  it('selects immutable packages for supported managed resources and reports every blocker', async () => {
    const resources = [
      managed(),
      managed({ ref: { type: 'instance', id: 2 }, attributes: { 'db.engine': 'postgresql', 'db.version': '16.4.2' } }),
      managed({ ref: { type: 'server', id: 3 }, attributes: { 'os.family': 'linux' } }),
      managed({ ref: { type: 'network_device', id: 4 }, attributes: { 'snmp.version': '3' } }),
      managed({ ref: { type: 'instance', id: 5 }, attributes: { 'db.engine': 'mongodb', 'db.version': '7.0' } }),
      managed({ ref: { type: 'server', id: 6 }, attributes: { 'os.family': 'windows' } }),
      managed({ ref: { type: 'network_device', id: 7 }, attributes: { 'snmp.version': '2' }, credential_ready: false }),
      managed({ ref: { type: 'server', id: 8 }, attributes: { 'os.family': 'linux' }, collection_enabled: false }),
    ];
    const portfolio = await new MetricPortfolioService(dependencies(resources)).status(actor);

    expect(portfolio.resources.map(resource => [resource.key, resource.package?.id, resource.blockers])).toEqual([
      ['instance:1', 'mysql-representative', []],
      ['instance:2', 'postgresql-representative', []],
      ['server:3', 'linux-host', []],
      ['network_device:4', 'if-mib-basic', []],
      ['instance:5', undefined, ['unsupported_resource']],
      ['server:6', undefined, ['unsupported_resource']],
      ['network_device:7', 'if-mib-basic', ['credential_unavailable']],
      ['server:8', 'linux-host', ['collection_disabled']],
    ]);
    expect(portfolio.summary).toEqual({ total: 8, supported: 4, blocked: 4, v2: 0, complete: false });
    expect(portfolio.plan_hash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(JSON.stringify(portfolio)).not.toMatch(/password|community|username|host|sql|oid/i);
  });

  it('uses a deterministic plan hash and changes it when server-owned inventory changes', async () => {
    const first = await new MetricPortfolioService(dependencies([
      managed({ ref: { type: 'server', id: 9 }, attributes: { 'os.family': 'linux' } }),
      managed(),
    ])).status(actor);
    const reordered = await new MetricPortfolioService(dependencies([
      managed(),
      managed({ ref: { type: 'server', id: 9 }, attributes: { 'os.family': 'linux' } }),
    ])).status(actor);
    const changed = await new MetricPortfolioService(dependencies([
      managed(),
      managed({ ref: { type: 'server', id: 9 }, attributes: { 'os.family': 'windows' } }),
    ])).status(actor);

    expect(reordered.plan_hash).toBe(first.plan_hash);
    expect(changed.plan_hash).not.toBe(first.plan_hash);
  });

  it('prepares only unconfigured eligible resources and rejects stale or non-admin requests', async () => {
    const deps = dependencies([
      managed(),
      managed({ ref: { type: 'instance', id: 2 }, attributes: { 'db.engine': 'mongodb', 'db.version': '7.0' } }),
      managed({ ref: { type: 'server', id: 3 }, attributes: { 'os.family': 'linux' }, credential_ready: false }),
    ]);
    const service = new MetricPortfolioService(deps);
    const current = await service.status(actor);

    await expect(service.prepare({ ...actor, permissions: ['instance:manage'] }, current.plan_hash)).rejects.toThrow('PORTFOLIO_FORBIDDEN');
    await expect(service.prepare(actor, `sha256:${'0'.repeat(64)}`)).rejects.toThrow('PORTFOLIO_PLAN_CHANGED');
    const result = await service.prepare(actor, current.plan_hash);

    expect(deps.publish).toHaveBeenCalledTimes(1);
    expect(deps.publish).toHaveBeenCalledWith(actor, expect.objectContaining({ ref: { type: 'instance', id: 1 }, package: expect.objectContaining({ id: 'mysql-representative' }) }));
    expect(result.results).toEqual([
      { key: 'instance:1', outcome: 'changed' },
      { key: 'instance:2', outcome: 'blocked', error: 'unsupported_resource' },
      { key: 'server:3', outcome: 'blocked', error: 'credential_unavailable' },
    ]);
  });

  it('resumes shadow, cutover and confirm without hiding per-resource failures', async () => {
    const eligible = managed({
      policy: { package: pins.find(pin => pin.id === 'mysql-representative')!, revision: 1, applied_revision: 1, status: 'applied' },
    });
    const failed = managed({
      ref: { type: 'server', id: 2 },
      attributes: { 'os.family': 'linux' },
      policy: { package: pins.find(pin => pin.id === 'linux-host')!, revision: 1, applied_revision: 1, status: 'applied' },
    });
    const deps = dependencies([eligible, failed]);
    vi.mocked(deps.startShadow).mockRejectedValueOnce(new Error('ROLLOUT_SHADOW_EMPTY'));
    const service = new MetricPortfolioService(deps);
    const plan = await service.status(actor);
    const shadow = await service.shadow(actor, plan.plan_hash);
    expect(shadow.results).toEqual([
      { key: 'instance:1', outcome: 'failed', error: 'ROLLOUT_SHADOW_EMPTY' },
      { key: 'server:2', outcome: 'changed' },
    ]);

    const gated = [
      { ...eligible, rollout: { phase: 'shadow' as const, revision: 1, generation: 1, series_count: 2, applied_series: 2, gate_passed: true } },
      { ...failed, rollout: { phase: 'shadow' as const, revision: 1, generation: 1, series_count: 3, applied_series: 3, gate_passed: false } },
    ];
    vi.mocked(deps.inventory.list).mockResolvedValue(gated);
    const cutoverPlan = await service.status(actor);
    const cutover = await service.cutover(actor, cutoverPlan.plan_hash);
    expect(deps.publish).toHaveBeenCalledWith(actor, expect.objectContaining({ ref: { type: 'instance', id: 1 }, expected_revision: 1 }));
    expect(deps.cutover).toHaveBeenCalledWith(actor, expect.objectContaining({ ref: { type: 'instance', id: 1 }, expected_shadow_revision: 1, expected_generation: 1 }));
    expect(cutover.results.at(-1)).toEqual({ key: 'server:2', outcome: 'pending', error: 'shadow_gate_required' });

    vi.mocked(deps.inventory.list).mockResolvedValue([{ ...eligible, policy: { ...eligible.policy!, revision: 2, applied_revision: 2 }, rollout: {
      phase: 'cutover_pending', revision: 2, generation: 2, series_count: 2, applied_series: 2, gate_passed: true,
    } }]);
    const confirmPlan = await service.status(actor);
    await service.confirm(actor, confirmPlan.plan_hash);
    expect(deps.confirm).toHaveBeenCalledWith(actor, { ref: { type: 'instance', id: 1 }, expected_revision: 2 });
  });
});
