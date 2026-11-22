import type { Pool, RowDataPacket } from 'mysql2/promise';
import type { ActorContext } from '../../auth/actor-context.js';
import { decodeBindingPayload, encodeTemplatePendingPayload } from '../bindings/persistence-codec.js';
import { buildTemplateCollectionPlan } from '../bindings/plan.js';
import { resolveTemplateBinding } from '../bindings/resolve.js';
import { configurationInventory } from '../config/inventory.js';
import { createConfigurationRegistry } from '../config/registry.js';
import type { PackageRegistry } from '../packages/model.js';
import { appendConfigurationHistory } from '../policy/configuration-history.js';
import { refKey, type Ref } from '../policy/model.js';
import { connectionTemplatePool } from './binding-service.js';
import { MySqlTemplateRepository } from './mysql-repository.js';
import { MetricTemplateService } from './service.js';
import type { HashId, PackagePin, TemplatePin } from '../../contracts/metrics/templates.js';
import type { Group } from '../policy/model.js';

const operation = 'monitoring-template-upgrade';
const author: ActorContext = {
  userId: 0, username: operation, roles: [], permissions: ['metric:manage', 'metric:view'],
  sessionVersion: 0, instanceScopes: {}, requestId: operation,
};
const assetTables: Record<Ref['type'], string> = {
  instance: 'database_instances', server: 'servers', network_device: 'network_devices',
};

async function templateForRelease(repository: MySqlTemplateRepository, registry: PackageRegistry, pin: PackagePin,
  at: string): Promise<TemplatePin> {
  const templateId = `tpl-import-${pin.digest.slice(7, 39)}`;
  const existing = await repository.getTemplate(templateId);
  if (existing) {
    // This pin is the imported snapshot, even if an operator later publishes edits.
    const imported = await repository.getVersion(templateId, 1);
    if (imported) return { template_id: templateId, version: imported.version, content_hash: imported.content_hash };
    throw new Error('MONITORING_UPGRADE_TEMPLATE_CONFLICT');
  }

  const service = new MetricTemplateService(repository, registry, { now: () => at, newTemplateId: () => templateId });
  const template = await service.create(author, { name: `存量监控 · ${pin.id} ${pin.version}` });
  const draft = await repository.getDraft(templateId);
  if (!draft) throw new Error('MONITORING_UPGRADE_DRAFT_MISSING');
  const release = registry.get(pin);
  const selections = [];
  for (const metric of release.package.collectors.flatMap(collector => collector.mappings.map(mapping => mapping.metric))) {
    const { item } = await service.selectMetric(author, templateId, { package: pin, metric });
    selections.push({ item_id: item.item_id, version: item.version });
  }
  const next = await service.updateDraft(author, templateId, {
    expected_draft_revision: draft.revision, aggregate: { ...draft.aggregate,
      ...(release.derived.length ? { derive_from_inputs: true } : {}), items: selections.sort((a, b) => a.item_id < b.item_id ? -1 : 1) },
  });
  const published = await service.publish(author, templateId, {
    expected_revision: template.revision, expected_draft_revision: next.revision,
  });
  return { template_id: templateId, version: published.version, content_hash: published.content_hash };
}

/** Upgrade persisted package bindings before accepting requests or starting collection. */
export async function upgradeMonitoringBindings(pool: Pool, registry = createConfigurationRegistry()): Promise<number> {
  const connection = await pool.getConnection();
  let reusable = false;
  try {
    await connection.beginTransaction();
    let upgraded = 0;
    let resourceKey = '';
    try {
      const [lock] = await connection.execute<RowDataPacket[]>('SELECT id FROM metric_policy_lock WHERE id = 1 FOR UPDATE');
      if (lock.length !== 1) throw new Error('MONITORING_UPGRADE_LOCK_MISSING');
      const [rows] = await connection.execute<RowDataPacket[]>(
        'SELECT resource_key, group_id, payload, capabilities FROM metric_policy_bindings ORDER BY resource_key FOR UPDATE');
      const repository = new MySqlTemplateRepository(connectionTemplatePool(connection));
      for (const row of rows) {
        resourceKey = row.resource_key;
        const stored = decodeBindingPayload(row.payload);
        if (stored.kind === 'template_pending') continue;
        const { resource, revision, package: pin, group_id, overrides } = stored.binding;
        if (!pin || refKey(resource) !== resourceKey || row.group_id !== group_id) {
          throw new Error('MONITORING_UPGRADE_BINDING_IDENTITY');
        }
        const [assets] = await connection.execute<RowDataPacket[]>(
          `SELECT id FROM ${assetTables[resource.type]} WHERE id = ? FOR UPDATE`, [resource.id]);
        if (assets.length === 0) {
          const [history] = await connection.execute<RowDataPacket[]>(`SELECT id FROM metric_policy_audit
            WHERE target = ? AND JSON_EXTRACT(payload, '$.revision') = ?
            AND JSON_UNQUOTE(JSON_EXTRACT(payload, '$.configuration_history.basis')) = 'publication' LIMIT 1`,
          [resourceKey, revision]);
          if (!history.length) {
            await appendConfigurationHistory(connection, stored.payload, 'publication', String(stored.payload.published_at));
          }
          await connection.execute('DELETE FROM metric_policy_bindings WHERE resource_key = ?', [resourceKey]);
          continue;
        }
        const [groups] = group_id === null ? [[]] : await connection.execute<RowDataPacket[]>(
          'SELECT payload FROM metric_policy_groups WHERE id = ?', [group_id]);
        const group: Group | null = typeof groups[0]?.payload === 'string' ? JSON.parse(groups[0].payload) : groups[0]?.payload ?? null;
        if (group_id !== null && group === null) throw new Error('MONITORING_UPGRADE_GROUP_MISSING');

        const templatePin = await templateForRelease(repository, registry, pin, new Date().toISOString());
        const candidate = { resource, revision, package: null, group_id, template_pins: [templatePin], overrides };
        const inventory = await configurationInventory(resource, connection);
        const at = new Date().toISOString();
        const resolution = await resolveTemplateBinding(candidate, {
          resource: inventory,
          group, capabilities: typeof row.capabilities === 'string' ? JSON.parse(row.capabilities) : row.capabilities,
          at,
        }, repository, registry);
        if (resolution.kind !== 'template_resolution') throw new Error('MONITORING_UPGRADE_RESOLUTION_INVALID');
        const plan = buildTemplateCollectionPlan(resolution, { discoverCapabilities: true });
        const payload = encodeTemplatePendingPayload({
          binding: { ...candidate, revision: revision + 1 }, base_revision: revision, target_revision: revision + 1,
          plan, resolution_identity: plan.identity as HashId, operation_key: operation,
          decided_at: at, published_at: at, applied_revision: stored.effective?.revision ?? null,
          previous_resolution_identity: null, previous_effective: stored.effective,
        });
        // The historical reader must still see publications that were already
        // visible before this revision change, including manually accepted ones.
        await connection.execute(`INSERT INTO metric_source_acceptance (resource_key, revision, generation, evidence)
          SELECT ?, ?, MAX(generation), JSON_OBJECT('validation', 'existing-publication', 'publications',
            JSON_OBJECTAGG(CAST(generation AS CHAR), hashes))
          FROM (
            SELECT generation, JSON_ARRAYAGG(series_hash) AS hashes
            FROM metric_rollout WHERE resource_type = ? AND resource_id = ?
              AND source = 'semantic' AND read_mode = 'semantic' AND published_revision = ? AND applied_revision = ?
            GROUP BY generation
          ) AS accepted
          HAVING COUNT(*) > 0
          ON DUPLICATE KEY UPDATE evidence = JSON_SET(metric_source_acceptance.evidence,
            '$.publications', JSON_EXTRACT(VALUES(evidence), '$.publications'),
            '$.accepted_generation', metric_source_acceptance.generation)`,
        [resourceKey, revision, resource.type, String(resource.id), revision, revision]);
        await connection.execute('UPDATE metric_policy_bindings SET payload = ? WHERE resource_key = ?', [payload, resourceKey]);
        await appendConfigurationHistory(connection, payload, 'publication', at);
        // An interrupted package rollout cannot gate the new template's first
        // sample. Its history remains in the acceptance and audit tables.
        await connection.execute("DELETE FROM metric_rollout_resources WHERE resource_key = ? AND phase <> 'semantic'", [resourceKey]);
        upgraded++;
      }
    } catch (error) {
      await connection.rollback();
      reusable = true;
      const code = error instanceof Error && 'code' in error && typeof error.code === 'string' && /^[A-Z_]+$/.test(error.code)
        ? error.code : error instanceof Error && /^MONITORING_UPGRADE_[A-Z_]+$/.test(error.message) ? error.message : 'INVALID_DATA';
      throw new Error(`MONITORING_UPGRADE_FAILED ${resourceKey} ${code}`);
    }
    await connection.commit();
    reusable = true;
    return upgraded;
  } finally {
    if (reusable) connection.release();
    else connection.destroy();
  }
}
