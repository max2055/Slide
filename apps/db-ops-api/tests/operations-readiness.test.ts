/** Entirely synthetic protocol tests; none of these records qualifies as real evidence. */
import assert from 'node:assert/strict';
import { test } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { evidenceSha256, inspectEvidence, inspectFunctionalEvidence, type ReadinessDataset, type FreezeReview } from '../../../tests/qualification/operations-readiness.js';
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
test('more than thirty independent cases retain fixed-five precision and full-set recall for both searches', () => {
  const d = dataset();
  for (let i = 30; i < 35; i++) d.cases.push({ ...structuredClone(d.cases[0]), id: `case-${i}`,
    investigationId: `investigation-${i}`, incidentGroup: `incident-${i}` });
  const q = d.queries[0]; q.visibleCaseIds = d.cases.map(c => c.id);
  q.rankedCaseIds.pop(); q.humanCaseIds.pop();
  const r = inspect(d);
  assert.equal(r.B04.trustedRealInvestigations, 35); assert.equal(r.B04.distinctRealIncidents, 35);
  assert.equal(r.B04.status, 'ready_for_independent_review');
  assert.equal(r.B04.precisionAt5, .8); assert.equal(r.B04.recallAt5, .8);
  assert.equal(r.B04.humanPrecisionAt5, .8); assert.equal(r.B04.humanRecallAt5, .8);
  q.relevantCaseIds.push('case-30', 'case-31');
  const extended = inspect(d);
  assert.equal(extended.B04.recallAt5, 4 / 7); assert.equal(extended.B04.humanRecallAt5, 4 / 7);
  assert.equal(extended.B04.status, 'blocked');
});
test.each(['investigationId', 'incidentGroup'] as const)('P12-R1: duplicate %s cannot multiply top-five hits above thirty cases', field => {
  const d = dataset(), anchor = d.cases[0];
  const duplicates = Array.from({ length: 4 }, (_, i) => ({ ...structuredClone(anchor), id: `duplicate-${i}`,
    investigationId: field === 'investigationId' ? anchor.investigationId : `extra-investigation-${i}`,
    version: i + 2, contentHash: String(i + 1).repeat(64),
    review: { ...anchor.review, version: i + 2, contentHash: String(i + 1).repeat(64) } }));
  d.cases.push(...duplicates);
  const ids = [anchor.id, ...duplicates.map(c => c.id)];
  Object.assign(d.queries[0], { visibleCaseIds: ids, relevantCaseIds: ids, rankedCaseIds: ids, humanCaseIds: ids });
  const r = inspect(d);
  assert(r.B04.trustedRealInvestigations! >= 30); assert.equal(r.B04.distinctRealIncidents, 30);
  assert.equal(r.B04.status, 'blocked'); assert.equal(r.dataEvidenceStatus, 'blocked');
  assert(r.B04.gaps.includes('duplicate_investigation_or_incident_in_cohort'));
  assert.equal(r.B04.precisionAt5, null); assert.equal(r.B04.recallAt5, null);
  assert.equal(r.B04.humanPrecisionAt5, null); assert.equal(r.B04.humanRecallAt5, null);
});
test.each(['investigationId', 'incidentGroup'] as const)('P12-R1: conflicting %s mappings reject the whole freeze, including unreferenced duplicates', field => {
  for (const reverse of [false, true]) {
    const d = dataset();
    const duplicate = { ...structuredClone(d.cases[0]), id: 'conflicting-case',
      investigationId: 'extra-investigation', incidentGroup: 'extra-incident' };
    duplicate[field] = d.cases[0][field]; d.cases.push(duplicate);
    if (reverse) d.cases.reverse();
    // The duplicate is absent from every query list: cohort integrity is global.
    const r = inspect(d);
    assert.equal(r.B04.status, 'blocked'); assert.equal(r.B04.precisionAt5, null);
    assert.equal(r.B04.humanPrecisionAt5, null);
  }
});
test.each(['visibleCaseIds', 'relevantCaseIds', 'rankedCaseIds', 'humanCaseIds'] as const)(
  'P12-R1: duplicates referenced only in %s cannot bypass the shared cohort boundary', field => {
    const d = dataset(), duplicate = { ...structuredClone(d.cases[0]), id: 'duplicate-only-one-list' };
    d.cases.push(duplicate);
    if (field === 'visibleCaseIds') d.queries[0][field].push(duplicate.id);
    else d.queries[0][field][0] = duplicate.id;
    const r = inspect(d);
    assert.equal(r.B04.status, 'blocked'); assert.equal(r.dataEvidenceStatus, 'blocked');
    assert.equal(r.B04.precisionAt5, null); assert.equal(r.B04.humanPrecisionAt5, null);
  });
test('P12-R1: a transitive investigation/incident conflict is rejected across all queries', () => {
  const d = dataset();
  d.cases.push({ ...structuredClone(d.cases[0]), id: 'bridge', incidentGroup: d.cases[1].incidentGroup });
  d.queries.push({ ...structuredClone(d.queries[0]), id: 'query-2', incidentGroup: 'held-out-2' });
  const r = inspect(d);
  assert.equal(r.B04.status, 'blocked'); assert.equal(r.B04.precisionAt5, null);
  assert.equal(r.B04.recallAt5, null); assert.equal(r.B04.humanRecallAt5, null);
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
  const cli = (args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', script, ...args], { encoding: 'utf8', timeout: 10_000 });
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
}, 30_000);

// No real/human claims in current-policy fixtures, including the freeze review.
function functionalDataset() {
  const d = dataset(); d.cases = d.cases.slice(0, 5);
  d.cases.forEach(c => { c.provenance = 'synthetic'; c.review.kind = 'agent'; });
  d.queries.forEach(q => q.provenance = 'synthetic');
  d.baselines.forEach(b => b.provenance = 'synthetic');
  return d;
}
function functional(d = functionalDataset()) {
  const bytes = JSON.stringify(d), review: FreezeReview = { schemaVersion: 1,
    datasetSha256: evidenceSha256(bytes), kind: 'agent', reviewer: 'synthetic-fixture-reviewer',
    reviewedAt: reviewTime, evidenceRef: 'synthetic-fixture-review' };
  return inspectFunctionalEvidence(bytes, review, now);
}
test('current policy accepts five synthetic cases and synthetic windows without changing real qualification', async () => {
  const r = functional();
  assert.equal(r.policy, 'functional-delivery-1');
  assert.equal(r.functionalEvidence.status, 'ready_for_independent_review');
  assert.equal(r.functionalEvidence.B04.syntheticInvestigations, 5);
  assert.equal(r.B04.trustedRealInvestigations, 0);
  assert.equal(r.B04.precisionAt5, null); assert.equal(r.B04.recallAt5, null);
  assert.equal(r.B04.humanPrecisionAt5, null); assert.equal(r.B04.humanRecallAt5, null);
  assert(r.B06.series.every(s => s.comparison.baselineFalsePositiveRate === null
    && s.comparison.staticFalsePositiveRate === null && s.comparison.newImportantMisses === null));
  assert.equal(r.functionalEvidence.B04.precisionAt5, 1);
  assert.equal(r.functionalEvidence.B06.series[0].comparison.baselineFalsePositiveRate, 0);
  assert(r.B06.series.every(s => s.validDays === null));
  assert.equal(r.dataEvidenceStatus, 'blocked');
  assert.equal(r.productQualificationChanged, false); assert.equal(r.finalAcceptance, 'not_evaluated');
  assert(!r.externalGates.some(g => /MAX-192|merge/.test(g)));
  if (process.env.P12_REPORT_DIR) {
    await writeFile(join(process.env.P12_REPORT_DIR, 'synthetic-report.json'), JSON.stringify(r, null, 2));
  }
});
test('current policy measures fixed-five and full recall even below historical quality targets', () => {
  const d = functionalDataset(); d.queries[0].rankedCaseIds = ['case-0'];
  const r = functional(d); assert.equal(r.functionalEvidence.status, 'ready_for_independent_review');
  assert.equal(r.functionalEvidence.B04.precisionAt5, .2); assert.equal(r.functionalEvidence.B04.recallAt5, .2);
  assert.equal(r.functionalEvidence.B04.humanPrecisionAt5, 1);
});
test('current policy rejects duplicates in the whole cohort before either search is scored', () => {
  for (const key of ['investigationId', 'incidentGroup'] as const) {
    const d = functionalDataset(); d.cases.push({ ...structuredClone(d.cases[0]), id: 'unused-copy' });
    if (key === 'investigationId') d.cases.at(-1)!.incidentGroup = 'different';
    else d.cases.at(-1)!.investigationId = 'different';
    const r = functional(d).functionalEvidence;
    assert.equal(r.status, 'blocked'); assert.equal(r.B04.precisionAt5, null); assert.equal(r.B04.humanPrecisionAt5, null);
  }
});
test.each(['permission', 'version', 'hash', 'self_review', 'labels', 'incident', 'mixed_unit', 'expired'])(
  'current policy retains %s binding and fails invalid controlled evidence', kind => {
    const d = functionalDataset();
    if (kind === 'permission') d.queries[0].permissionRevision = 'stale';
    if (kind === 'version') d.cases[0].version++;
    if (kind === 'hash') d.cases[0].contentHash = 'b'.repeat(64);
    if (kind === 'self_review') d.cases[0].review.reviewer = d.cases[0].author;
    if (kind === 'labels') d.baselines[0].labels.pop();
    if (kind === 'incident') d.queries[0].incidentGroup = d.cases[0].incidentGroup;
    if (kind === 'mixed_unit') d.baselines[0].source.buckets[0].unit = 'By';
    if (kind === 'expired') d.cases[0].validUntil = freeze;
    assert.equal(functional(d).functionalEvidence.status, 'blocked');
  });
test('current policy cannot relabel unknown/real provenance or human review as synthetic', () => {
  for (const kind of ['real', 'unknown'] as const) {
    const d = functionalDataset(); d.cases[0].provenance = kind;
    assert.equal(functional(d).functionalEvidence.status, 'blocked');
  }
  const d = functionalDataset(); d.cases[0].review.kind = 'human';
  assert.equal(functional(d).functionalEvidence.status, 'blocked');
});
test('current policy byte binding, source reset unknown and missing inventory remain fail closed', () => {
  assert.equal(inspectFunctionalEvidence(undefined, undefined, now).functionalEvidence.status, 'blocked');
  const d = functionalDataset(); d.baselines[0].source.reason = 'counter_reset';
  const r = functional(d); assert.equal(r.functionalEvidence.status, 'blocked');
  assert.equal(r.functionalEvidence.B06.series[0].comparison.newImportantMisses, null);
  assert.throws(() => inspectFunctionalEvidence(JSON.stringify(d), { schemaVersion: 1, kind: 'agent',
    reviewer: 'synthetic', reviewedAt: reviewTime, evidenceRef: 'fixture', datasetSha256: '0'.repeat(64) }, now), /FREEZE_HASH_MISMATCH/);
});
test('CLI defaults to functional policy; historical qualification remains explicit', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'operations-functional-'));
  const script = resolve(import.meta.dirname, '../../../tests/qualification/operations-readiness.ts');
  const cli = (args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', script, ...args], { encoding: 'utf8', timeout: 10_000 });
  try {
    const d = functionalDataset();
    // Frozen algorithm windows stay synthetic; only evidence export expiry is future.
    d.baselines.forEach(b => b.source.validUntil = '2099-01-01T00:00:00.000Z');
    d.cases.forEach(c => c.validUntil = '2099-01-01T00:00:00.000Z');
    const bytes = JSON.stringify(d), input = join(directory, 'synthetic-input.json'), review = join(directory, 'agent-review.json');
    await writeFile(input, bytes);
    await writeFile(review, JSON.stringify({ schemaVersion: 1, datasetSha256: evidenceSha256(bytes), kind: 'agent',
      reviewer: 'synthetic-fixture-reviewer', reviewedAt: reviewTime, evidenceRef: 'synthetic-freeze-review' }));
    const passed = cli(['--input', input, '--review', review]);
    assert.equal(passed.status, 0, passed.stderr);
    assert.equal(JSON.parse(passed.stdout).dataEvidenceStatus, 'blocked');
    assert.equal(cli(['--mode', 'qualification', '--input', input, '--review', review]).status, 2);
    const missing = cli([]); assert.equal(missing.status, 2);
    assert.equal(JSON.parse(missing.stdout).policy, 'functional-delivery-1');
    const legacy = cli(['--mode', 'qualification']); assert.equal(legacy.status, 2);
    assert.equal(JSON.parse(legacy.stdout).functionalEvidence, undefined);
    assert.equal(cli(['--mode', 'invented']).status, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 30_000);
