import { describe, expect, it, vi } from 'vitest';
import type { Resource } from '../../contracts/metrics/index.js';
import { postgresCounterTransport, POSTGRES_COUNTER_SQL } from '../config/postgres-counter.js';
import { createConfigurationRegistry } from '../config/registry.js';
import { MetricConfigurationReader } from '../config/status.js';
import { runPackage } from '../packages/runner.js';
import { PolicyService } from '../policy/service.js';
import { admin, MemoryPolicyStore, testResources } from '../policy/test-support.js';
import { databaseReads } from './catalog.js';

const at = '2026-11-25T03:00:00.000Z';
const ref = { type: 'instance' as const, id: 1 };
const packageId = 'postgresql-representative';
const resource = (version: string): Resource => ({ type: ref.type, id: String(ref.id), attributes: {
  'db.engine': { value: 'postgresql', observed_at: at, source: 'driver' },
  'db.version': { value: version, observed_at: at, source: 'driver' },
} });

describe('PostgreSQL 16.16 formal collection qualification', () => {
  it('recommends a distinct compatible package for the detected version and preserves the 16.4 pin', async () => {
    const registry = createConfigurationRegistry();
    const policy = new PolicyService(new MemoryPolicyStore(), registry, testResources, () => at);
    let inventory = resource('16.16');
    const reader = new MetricConfigurationReader(policy, registry, {
      inventory: async () => inventory,
      evidence: async () => { throw new Error('UNEXPECTED_EVIDENCE_READ'); },
    }, async () => [], () => at);
    const pgPackages = async () => (await reader.recommendations(admin, ref)).packages
      .filter(item => item.release.package.id.startsWith('postgresql-'));

    const detected = await pgPackages();
    expect(detected.filter(item => item.compatibility === 'compatible').map(item => item.release.package)).toEqual([
      expect.objectContaining({ id: packageId, version: '1.1.0' }),
    ]);
    expect(detected.find(item => item.recommended)?.coverage).toContainEqual({
      id: 'postgresql.transactions.commit_total', semantic_version: '1.0.0',
    });

    inventory = resource('16.4');
    const legacy = await pgPackages();
    expect(legacy.find(item => item.recommended)?.release.package).toMatchObject({
      id: packageId, version: '1.0.0',
      digest: 'sha256:4e151be2bc645f4b19964d2d5c7173537e8ed3a274dbfc49823f323b2f84d37c',
    });
    expect(legacy.find(item => item.release.package.version === '1.1.0' && item.release.package.id === packageId))
      .toMatchObject({ compatibility: 'incompatible', recommended: false });
  });

  it('runs the fixed representative reads and rejects unqualified versions before target access', async () => {
    const registry = createConfigurationRegistry();
    const release = registry.list().find(item => item.package.id === packageId && item.package.version === '1.1.0');
    expect(release).toBeDefined();
    const { id, version, digest } = release!.package;
    const fixedReads = databaseReads.filter(read => read.engine === 'postgresql');
    const outputs = new Map<string, Record<string, string | null>>([
      [fixedReads.find(read => read.name === 'connections')!.sql, { connections: '3' }],
      [fixedReads.find(read => read.name === 'limit')!.sql, { capacity: '100' }],
      [fixedReads.find(read => read.name === 'size')!.sql, { database: 'bound', bytes: '1234' }],
      [POSTGRES_COUNTER_SQL, { database: 'bound', database_oid: '16384', commits: '9007199254740993', rollbacks: '7',
        startup: '2026-11-25T02:00:00.000001Z', reset: null, sampled_at: '2026-11-25T03:00:00.000001Z' }],
    ]);
    const execute = vi.fn(async (sql: string) => {
      const row = outputs.get(sql);
      if (!row) throw new Error('UNEXPECTED_SQL');
      return { rows: [row] };
    });
    const resolve = vi.fn(async () => postgresCounterTransport(execute));
    const run = (inventory: Resource) => runPackage(registry, { package: { id, version, digest },
      credential_ref: 'credential:fixture', overrides: {} }, { resource: inventory,
      binding_id: 'binding:1', attempt_id: 'attempt:1', config_revision: 1, observed_at: at,
      evidence: {}, resolve, clock: () => at });

    for (const mismatch of ['16.4', '16.15', '16.17', '17.0']) {
      expect((await run(resource(mismatch))).decision).toBe('unsupported');
    }
    const unknown = resource('16.16');
    delete unknown.attributes['db.version'];
    expect((await run(unknown)).decision).toBe('capability_unknown');
    expect(resolve).not.toHaveBeenCalled();

    const result = await run(resource('16.16'));
    expect(result.attempts.map(attempt => attempt.status)).toEqual(['succeeded', 'succeeded', 'succeeded', 'succeeded']);
    expect(execute.mock.calls.map(([sql]) => sql).sort()).toEqual([...outputs.keys()].sort());
    expect(result.raw?.find(point => point.metric.id === 'postgresql.transactions.commit_total')).toMatchObject({
      dimensions: { database: 'bound' }, value: { encoding: 'uint64', value: '9007199254740993' },
      counter: { bits: '64', discontinuity: { epoch: expect.stringMatching(/^[a-f0-9]{64}$/), reason: 'boot' } },
      versions: { package_id: packageId, package_version: '1.1.0' },
    });
  });
});
