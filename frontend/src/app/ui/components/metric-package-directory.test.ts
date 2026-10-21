import { expect, it } from 'vitest';
import { packageGroups, packageMetrics, compatibilityLabel, type Release, type PackageEvidence } from './metric-package-directory.js';

const release = (version: string, id = 'mysql-basic'): Release => ({ package: { id, version, digest: `${id}@${version}`, resource_type: 'instance', applicability: [],
  collectors: [{ mappings: [{ metric: { id: 'db.uptime_seconds' } }, { metric: { id: 'db.uptime_seconds' } }] }] },
  derived: [{ output: { id: 'mysql.queries.per_second' } }], recommendations: {}, documentation: [] });
const evidence = (release: Release, compatibility: PackageEvidence['compatibility'], recommended = false): PackageEvidence => ({
  release, compatibility, recommended, coverage: [], missing_core_metrics: [], checks: [],
});
it('groups exact IDs without mutating or dropping immutable releases, including distinct diagnostic IDs', () => {
  const input = [release('1.0.0'), release('2.0.0'), release('1.10.0'), release('1.0.0', 'mysql-diagnostics')];
  const before = JSON.stringify(input), groups = packageGroups(input);
  expect(groups).toHaveLength(2); expect(groups[0].versions.map(p => p.package.version)).toEqual(['2.0.0', '1.10.0', '1.0.0']);
  expect(groups.flatMap(g => g.versions)).toHaveLength(4); expect(JSON.stringify(input)).toBe(before);
  expect(compatibilityLabel()).toBe('兼容性待确认');
});
it('uses server compatibility and recommendation, never the highest version as proof of support', () => {
  const old = release('1.0.0'), middle = release('1.1.0'), newest = release('2.0.0');
  const cases = [evidence(old, 'compatible', true), evidence(middle, 'compatible'), evidence(newest, 'incompatible', true)];
  expect(packageGroups([newest, middle, old], cases)[0].primary).toBe(old);
  expect(packageGroups([newest, middle, old], cases.slice(1))[0].primary).toBe(middle);
  expect(packageGroups([newest, old], [evidence(newest, 'unknown', true)])[0].primary).toBe(newest);
  expect(compatibilityLabel(evidence(newest, 'unknown', true))).toBe('资源能力待验证');
});
it('counts unique direct and derived output IDs, not collector or mapping rows', () => {
  expect(packageMetrics(release('1.0.0'))).toEqual(['db.uptime_seconds', 'mysql.queries.per_second']);
});
