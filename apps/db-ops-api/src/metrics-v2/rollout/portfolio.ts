import { createHash } from 'node:crypto';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import type { ActorContext } from '../../auth/actor-context.js';
import { dbConnection } from '../../db-connection.js';
import { normalizeServerOs } from '../../server-os-profile.js';
import { createConfigurationRegistry } from '../config/registry.js';
import { type Ref, refKey } from '../policy/model.js';
import { policyService } from '../policy/service.js';
import { MysqlRolloutCoordinator } from './coordinator.js';

export type PortfolioPackage = {
  id: string;
  version: string;
  digest: string;
  resource_type: Ref['type'];
};

export type PortfolioPolicyState = {
  package: PortfolioPackage;
  revision: number;
  applied_revision: number | null;
  status: 'pending' | 'applied' | 'failed';
};

export type PortfolioRolloutState = {
  phase: 'shadow' | 'cutover_pending' | 'v2' | 'legacy';
  revision: number;
  generation: number;
  series_count: number;
  applied_series: number;
  gate_passed: boolean;
  consistent?: boolean;
};

export type ManagedMetricResource = {
  ref: Ref;
  attributes: Record<string, string>;
  collection_enabled: boolean;
  credential_ready: boolean;
  policy: PortfolioPolicyState | null;
  rollout: PortfolioRolloutState | null;
};

export interface PortfolioInventory {
  list(): Promise<ManagedMetricResource[]>;
}

type PublishRequest = { ref: Ref; package: PortfolioPackage; expected_revision: number };
type ShadowRequest = { ref: Ref; expected_revision: number };
type CutoverRequest = { ref: Ref; expected_shadow_revision: number; expected_generation: number };
type ConfirmRequest = { ref: Ref; expected_revision: number };

export interface PortfolioDependencies {
  inventory: PortfolioInventory;
  packages: PortfolioPackage[];
  publish(actor: ActorContext, request: PublishRequest): Promise<void>;
  startShadow(actor: ActorContext, request: ShadowRequest): Promise<void>;
  cutover(actor: ActorContext, request: CutoverRequest): Promise<void>;
  confirm(actor: ActorContext, request: ConfirmRequest): Promise<void>;
}

export type PortfolioBlocker =
  | 'unsupported_resource'
  | 'credential_unavailable'
  | 'collection_disabled'
  | 'policy_package_conflict'
  | 'rollout_mixed';

type PlannedResource = ManagedMetricResource & {
  key: string;
  package?: PortfolioPackage;
  blockers: PortfolioBlocker[];
};

export type PortfolioResourceStatus = {
  key: string;
  resource: Ref;
  package?: PortfolioPackage;
  blockers: PortfolioBlocker[];
  state: 'blocked' | 'unconfigured' | 'policy_pending' | 'ready_for_shadow' | PortfolioRolloutState['phase'];
};

export type PortfolioStatus = {
  plan_hash: string;
  summary: { total: number; supported: number; blocked: number; v2: number; complete: boolean };
  resources: PortfolioResourceStatus[];
};

export type PortfolioOperationResult = {
  key: string;
  outcome: 'changed' | 'blocked' | 'pending' | 'already_complete' | 'failed';
  error?: string;
};

export type PortfolioOperation = PortfolioStatus & { results: PortfolioOperationResult[] };

const stable = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
};

const errorCode = (error: unknown): string => error instanceof Error ? error.message : 'PORTFOLIO_OPERATION_FAILED';

function packageIdentity(value: Pick<PortfolioPackage, 'id' | 'version' | 'digest'>): string {
  return `${value.id}@${value.version}:${value.digest}`;
}

function versionFamily(version: string): string {
  const match = version.trim().match(/^(\d+\.\d+)/);
  return match?.[1] ?? version.trim();
}

function targetPackageId(resource: ManagedMetricResource): string | null {
  if (resource.ref.type === 'instance') {
    const engine = resource.attributes['db.engine']?.toLowerCase();
    const supported: Record<string, string[]> = {
      mysql: ['5.7', '8.0', '8.4'],
      postgresql: ['16.4'],
      oracle: ['19.3'],
      dameng: ['8.1'],
    };
    if (!engine || !supported[engine]?.includes(versionFamily(resource.attributes['db.version'] ?? ''))) return null;
    return `${engine}-representative`;
  }
  if (resource.ref.type === 'server') return resource.attributes['os.family'] === 'linux' ? 'linux-host' : null;
  return ['2', '3'].includes(resource.attributes['snmp.version'] ?? '') ? 'if-mib-basic' : null;
}

function publicState(resource: PlannedResource): PortfolioResourceStatus['state'] {
  if (resource.blockers.length) return 'blocked';
  if (!resource.policy) return 'unconfigured';
  if (resource.policy.status !== 'applied' || resource.policy.applied_revision !== resource.policy.revision) return 'policy_pending';
  return resource.rollout?.phase ?? 'ready_for_shadow';
}

export class MetricPortfolioService {
  constructor(private readonly dependencies: PortfolioDependencies) {}

  private assertAdmin(actor: ActorContext): void {
    if (!actor.permissions.includes('*')) throw new Error('PORTFOLIO_FORBIDDEN');
  }

  private async plan(actor: ActorContext): Promise<{ status: PortfolioStatus; resources: PlannedResource[] }> {
    this.assertAdmin(actor);
    const inventory = await this.dependencies.inventory.list();
    const resources = inventory.map(resource => {
      const key = refKey(resource.ref);
      const packageId = targetPackageId(resource);
      const selected = packageId
        ? this.dependencies.packages.find(item => item.resource_type === resource.ref.type && item.id === packageId)
        : undefined;
      const blockers: PortfolioBlocker[] = [];
      if (!selected) blockers.push('unsupported_resource');
      if (selected && !resource.credential_ready) blockers.push('credential_unavailable');
      if (selected && !resource.collection_enabled) blockers.push('collection_disabled');
      if (selected && resource.policy && packageIdentity(resource.policy.package) !== packageIdentity(selected)) {
        blockers.push('policy_package_conflict');
      }
      if (resource.rollout?.consistent === false) blockers.push('rollout_mixed');
      return { ...resource, key, package: selected, blockers };
    }).sort((left, right) => {
      const order: Record<Ref['type'], number> = { instance: 0, server: 1, network_device: 2 };
      return order[left.ref.type] - order[right.ref.type] || left.ref.id - right.ref.id;
    });
    const publicResources = resources.map(resource => ({
      key: resource.key,
      resource: resource.ref,
      ...(resource.package ? { package: resource.package } : {}),
      blockers: resource.blockers,
      state: publicState(resource),
    }));
    const hashInput = resources.map(resource => ({
      key: resource.key,
      attributes: resource.attributes,
      collection_enabled: resource.collection_enabled,
      credential_ready: resource.credential_ready,
      package: resource.package,
      blockers: resource.blockers,
    }));
    const plan_hash = `sha256:${createHash('sha256').update(stable(hashInput)).digest('hex')}`;
    const blocked = resources.filter(resource => resource.blockers.length > 0).length;
    const v2 = resources.filter(resource => publicState(resource) === 'v2'
      && resource.rollout?.series_count === resource.rollout.applied_series).length;
    const total = resources.length;
    return { resources, status: {
      plan_hash,
      summary: { total, supported: total - blocked, blocked, v2, complete: total > 0 && blocked === 0 && v2 === total },
      resources: publicResources,
    } };
  }

  async status(actor: ActorContext): Promise<PortfolioStatus> {
    return (await this.plan(actor)).status;
  }

  private async operate(
    actor: ActorContext,
    expectedPlanHash: string,
    operation: (resource: PlannedResource) => Promise<PortfolioOperationResult>,
  ): Promise<PortfolioOperation> {
    const current = await this.plan(actor);
    if (current.status.plan_hash !== expectedPlanHash) throw new Error('PORTFOLIO_PLAN_CHANGED');
    const results: PortfolioOperationResult[] = [];
    for (const resource of current.resources) {
      try {
        results.push(await operation(resource));
      } catch (error) {
        results.push({ key: resource.key, outcome: 'failed', error: errorCode(error) });
      }
    }
    return { ...(await this.plan(actor)).status, results };
  }

  private blocked(resource: PlannedResource): PortfolioOperationResult | null {
    return resource.blockers.length
      ? { key: resource.key, outcome: 'blocked', error: resource.blockers[0] }
      : null;
  }

  async prepare(actor: ActorContext, expectedPlanHash: string): Promise<PortfolioOperation> {
    return this.operate(actor, expectedPlanHash, async resource => {
      const blocked = this.blocked(resource);
      if (blocked) return blocked;
      if (resource.policy) {
        return { key: resource.key, outcome: resource.rollout?.phase === 'v2' ? 'already_complete' : 'pending' };
      }
      await this.dependencies.publish(actor, { ref: resource.ref, package: resource.package!, expected_revision: 0 });
      return { key: resource.key, outcome: 'changed' };
    });
  }

  async shadow(actor: ActorContext, expectedPlanHash: string): Promise<PortfolioOperation> {
    return this.operate(actor, expectedPlanHash, async resource => {
      const blocked = this.blocked(resource);
      if (blocked) return blocked;
      if (!resource.policy) return { key: resource.key, outcome: 'pending', error: 'policy_required' };
      if (resource.policy.status !== 'applied' || resource.policy.applied_revision !== resource.policy.revision) {
        return { key: resource.key, outcome: 'pending', error: 'policy_not_applied' };
      }
      if (resource.rollout) {
        return { key: resource.key, outcome: resource.rollout.phase === 'v2' ? 'already_complete' : 'pending',
          ...(resource.rollout.phase === 'legacy' ? { error: 'rollback_requires_new_shadow' } : {}) };
      }
      await this.dependencies.startShadow(actor, { ref: resource.ref, expected_revision: resource.policy.revision });
      return { key: resource.key, outcome: 'changed' };
    });
  }

  async cutover(actor: ActorContext, expectedPlanHash: string): Promise<PortfolioOperation> {
    return this.operate(actor, expectedPlanHash, async resource => {
      const blocked = this.blocked(resource);
      if (blocked) return blocked;
      if (!resource.policy || !resource.rollout) return { key: resource.key, outcome: 'pending', error: 'shadow_required' };
      if (resource.rollout.phase === 'v2') return { key: resource.key, outcome: 'already_complete' };
      if (resource.rollout.phase !== 'shadow') return { key: resource.key, outcome: 'pending', error: 'cutover_in_progress' };
      if (!resource.rollout.gate_passed) return { key: resource.key, outcome: 'pending', error: 'shadow_gate_required' };
      if (resource.policy.revision === resource.rollout.revision) {
        await this.dependencies.publish(actor, {
          ref: resource.ref,
          package: resource.package!,
          expected_revision: resource.policy.revision,
        });
      }
      await this.dependencies.cutover(actor, {
        ref: resource.ref,
        expected_shadow_revision: resource.rollout.revision,
        expected_generation: resource.rollout.generation,
      });
      return { key: resource.key, outcome: 'changed' };
    });
  }

  async confirm(actor: ActorContext, expectedPlanHash: string): Promise<PortfolioOperation> {
    return this.operate(actor, expectedPlanHash, async resource => {
      const blocked = this.blocked(resource);
      if (blocked) return blocked;
      if (resource.rollout?.phase === 'v2') return { key: resource.key, outcome: 'already_complete' };
      if (!resource.policy || resource.rollout?.phase !== 'cutover_pending') {
        return { key: resource.key, outcome: 'pending', error: 'cutover_required' };
      }
      if (resource.policy.status !== 'applied' || resource.policy.applied_revision !== resource.rollout.revision
        || resource.rollout.applied_series !== resource.rollout.series_count) {
        return { key: resource.key, outcome: 'pending', error: 'policy_not_applied' };
      }
      await this.dependencies.confirm(actor, { ref: resource.ref, expected_revision: resource.rollout.revision });
      return { key: resource.key, outcome: 'changed' };
    });
  }
}

type AssetRow = RowDataPacket & {
  resource_type: Ref['type'];
  id: number;
  attribute_one: string | null;
  attribute_two: string | null;
  collection_enabled: number;
  credential_ready: number;
};

const decode = <T>(value: T | string): T => typeof value === 'string' ? JSON.parse(value) : value;

export class MysqlPortfolioInventory implements PortfolioInventory {
  constructor(private readonly pool: Pool, private readonly packages: PortfolioPackage[]) {}

  private async assets(): Promise<ManagedMetricResource[]> {
    const [instances] = await this.pool.execute<AssetRow[]>(`SELECT 'instance' AS resource_type, id,
      LOWER(db_type) AS attribute_one, db_version AS attribute_two, status = 'active' AS collection_enabled,
      password_encrypted IS NOT NULL AND password_encrypted <> '' AS credential_ready
      FROM database_instances ORDER BY id`);
    const [servers] = await this.pool.execute<AssetRow[]>(`SELECT 'server' AS resource_type, id,
      os_type AS attribute_one, NULL AS attribute_two, collection_enabled,
      credential_encrypted IS NOT NULL AND credential_encrypted <> '' AS credential_ready
      FROM servers ORDER BY id`);
    const [devices] = await this.pool.execute<AssetRow[]>(`SELECT 'network_device' AS resource_type, d.id,
      (SELECT protocol FROM network_device_credentials c WHERE c.device_id = d.id
        AND c.protocol IN ('snmpv2c', 'snmpv3') ORDER BY protocol LIMIT 1) AS attribute_one,
      NULL AS attribute_two, d.collection_enabled,
      EXISTS(SELECT 1 FROM network_device_credentials c WHERE c.device_id = d.id
        AND c.protocol IN ('snmpv2c', 'snmpv3')) AS credential_ready
      FROM network_devices d ORDER BY d.id`);
    return [...instances, ...servers, ...devices].map(row => {
      const ref: Ref = { type: row.resource_type, id: Number(row.id) };
      const attributes = ref.type === 'instance'
        ? { 'db.engine': String(row.attribute_one ?? ''), 'db.version': String(row.attribute_two ?? '') }
        : ref.type === 'server'
          ? { 'os.family': normalizeServerOs(row.attribute_one) ? 'linux' : 'unsupported' }
          : { 'snmp.version': row.attribute_one === 'snmpv2c' ? '2' : row.attribute_one === 'snmpv3' ? '3' : 'unknown' };
      return { ref, attributes, collection_enabled: Boolean(row.collection_enabled),
        credential_ready: Boolean(row.credential_ready), policy: null, rollout: null };
    });
  }

  async list(): Promise<ManagedMetricResource[]> {
    const assets = await this.assets();
    const [policies] = await this.pool.execute<RowDataPacket[]>(
      'SELECT resource_key, payload FROM metric_v2_policy_bindings ORDER BY resource_key',
    );
    const [rollouts] = await this.pool.execute<RowDataPacket[]>(`SELECT resources.resource_key, resources.phase,
      resources.revision, resources.generation, resources.gate_json,
      COUNT(series.series_hash) AS series_count,
      COALESCE(SUM(series.applied_revision = series.published_revision), 0) AS applied_series,
      MIN(series.generation) AS min_generation, MAX(series.generation) AS max_generation,
      MIN(series.published_revision) AS min_revision, MAX(series.published_revision) AS max_revision,
      MIN(series.source) AS min_source, MAX(series.source) AS max_source,
      MIN(series.read_mode) AS min_read_mode, MAX(series.read_mode) AS max_read_mode
      FROM metric_v2_rollout_resources resources
      LEFT JOIN metric_v2_rollout series ON BINARY series.resource_type = BINARY resources.resource_type
        AND BINARY series.resource_id = BINARY resources.resource_id
      GROUP BY resources.resource_key, resources.phase, resources.revision, resources.generation, resources.gate_json
      ORDER BY resources.resource_key`);
    const policyByKey = new Map(policies.map(row => [String(row.resource_key), decode<any>(row.payload)]));
    const rolloutByKey = new Map(rollouts.map(row => [String(row.resource_key), row]));
    return assets.map(resource => {
      const key = refKey(resource.ref);
      const published = policyByKey.get(key);
      const persisted = rolloutByKey.get(key);
      const storedPin = published?.binding?.package as { id?: string; version?: string; digest?: string } | undefined;
      const knownPin = storedPin && this.packages.find(item => item.id === storedPin.id
        && item.version === storedPin.version && item.digest === storedPin.digest);
      const policy = storedPin && published?.binding?.revision
        ? {
            package: knownPin ?? { id: String(storedPin.id), version: String(storedPin.version),
              digest: String(storedPin.digest), resource_type: resource.ref.type },
            revision: Number(published.binding.revision),
            applied_revision: published.application?.applied_revision == null ? null : Number(published.application.applied_revision),
            status: published.application?.status as PortfolioPolicyState['status'],
          }
        : null;
      const rollout = persisted
        ? (() => {
          const phase = String(persisted.phase) as PortfolioRolloutState['phase'];
          const expectedSource = phase === 'v2' || phase === 'cutover_pending' ? 'v2' : 'legacy';
          const seriesCount = Number(persisted.series_count);
          return {
            phase,
            revision: Number(persisted.revision),
            generation: Number(persisted.generation),
            series_count: seriesCount,
            applied_series: Number(persisted.applied_series),
            gate_passed: persisted.gate_json !== null,
            consistent: seriesCount > 0
              && Number(persisted.min_generation) === Number(persisted.generation)
              && Number(persisted.max_generation) === Number(persisted.generation)
              && Number(persisted.min_revision) === Number(persisted.revision)
              && Number(persisted.max_revision) === Number(persisted.revision)
              && persisted.min_source === expectedSource && persisted.max_source === expectedSource
              && persisted.min_read_mode === expectedSource && persisted.max_read_mode === expectedSource,
          };
        })()
        : null;
      return { ...resource, policy, rollout };
    });
  }
}

export function createMetricPortfolioService(pool: Pool): MetricPortfolioService {
  const packages = createConfigurationRegistry().list().map(({ package: item }) => ({
    id: item.id,
    version: item.version,
    digest: item.digest,
    resource_type: item.resource_type,
  }));
  const coordinator = new MysqlRolloutCoordinator(pool);
  return new MetricPortfolioService({
    inventory: new MysqlPortfolioInventory(pool, packages),
    packages,
    publish: async (actor, request) => {
      const { resource_type: _resourceType, ...pin } = request.package;
      await policyService.changeBinding(actor, request.ref, {
        expected_revision: request.expected_revision,
        package: pin,
      }, true);
    },
    startShadow: async (actor, request) => {
      await coordinator.startShadow(request.ref, request.expected_revision, { userId: actor.userId, requestId: actor.requestId });
    },
    cutover: async (actor, request) => {
      await coordinator.cutover(request.ref, request, { userId: actor.userId, requestId: actor.requestId });
    },
    confirm: async (actor, request) => {
      await coordinator.confirmApplied(request.ref, request.expected_revision, { userId: actor.userId, requestId: actor.requestId });
    },
  });
}

export function metricPortfolioService(): MetricPortfolioService {
  const pool = dbConnection.getPool();
  if (!pool) throw new Error('PORTFOLIO_STORE_UNAVAILABLE');
  return createMetricPortfolioService(pool);
}
