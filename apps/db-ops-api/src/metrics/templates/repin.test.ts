import { describe, expect, it } from 'vitest';
import { createBuiltinRegistry } from '../packages/builtins.js';
import { InMemoryTemplateRepository } from './repository.js';
import { MetricTemplateService } from './service.js';
import { maintenanceActor, repinTemplateVersion } from './repin.js';

/**
 * MAX238-COLLECTION-DISPLAY-E2E-R1 regression: a native template item that pins
 * a release incompatible with the live target must be re-pinned only by a NEW
 * immutable template version onto an installed release with the same semantics,
 * and must never be coerced when no such release exists.
 */
const TEMPLATE_ID = 'e19c120027e04da69b130e0f6cea29fc';
const ITEM_ID = '8fbad224ebdf46e7b25a0be015f21972';
const AT = '2026-10-29T15:00:00.000Z';

const registry = createBuiltinRegistry();
function mysqlDigest(version: string): string {
  return registry.list().find(entry => entry.package.id === 'mysql-basic' && entry.package.version === version)!
    .package.digest;
}
const resource = (dbVersion: string) => ({
  type: 'instance' as const, id: '1',
  attributes: {
    'db.engine': { value: 'mysql', observed_at: AT, source: 'resource_configuration' },
    'db.version': { value: dbVersion, observed_at: AT, source: 'resource_configuration' },
  },
});

/** Publish template version 1 pinning mysql-basic@1.0.0, exactly like the import. */
async function importedTemplate() {
  const repository = new InMemoryTemplateRepository();
  const service = new MetricTemplateService(repository, registry,
    { now: () => AT, newTemplateId: () => TEMPLATE_ID, newItemId: () => ITEM_ID });
  const actor = maintenanceActor('max238-repin-test');
  await service.create(actor, { name: 'MySQL by ODBC' });
  const component = await service.selectMetric(actor, TEMPLATE_ID, {
    item_id: ITEM_ID, display_name: 'Uptime',
    package: { id: 'mysql-basic', version: '1.0.0', digest: mysqlDigest('1.0.0') },
    metric: { id: 'db.uptime_seconds', semantic_version: '1.0.0' },
  });
  const draft = await repository.getDraft(TEMPLATE_ID);
  const updated = await service.updateDraft(actor, TEMPLATE_ID, {
    expected_draft_revision: draft!.revision,
    aggregate: { ...draft!.aggregate, items: [{ item_id: ITEM_ID, version: component.item.version }] },
  });
  const template = await repository.getTemplate(TEMPLATE_ID);
  const published = await service.publish(actor, TEMPLATE_ID, {
    expected_draft_revision: updated.revision, expected_revision: template!.revision,
  });
  const current = await repository.getTemplate(TEMPLATE_ID);
  await service.setCurrent(actor, TEMPLATE_ID, { version: published.version, expected_revision: current!.revision });
  return { repository, service };
}

describe('native template version compatibility', () => {
  it('publishes a new immutable version pinning the installed release for the live target', async () => {
    const { repository } = await importedTemplate();
    const before = await repository.getVersion(TEMPLATE_ID, 1);
    expect(before!.items[0].collector_ref.package_release).toBe(`mysql-basic@1.0.0#${mysqlDigest('1.0.0')}`);

    const result = await repinTemplateVersion({ repository, registry, templateId: TEMPLATE_ID,
      resource: resource('9.6.0') as never, at: AT });
    if ('unchanged' in result) throw new Error('expected a new template version');

    expect(result.from_version).toBe(1);
    expect(result.to_version).toBe(2);
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]).toMatchObject({
      item_id: ITEM_ID,
      reason: 'target_version_incompatible',
      from: { version: 1, release: `mysql-basic@1.0.0#${mysqlDigest('1.0.0')}` },
      to: { version: 2, release: `mysql-basic@2.0.0#${mysqlDigest('2.0.0')}` },
    });

    // Version 1 and item version 1 are immutable: only a new row was appended.
    const afterV1 = await repository.getVersion(TEMPLATE_ID, 1);
    expect(afterV1!.content_hash).toBe(before!.content_hash);
    expect(afterV1!.items[0].collector_ref.package_release).toBe(`mysql-basic@1.0.0#${mysqlDigest('1.0.0')}`);
    const v2 = await repository.getVersion(TEMPLATE_ID, 2);
    expect(v2!.items[0].version).toBe(2);
    expect(v2!.items[0].collector_ref.package_release).toBe(`mysql-basic@2.0.0#${mysqlDigest('2.0.0')}`);
    expect(v2!.items[0].canonical_metric).toEqual({ id: 'db.uptime_seconds', semantic_version: '1.0.0' });
    expect(v2!.items[0].unit).toBe('s');
    expect((await repository.getTemplate(TEMPLATE_ID))!.current_published_version).toBe(2);
  });

  it('leaves an applicable template version untouched', async () => {
    const { repository } = await importedTemplate();
    const result = await repinTemplateVersion({ repository, registry, templateId: TEMPLATE_ID,
      resource: resource('8.4.0') as never, at: AT });
    expect('unchanged' in result && result.unchanged).toBe(true);
    expect((await repository.listVersions(TEMPLATE_ID)).map(summary => summary.version)).toEqual([1]);
  });

  it('refuses to re-pin when no installed release keeps the item semantics applicable', async () => {
    const { repository } = await importedTemplate();
    await expect(repinTemplateVersion({ repository, registry, templateId: TEMPLATE_ID,
      resource: resource('5.6.0') as never, at: AT }))
      .rejects.toMatchObject({ name: 'RepinError', code: 'REPIN_NO_COMPATIBLE_RELEASE' });
    expect((await repository.listVersions(TEMPLATE_ID))).toHaveLength(1);
  });
});
