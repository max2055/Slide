/** Entirely synthetic protocol tests; none of these records qualifies as real evidence. */
import assert from 'node:assert/strict';
import { test } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { evidenceSha256, inspectEvidence, type ReadinessDataset, type FreezeReview } from '../../../tests/qualification/operations-readiness.js';
import { syntheticInput, syntheticWindow } from '../src/operations/baselines/test-support.js';

const freeze = '2026-10-17T12:00:02.000Z', reviewTime = '2026-10-17T12:00:03.000Z';
const now = Date.parse('2026-10-17T12:00:04.000Z');
function dataset(): ReadinessDataset {
  return { schemaVersion: 1, frozenAt: freeze, permission: { role: 'test-role', revision: 'test-epoch', evidenceRef: 'test-acl-audit' },
    cases: Array.from({ length: 30 }, (_, i) => ({ id: `case-${i}`, investigationId: `investigation-${i}`, incidentGroup: `incident-${i}`,
      version: 1, contentHash: 'a'.repeat(64), provenance: 'real', state: 'published', validUntil: '2026-11-01T00:00:00.000Z',
      author: 'test-author', review: { kind: 'human', reviewer: 'test-reviewer', reviewedAt: '2026-10-17T11:00:00.000Z',
        evidenceRef: 'test-case-review', version: 1, contentHash: 'a'.repeat(64) }, sourceEvidenceRef: 'test-source' })),
    queries: [{ id: 'query-1', incidentGroup: 'held-out-query-incident', provenance: 'real', query: 'synthetic query',
      productVersion: 'test-product', resourceVersion: 'test-resource', role: 'test-role', permissionRevision: 'test-epoch',
      visibleCaseIds: ['case-0', 'case-1', 'case-2', 'case-3', 'case-4'], relevantCaseIds: ['case-0', 'case-1', 'case-2', 'case-3', 'case-4'],
      rankedCaseIds: ['case-0', 'case-1', 'case-2', 'case-3', 'case-4'], humanCaseIds: ['case-0', 'case-1', 'case-2', 'case-3', 'case-4'], evidenceRef: 'test-human-search' }],
    baselines: (['daily', 'weekly'] as const).map(mode => {
      const source = syntheticWindow(mode);
      source.buckets.at(-1)!.value = { encoding: 'float64', value: 99 };
      return { id: `test-${mode}`, provenance: 'real', sourceEvidenceRef: 'test-formal-source-audit', staticRuleVersion: 'test-static/1',
        input: { ...syntheticInput, mode }, source, labels: source.buckets.slice(-168).map((p, i) => ({ at: p.window.from,
          label: i === 167 ? 'important' as const : 'normal' as const, evidenceRef: 'test-label-audit' })) };
    }) };
}
function inspect(d = dataset(), changeReview?: (r: FreezeReview) => void) {
  const bytes = JSON.stringify(d), r: FreezeReview = { schemaVersion: 1, datasetSha256: evidenceSha256(bytes), kind: 'human',
    reviewer: 'test-dataset-reviewer', reviewedAt: reviewTime, evidenceRef: 'test-freeze-audit' };
  changeReview?.(r);
  return inspectEvidence(bytes, r, now);
}
test('missing inventory remains unknown, distinct from an exported empty cohort', () => {
  const absent = inspectEvidence(undefined, undefined, now);
  assert.equal(absent.dataEvidenceStatus, 'blocked'); assert.equal(absent.B04.trustedRealInvestigations, null);
  assert.equal(absent.B04.precisionAt5, null); assert.equal(absent.finalAcceptance, 'not_evaluated');
  const d = dataset(); d.cases = []; d.queries = []; d.baselines = [];
  assert.equal(inspect(d).B04.trustedRealInvestigations, 0);
});
test('complete claimed evidence is only ready for independent review, never product or final acceptance', () => {
  const r = inspect(); assert.equal(r.dataEvidenceStatus, 'ready_for_independent_review');
  assert.equal(r.productQualificationChanged, false); assert.equal(r.finalAcceptance, 'not_evaluated');
  assert.deepEqual(r.B06.series.map(s => s.validDays), [14, 28]);
  assert.equal(r.B04.precisionAt5, 1); assert.equal(r.B04.recallAt5, 1);
  assert(r.externalGates.includes('authorized_provenance_and_live_permission_review'));
});
test('hash binds exact query, label, permission, version and whitespace bytes', () => {
  const d = dataset(), bytes = JSON.stringify(d), r: FreezeReview = { schemaVersion: 1, datasetSha256: evidenceSha256(bytes),
    kind: 'human', reviewer: 'test-reviewer', reviewedAt: reviewTime, evidenceRef: 'test-audit' };
  for (const mutate of [(v: ReadinessDataset) => v.queries[0].query = 'changed',
    (v: ReadinessDataset) => v.permission.revision = 'changed', (v: ReadinessDataset) => v.cases[0].version++,
    (v: ReadinessDataset) => v.baselines[0].labels[0].label = 'important']) {
    const changed = structuredClone(d); mutate(changed);
    assert.throws(() => inspectEvidence(JSON.stringify(changed), r, now), /FREEZE_HASH_MISMATCH/);
  }
  assert.throws(() => inspectEvidence(bytes + '\n', r, now), /FREEZE_HASH_MISMATCH/);
});
test('agent, future or pre-freeze review cannot meet the human freeze gate', () => {
  for (const change of [(r: FreezeReview) => r.kind = 'agent',
    (r: FreezeReview) => r.reviewedAt = '2026-10-18T00:00:00.000Z',
    (r: FreezeReview) => r.reviewedAt = '2026-10-16T00:00:00.000Z']) assert.equal(inspect(dataset(), change).dataEvidenceStatus, 'blocked');
  assert.equal(inspectEvidence(JSON.stringify(dataset()), undefined, now).dataEvidenceStatus, 'blocked');
});
test('synthetic and unknown provenance never count toward real cases or windows', () => {
  const d = dataset(); d.cases.forEach(c => c.provenance = 'synthetic'); d.baselines.forEach(b => b.provenance = 'unknown');
  const r = inspect(d); assert.equal(r.B04.trustedRealInvestigations, 0);
  assert(r.B06.series.every(s => s.validDays === null && s.status === 'blocked'));
});
test('versions and near duplicate investigations/incidents cannot pad the thirty-case threshold', () => {
  for (const field of ['investigationId', 'incidentGroup'] as const) {
    const d = dataset(); d.cases[29][field] = d.cases[0][field];
    assert.equal(inspect(d).B04.status, 'blocked');
  }
});
test('self review, stale review version/hash, withdrawal and expiry exclude the case', () => {
  for (const mutate of [(d: ReadinessDataset) => d.cases[0].review.reviewer = d.cases[0].author,
    (d: ReadinessDataset) => d.cases[0].version++, (d: ReadinessDataset) => d.cases[0].contentHash = 'b'.repeat(64),
    (d: ReadinessDataset) => d.cases[0].state = 'withdrawn',
    (d: ReadinessDataset) => d.cases[0].validUntil = '2026-10-16T00:00:00.000Z']) {
    const d = dataset(); mutate(d); assert.equal(inspect(d).B04.trustedRealInvestigations, 29);
  }
});
test('precision divides by five even for short results; recall divides by all relevant labels', () => {
  const d = dataset(); d.queries[0].rankedCaseIds = ['case-0'];
  assert.equal(inspect(d).B04.precisionAt5, .2);
  d.queries[0].rankedCaseIds = ['case-0', 'case-1', 'case-2', 'case-3', 'case-4'];
  d.queries[0].visibleCaseIds.push('case-5', 'case-6'); d.queries[0].relevantCaseIds.push('case-5', 'case-6');
  const r = inspect(d); assert.equal(r.B04.recallAt5, 5 / 7); assert.equal(r.B04.status, 'blocked');
});
test('0.80 is inclusive and quality is macro averaged per frozen query', () => {
  const d = dataset(); d.queries[0].rankedCaseIds.pop();
  assert.equal(inspect(d).B04.status, 'ready_for_independent_review');
  d.queries.push({ ...structuredClone(d.queries[0]), id: 'query-2', incidentGroup: 'held-out-query-2', rankedCaseIds: [] });
  assert.equal(inspect(d).B04.precisionAt5, .4); assert.equal(inspect(d).B04.status, 'blocked');
});
test('hidden labels/results, stale ACL and same-incident query leakage are blocking', () => {
  for (const mutate of [(d: ReadinessDataset) => d.queries[0].rankedCaseIds.push('hidden'),
    (d: ReadinessDataset) => d.queries[0].relevantCaseIds.push('hidden'),
    (d: ReadinessDataset) => d.queries[0].permissionRevision = 'old',
    (d: ReadinessDataset) => d.queries[0].incidentGroup = 'incident-0']) {
    const d = dataset(); mutate(d);
    // Keep a maximum of five result slots for the permission counterexample.
    d.queries[0].rankedCaseIds = d.queries[0].rankedCaseIds.slice(-5);
    assert.equal(inspect(d).B04.status, 'blocked');
  }
});
test('duplicate ranked IDs and malformed/nonfinite buckets fail parsing rather than pad scores', () => {
  const d = dataset(); d.queries[0].rankedCaseIds[1] = 'case-0'; assert.throws(() => inspect(d));
  const b = dataset(); (b.baselines[0].source.buckets[0].value as any).value = 'Infinity'; assert.throws(() => inspect(b));
});
test('short history, low coverage, missing repeated period and six hour gaps remain blocked', () => {
  for (const mutate of [(d: ReadinessDataset) => d.baselines[0].source.buckets = [],
    (d: ReadinessDataset) => d.baselines[0].source.from = '2026-10-16T12:00:00.000Z',
    (d: ReadinessDataset) => d.baselines[0].source.buckets[0].coverage = .89,
    (d: ReadinessDataset) => d.baselines[0].source.buckets.splice(0, 6)]) {
    const d = dataset(); mutate(d); assert.equal(inspect(d).B06.status, 'blocked'); assert.equal(inspect(d).B07.status, 'blocked');
  }
});
test('single daily series cannot stand in for the weekly window', () => {
  const d = dataset(); d.baselines.pop(); assert.equal(inspect(d).B06.status, 'blocked'); assert.equal(inspect(d).B07.status, 'blocked');
});
test('expired/future source snapshots and mixed resource/unit/dimensions cannot qualify', () => {
  for (const mutate of [(d: ReadinessDataset) => d.baselines[0].source.validUntil = freeze,
    (d: ReadinessDataset) => d.baselines[0].source.evaluatedAt = reviewTime,
    (d: ReadinessDataset) => d.baselines[0].source.identity!.resource = { type: 'server', id: 9 },
    (d: ReadinessDataset) => d.baselines[0].source.buckets[0].unit = 'By',
    (d: ReadinessDataset) => d.baselines[0].source.buckets[0].dimensions = { device: 'other' }]) {
    const d = dataset(); mutate(d); assert.equal(inspect(d).B06.status, 'blocked');
  }
});
test('missing, shifted, duplicate or training-window labels cannot establish temporal quality', () => {
  const d = dataset(); d.baselines[0].labels.pop(); assert.equal(inspect(d).B07.status, 'blocked');
  const shifted = dataset(); shifted.baselines[0].labels[0].at = shifted.baselines[0].source.from;
  assert.equal(inspect(shifted).B07.status, 'blocked');
  const duplicate = dataset(); duplicate.baselines[0].labels[0].at = duplicate.baselines[0].labels[1].at;
  assert.throws(() => inspect(duplicate));
});
test('false positives use identical normal labels and important misses are compared event by event', () => {
  const d = dataset(); const b = d.baselines[0];
  b.source.buckets.at(-2)!.value = { encoding: 'float64', value: 41 };
  assert.equal(inspect(d).B06.status, 'ready_for_independent_review');
  assert(inspect(d).B07.gaps.includes('false_positive_rate_worse_than_static'));
  const missed = dataset(); missed.baselines[0].input.staticThreshold = { operator: '>', value: 30 };
  missed.baselines[0].labels[0].label = 'important';
  assert.equal(inspect(missed).B06.series[0].comparison.newImportantMisses, 1);
  assert(inspect(missed).B07.gaps.includes('new_important_anomaly_misses'));
});
test('unknown baselines retain null comparison metrics and no improvement claim', () => {
  const d = dataset(); d.baselines[0].source.reason = 'counter_reset';
  const r = inspect(d); assert.equal(r.B06.series[0].comparison.newImportantMisses, null);
  assert.equal(r.B06.series[0].comparison.baselineFalsePositiveRate, null); assert.equal(r.B07.status, 'blocked');
});
test('CLI exits 2 for gaps; error output is redacted; reports never overwrite inputs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'operations-readiness-'));
  const script = resolve(import.meta.dirname, '../../../tests/qualification/operations-readiness.ts');
  const cli = (args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', script, ...args], { encoding: 'utf8' });
  try {
    const missing = cli([]); assert.equal(missing.status, 2); assert.equal(JSON.parse(missing.stdout).B04.trustedRealInvestigations, null);
    const input = join(directory, 'input.json'), canary = 'hidden-case-secret-canary';
    await writeFile(input, JSON.stringify({ secret: canary }));
    const invalid = cli(['--input', input]); assert.equal(invalid.status, 1);
    assert(!invalid.stderr.includes(canary)); assert(!invalid.stdout.includes(canary));
    const original = await readFile(input, 'utf8');
    assert.equal(cli(['--input', input, '--output', input]).status, 1);
    assert.equal(await readFile(input, 'utf8'), original);
    const out = join(directory, 'output.json'); assert.equal(cli(['--output', out]).status, 2);
    assert.equal(cli(['--output', out]).status, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
