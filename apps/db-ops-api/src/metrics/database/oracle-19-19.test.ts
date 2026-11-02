import { describe, expect, it } from 'vitest';
import { createConfigurationRegistry } from '../config/registry.js';
import { databaseReleases, capacityReleases, databaseReads, oracle1919Reads, implementationId } from './catalog.js';
import { runPackage } from '../packages/runner.js';
import { collectDatabase } from './collector.js';
import { checkApplicability } from '../packages/applicability.js';

const at = '2026-11-02T08:00:00Z';
const resource = (version: string) => ({ type: 'instance' as const, id: '901', attributes: {
  'db.engine': { value: 'oracle', observed_at: at, source: 'driver' },
  'db.version': { value: version, observed_at: at, source: 'driver' },
} });
describe('explicit Oracle 19.19 compatibility', () => {
  it('preserves both published Oracle pins and their original 19.3 boundary', () => {
    const old = [...databaseReleases(), ...capacityReleases()].filter(r => r.package.id === 'oracle-representative');
    expect(old.map(r => r.package.digest)).toEqual([
      'sha256:6cf602995e5303fd97dd11e4a0f149764a145e4d1224e6cd05cb32dbd8714993',
      'sha256:c9674f2f8c27e917281042c868506d0f14fc43425b359aad74af8e792757b3c2',
    ]);
    for (const r of old) expect(checkApplicability(r.package, resource('19.19.0.0.0'), at).some(c => c.status === 'unsupported')).toBe(true);
  });
  it('selects only the explicit family and maps the same fixed reads under new identities', async () => {
    const registry = createConfigurationRegistry();
    const release = registry.list().find(r => r.package.id === 'oracle-representative' && r.package.version === '1.2.0')!;
    expect(checkApplicability(release.package, resource('19.19.0.0.0'), at).every(c => c.status === 'supported')).toBe(true);
    for (const version of ['19.3', '19.20', '21.0']) expect(checkApplicability(release.package, resource(version), at).some(c => c.status === 'unsupported')).toBe(true);
    let requests = 0;
    const { id, version, digest } = release.package;
    const result = await runPackage(registry, { package: { id, version, digest }, credential_ref: 'credential:oracle-901', overrides: {} }, {
      resource: resource('19.20'), binding_id: 'oracle-901', attempt_id: 'wrong-version', config_revision: 1, observed_at: at, evidence: {},
      resolve: async () => { requests++; throw Error('UNEXPECTED_TARGET_IO'); },
    });
    expect(result.decision).toBe('unsupported'); expect(requests).toBe(0);
    expect(oracle1919Reads.map(r => r.sql)).toEqual(databaseReads.filter(r => r.engine === 'oracle').map(r => r.sql));
    const read = oracle1919Reads.find(r => r.name === 'transactions_19_19')!;
    const [row] = await collectDatabase(implementationId(read), { method: 'sql', pool: { query: async () => [[['9007199254740993']], []] } }, {}, 1000);
    expect(row.fields.commits).toEqual({ encoding: 'uint64', value: '9007199254740993' });
  });
});
