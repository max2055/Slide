import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import mysql, { type Pool, type RowDataPacket } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MigrationRunner } from '../../migrations/runner.js';
import type { MigrationPool } from '../../migrations/types.js';
import type { Resource } from '../../contracts/metrics/index.js';
import { createConfigurationRegistry } from '../config/registry.js';
import { BINDING_PAYLOAD_PACKAGE_ENVELOPE, bindingPayloadSource, decodeBindingPayload } from '../bindings/persistence-codec.js';
import { readLegacyPublished } from '../bindings/package-reader.js';
import type { Ref } from '../policy/model.js';
import { PolicyService } from '../policy/service.js';
import { MysqlPolicyStore } from '../policy/store.js';
import { admin } from '../policy/test-support.js';

/**
 * MAX-238 rollout-contract package. The coordinator and portfolio readers use the
 * shared strict fence, so the rows they read must be the ones the producer writes.
 * On a disposable schema this publishes through the existing
 * `PolicyService.changeBinding` (real resolver, real store JSON), moves the
 * application state through the existing `MysqlPolicyStore.reportApplied`, and
 * proves the stored row reads back as the legacy no-envelope form, as the
 * explicit `package-v1` carrier, and as the applied/effective snapshot whose
 * resolved value belongs to that revision. Corrupt, spliced and unknown rows
 * still fail closed with their stable codes.
 *
 * Nothing is collected, no worker starts and no route is mounted; the only
 * writes are this disposable schema's policy rows.
 */
const port = Number(process.env.METRICS_TEST_MYSQL_PORT);
const database = `max238_legacy_contract_${process.pid}`;
const evidencePath = fileURLToPath(new URL('../../../../../docs/slide/development/MAX-238/rollout-contract-20261029.json', import.meta.url));
const ref: Ref = { type: 'instance', id: 1 };
const at = '2026-10-29T00:00:00.000Z';
const registry = createConfigurationRegistry();
const packagePin = (() => {
  const { id, version, digest } = registry.list().find(item => item.package.id === 'mysql-basic')!.package;
  return { id, version, digest };
})();
const resource: Resource = { type: 'instance', id: '1', attributes: {
  'db.engine': { value: 'mysql', observed_at: at, source: 'fixture' },
  'db.version': { value: '8.4.10', observed_at: at, source: 'fixture' },
} };

const codeOf = (run: () => unknown): string | null => {
  try { run(); return null; } catch (error) { return (error as { code?: string }).code ?? 'NO_CODE'; }
};

describe.skipIf(!port)('legacy published contract read by the rollout readers', () => {
  let root: Pool;
  let pool: Pool;
  let policies: MysqlPolicyStore;
  let service: PolicyService;

  beforeAll(async () => {
    root = mysql.createPool({ host: '127.0.0.1', port, user: 'root', password: '' });
    await root.query(`CREATE DATABASE ${database}`);
    pool = mysql.createPool({ host: '127.0.0.1', port, user: 'root', password: '', database, connectionLimit: 8 });
    await new MigrationRunner(pool as unknown as MigrationPool).run();
    policies = new MysqlPolicyStore(() => pool);
    service = new PolicyService(policies, registry, {
      exists: async candidate => candidate.type === 'instance' && candidate.id === 1,
      inventory: async candidate => candidate.type === 'instance' && candidate.id === 1 ? resource : null,
    }, () => at);
  }, 180_000);

  afterAll(async () => {
    await pool?.end();
    if (root) {
      await root.query(`DROP DATABASE IF EXISTS ${database}`);
      await root.end();
    }
  });

  const rawPayload = async (): Promise<{ stored: string; parsed: Record<string, unknown> }> => {
    const [rows] = await pool.query<RowDataPacket[]>(
      'SELECT payload FROM metric_policy_bindings WHERE resource_key = ?', ['instance:1'],
    );
    const payload = rows[0].payload as string | Record<string, unknown>;
    return typeof payload === 'string'
      ? { stored: payload, parsed: JSON.parse(payload) }
      : { stored: JSON.stringify(payload), parsed: payload };
  };

  it('reads the producer row as legacy, explicit package-v1 and applied-effective', async () => {
    const evidence: Record<string, unknown> = {};
    const step = (name: string) => { evidence.current = name; };
    try {
      // 1. Real publish: PolicyService.changeBinding -> resolvePolicy -> saveBinding JSON.
      step('publish-1');
      const first = await service.changeBinding(admin, ref, { expected_revision: 0, package: packagePin }, true);
      const firstPublished = first.resources[0];
      const afterPublish = await rawPayload();
      expect(Object.hasOwn(afterPublish.parsed, 'envelope')).toBe(false);
      expect(readLegacyPublished(afterPublish.stored)).toEqual(firstPublished);
      const publishedDecoded = decodeBindingPayload(afterPublish.stored);
      expect(publishedDecoded).toMatchObject({ kind: 'legacy_published', source: 'package', effective: null, effective_missing: false });
      expect(bindingPayloadSource(afterPublish.stored)).toBe('package');
      evidence.legacy_no_envelope = {
        producer: 'PolicyService.changeBinding -> resolvePolicy -> MysqlPolicyStore.saveBinding',
        row_keys: Object.keys(afterPublish.parsed),
        revision: firstPublished.binding.revision,
        application_status: firstPublished.application.status,
        effective: publishedDecoded.effective,
        effective_missing: publishedDecoded.effective_missing,
      };

      // 2. Real apply transition, then the same row proves the effective snapshot.
      step('apply-1');
      const appliedAt = new Date(Date.parse(firstPublished.published_at) + 1000).toISOString();
      await policies.reportApplied(ref, 1, appliedAt, 'applied');
      const afterApply = await rawPayload();
      const appliedDecoded = decodeBindingPayload(afterApply.stored);
      expect(appliedDecoded).toMatchObject({ source: 'package', effective_missing: false });
      expect(appliedDecoded.effective).toMatchObject({ source: 'package', revision: 1, resolution_identity: null });
      expect(readLegacyPublished(afterApply.stored).application).toEqual({ status: 'applied', applied_revision: 1,
        reported_at: appliedAt, error_code: null });
      expect((appliedDecoded.effective as { resolved: unknown }).resolved).toEqual(readLegacyPublished(afterApply.stored).resolved);
      const appliedEffective = appliedDecoded.effective as { source: string; revision: number; resolution_identity: null;
        resolved: { plan: { binding: { package: unknown; config_revision: number }; entries: unknown[] }; settings: unknown } };
      evidence.effective_applied = { revision: 1, applied_at: appliedAt,
        effective: { source: appliedEffective.source, revision: appliedEffective.revision,
          resolution_identity: appliedEffective.resolution_identity,
          plan: { package: appliedEffective.resolved.plan.binding.package,
            config_revision: appliedEffective.resolved.plan.binding.config_revision,
            entries: appliedEffective.resolved.plan.entries.length },
          settings: appliedEffective.resolved.settings },
        effective_missing: appliedDecoded.effective_missing };

      // 3. A later publish keeps the older applied revision; the new revision has no provable snapshot.
      step('publish-2');
      const second = await service.changeBinding(admin, ref, { expected_revision: 1, package: packagePin }, true);
      expect(second.resources[0].application).toMatchObject({ status: 'pending', applied_revision: 1 });
      const afterSecond = await rawPayload();
      const secondDecoded = decodeBindingPayload(afterSecond.stored);
      expect(secondDecoded).toMatchObject({ source: 'package', effective: null, effective_missing: true });
      expect(bindingPayloadSource(afterSecond.stored)).toBe('package');
      evidence.pending_after_publish = { revision: 2, application: second.resources[0].application,
        effective: secondDecoded.effective, effective_missing: secondDecoded.effective_missing };

      // 4. The explicit package-v1 carrier holds exactly the same content.
      step('package-v1');
      const enveloped = JSON.stringify({ envelope: BINDING_PAYLOAD_PACKAGE_ENVELOPE, ...afterApply.parsed });
      const envelopedDecoded = decodeBindingPayload(enveloped);
      expect(envelopedDecoded).toMatchObject({ kind: 'legacy_published', source: 'package', effective_missing: false });
      const envelopedRead = readLegacyPublished(enveloped);
      expect(envelopedRead.binding).toEqual(firstPublished.binding);
      expect(envelopedRead.resolved).toEqual(firstPublished.resolved);
      expect(envelopedRead.application).toEqual(readLegacyPublished(afterApply.stored).application);
      expect(bindingPayloadSource(enveloped)).toBe('package');
      expect(envelopedDecoded.effective).toEqual((appliedDecoded as { effective: unknown }).effective);
      evidence.explicit_package_v1 = { envelope: BINDING_PAYLOAD_PACKAGE_ENVELOPE,
        binding_equal: JSON.stringify(envelopedRead.binding) === JSON.stringify(readLegacyPublished(afterApply.stored).binding),
        effective_equal: JSON.stringify(envelopedDecoded.effective) === JSON.stringify((appliedDecoded as { effective: unknown }).effective) };

      // 5. Damaged rows are still refused by the same fence the rollout readers use.
      step('rejections');
      const real = afterApply.parsed;
      const sparseLegacy = { binding: { resource: ref, package: packagePin, revision: 2 },
        application: { applied_revision: 2, status: 'applied' } };
      const splicedSettings = structuredClone(real) as typeof real & { resolved: { settings: { enabled: boolean } } };
      splicedSettings.resolved.settings.enabled = !splicedSettings.resolved.settings.enabled;
      const foreignPlan = structuredClone(real) as typeof real & { resolved: { plan: { binding: { resource_id: string } } } };
      foreignPlan.resolved.plan.binding.resource_id = '2';
      const wrongRevision = structuredClone(real) as typeof real & { resolved: { plan: { binding: { config_revision: number } } } };
      wrongRevision.resolved.plan.binding.config_revision = 9;
      const templateWithPackage = { envelope: 'templates-v1', binding: real.binding,
        template_resolution: { pending: {} }, application: {}, effective: null, published_at: real.published_at };
      const rejections = {
        sparse_legacy: codeOf(() => decodeBindingPayload(sparseLegacy)),
        spliced_settings: codeOf(() => decodeBindingPayload(splicedSettings)),
        foreign_plan: codeOf(() => decodeBindingPayload(foreignPlan)),
        wrong_revision: codeOf(() => decodeBindingPayload(wrongRevision)),
        unknown_envelope: codeOf(() => decodeBindingPayload({ envelope: 'v9', ...real })),
        template_envelope_with_package: codeOf(() => decodeBindingPayload(templateWithPackage)),
        invalid_json: codeOf(() => decodeBindingPayload('{not json')),
      };
      expect(rejections).toEqual({
        sparse_legacy: 'BINDING_PAYLOAD_LEGACY_INVALID',
        spliced_settings: 'BINDING_PAYLOAD_EFFECTIVE_INVALID',
        foreign_plan: 'BINDING_PAYLOAD_EFFECTIVE_INVALID',
        wrong_revision: 'BINDING_PAYLOAD_EFFECTIVE_INVALID',
        unknown_envelope: 'BINDING_PAYLOAD_UNKNOWN_ENVELOPE',
        template_envelope_with_package: 'BINDING_PAYLOAD_AMBIGUOUS_SOURCE',
        invalid_json: 'BINDING_PAYLOAD_INVALID_JSON',
      });
      evidence.rejections = rejections;
      delete evidence.current;
    } catch (error) {
      const caught = error as { name?: string; message?: string };
      evidence.error = { at: evidence.current, name: caught.name ?? 'Error', message: String(caught.message ?? error) };
      throw error;
    } finally {
      evidence.run = {
        branch: execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim(),
        head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
        test: 'legacy-published-contract.mysql.test.ts',
        disposable_schema: `${database} on 127.0.0.1:${port}, dropped by afterAll`,
        container: process.env.METRICS_TEST_MYSQL_CONTAINER ?? null,
        owner: process.env.METRICS_TEST_MYSQL_OWNER ?? null,
        nonce: process.env.METRICS_TEST_MYSQL_NONCE ?? null,
        boundaries: { publisher: 'PolicyService.changeBinding', store: 'MysqlPolicyStore saveBinding/reportApplied',
          collector_started: false, worker_started: false, route_mounted: false,
          source_tables_written: 'disposable schema only; no 3306 statements' },
      };
      writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + '\n');
    }
  }, 180_000);
});
