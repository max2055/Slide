/** P12: offline evidence checks, never a product qualification or human sign-off. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { calculateBaseline, BASELINE_METHOD } from '../../apps/db-ops-api/src/operations/baselines/calculator.js';
import { baselineInputSchema, DAY, scalarNumber, type BaselineInput,
  type BaselineSourceWindow } from '../../apps/db-ops-api/src/operations/baselines/source-adapter.js';

type Provenance = 'real' | 'synthetic' | 'unknown';
type HumanReview = { kind: 'human' | 'agent'; reviewer: string; reviewedAt: string; evidenceRef: string };
export interface ReadinessDataset {
  schemaVersion: 1;
  frozenAt: string;
  permission: { role: string; revision: string; evidenceRef: string };
  cases: Array<{ id: string; investigationId: string; incidentGroup: string; version: number; contentHash: string;
    provenance: Provenance; state: 'published' | 'expired' | 'withdrawn' | 'draft'; validUntil: string;
    author: string; review: HumanReview & { version: number; contentHash: string }; sourceEvidenceRef: string }>;
  queries: Array<{ id: string; incidentGroup: string; provenance: Provenance; query: string;
    productVersion: string; resourceVersion: string; role: string; permissionRevision: string;
    visibleCaseIds: string[]; relevantCaseIds: string[]; rankedCaseIds: string[]; humanCaseIds: string[];
    evidenceRef: string }>;
  baselines: Array<{ id: string; provenance: Provenance; sourceEvidenceRef: string; staticRuleVersion: string;
    input: BaselineInput; source: BaselineSourceWindow;
    labels: Array<{ at: string; label: 'normal' | 'anomaly' | 'important'; evidenceRef: string }> }>;
}
export interface FreezeReview extends HumanReview { schemaVersion: 1; datasetSha256: string }
const HASH = /^[a-f0-9]{64}$/;
const text = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= 4096;
const instant = (v: unknown): v is string => typeof v === 'string'
  && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v) && Number.isFinite(Date.parse(v))
  && new Date(v).toISOString() === v;
const record = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const unique = (v: string[]) => new Set(v).size === v.length;
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.length <= 10000 && v.every(text) && unique(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const fraction = (v: unknown) => finite(v) && v >= 0 && v <= 1;
const provenance = (v: unknown) => ['real', 'synthetic', 'unknown'].includes(String(v));
const humanReview = (v: unknown): v is HumanReview => record(v) && ['human', 'agent'].includes(v.kind)
  && text(v.reviewer) && instant(v.reviewedAt) && text(v.evidenceRef);
export const evidenceSha256 = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** Validate all calculator inputs before crossing the external JSON boundary.
 * Evidence refs are opaque audit locators: this command never fetches them. */
export function parseDataset(value: unknown): ReadinessDataset {
  assert(record(value) && value.schemaVersion === 1 && instant(value.frozenAt));
  assert(record(value.permission) && ['role', 'revision', 'evidenceRef'].every(k => text(value.permission[k])));
  for (const key of ['cases', 'queries', 'baselines']) assert(Array.isArray(value[key]) && value[key].length <= 10000);
  for (const c of value.cases) {
    assert(record(c) && ['id', 'investigationId', 'incidentGroup', 'author', 'sourceEvidenceRef'].every(k => text(c[k])));
    assert(Number.isSafeInteger(c.version) && c.version > 0 && typeof c.contentHash === 'string' && HASH.test(c.contentHash));
    assert(provenance(c.provenance) && ['published', 'expired', 'withdrawn', 'draft'].includes(c.state));
    assert(instant(c.validUntil) && record(c.review) && Number.isSafeInteger(c.review.version)
      && typeof c.review.contentHash === 'string' && HASH.test(c.review.contentHash) && humanReview(c.review));
  }
  assert(unique(value.cases.map((c: any) => c.id)));
  for (const q of value.queries) {
    assert(record(q) && ['id', 'incidentGroup', 'query', 'productVersion', 'resourceVersion', 'role',
      'permissionRevision', 'evidenceRef'].every(k => text(q[k])) && provenance(q.provenance));
    for (const key of ['visibleCaseIds', 'relevantCaseIds', 'rankedCaseIds', 'humanCaseIds']) assert(strings(q[key]));
    assert(q.rankedCaseIds.length <= 5 && q.humanCaseIds.length <= 5);
  }
  assert(unique(value.queries.map((q: any) => q.id)));
  for (const b of value.baselines) {
    assert(record(b) && text(b.id) && provenance(b.provenance) && text(b.sourceEvidenceRef) && text(b.staticRuleVersion));
    baselineInputSchema.parse(b.input);
    const s = b.source;
    assert(record(s) && ['from', 'until', 'evaluatedAt', 'validUntil'].every(k => instant(s[k])));
    assert(s.reason === null || text(s.reason));
    assert(text(s.fence) && finite(s.intervalMs) && s.intervalMs > 0 && finite(s.maxGapMs) && s.maxGapMs > 0);
    assert(record(s.latest) && (s.latest.value === null || finite(s.latest.value))
      && (s.latest.observedAt === null || instant(s.latest.observedAt)));
    if (s.identity !== null) {
      const i = s.identity;
      assert(record(i) && record(i.resource) && ['instance', 'server', 'network_device'].includes(i.resource.type)
        && Number.isSafeInteger(i.resource.id) && i.resource.id > 0);
      assert(['metric', 'unit', 'configurationVersion', 'transformVersion'].every(k => text(i[k])));
      assert(record(i.dimensions) && Object.entries(i.dimensions).every(([k, v]) => text(k) && typeof v === 'string'));
      assert(record(i.source) && ['id', 'bindingId', 'version'].every(k => text(i.source[k])));
      assert(i.counterEpoch === null || text(i.counterEpoch));
    }
    assert(Array.isArray(s.buckets) && s.buckets.length <= 672);
    for (const p of s.buckets) {
      assert(record(p) && record(p.window) && instant(p.window.from) && instant(p.window.to));
      assert(record(p.metric) && text(p.metric.id) && text(p.metric.semantic_version) && text(p.unit)
        && record(p.dimensions) && Object.entries(p.dimensions).every(([k, v]) => text(k) && typeof v === 'string'));
      assert(record(p.quality) && ['good', 'partial', 'unknown', 'invalid', 'unsupported', 'stale'].includes(p.quality.status));
      assert(['exact', 'estimated', 'unknown'].includes(p.accuracy) && fraction(p.coverage)
        && Number.isSafeInteger(p.sample_count) && p.sample_count >= 0);
      assert(p.value === null || record(p.value) && ['float64', 'int64', 'uint64'].includes(p.value.encoding)
        && (p.value.encoding === 'float64' ? finite(p.value.value)
          : typeof p.value.value === 'string' && /^-?\d{1,20}$/.test(p.value.value)));
    }
    assert(Array.isArray(b.labels) && b.labels.length <= 168);
    for (const l of b.labels) assert(record(l) && instant(l.at) && ['normal', 'anomaly', 'important'].includes(l.label) && text(l.evidenceRef));
    assert(unique(b.labels.map((l: any) => l.at)));
  }
  assert(unique(value.baselines.map((b: any) => b.id)));
  return value as ReadinessDataset;
}

type Gate = { status: 'blocked' | 'ready_for_independent_review'; gaps: string[] };
const gate = (gaps: string[]): Gate => ({ status: gaps.length ? 'blocked' : 'ready_for_independent_review', gaps: [...new Set(gaps)] });
const mean = (v: number[]) => v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
const quality = (ranked: string[], relevant: string[]) => {
  const hits = ranked.filter(id => relevant.includes(id)).length;
  // Empty result slots remain misses; recall uses ALL labelled relevant cases.
  return { precision: hits / 5, recall: relevant.length ? hits / relevant.length : null };
};

function evaluateReadiness(dataset?: ReadinessDataset, review?: FreezeReview, now = Date.now()) {
  const freezeGaps: string[] = [];
  if (!dataset) freezeGaps.push('authorized_frozen_dataset_missing');
  if (!review) freezeGaps.push('human_freeze_review_missing');
  if (dataset && Date.parse(dataset.frozenAt) > now) freezeGaps.push('future_freeze');
  if (review && (!humanReview(review) || review.schemaVersion !== 1 || !HASH.test(review.datasetSha256)
    || review.kind !== 'human' || Date.parse(review.reviewedAt) > now
    || dataset && Date.parse(review.reviewedAt) < Date.parse(dataset.frozenAt))) freezeGaps.push('human_freeze_review_invalid');
  // Byte binding is verified by inspectEvidence(), before evaluation.
  const cases = dataset?.cases ?? [], queries = dataset?.queries ?? [];
  const validCases = cases.filter(c => c.provenance === 'real' && c.state === 'published'
    && c.review.kind === 'human' && c.review.reviewer !== c.author
    && c.review.version === c.version && c.review.contentHash === c.contentHash
    && Date.parse(c.review.reviewedAt) <= Date.parse(dataset!.frozenAt)
    && Date.parse(c.validUntil) > now);
  const investigationCount = new Set(validCases.map(c => c.investigationId)).size;
  const incidentCount = new Set(validCases.map(c => c.incidentGroup)).size;
  // A freeze must choose one reviewed representative per investigation AND
  // incident before labelling/searching. Reject duplicates globally rather than
  // choosing a version implicitly or scoring different representatives in the
  // visible, relevant, algorithm and human sets. Conflicting mappings also fail.
  const independentCohort = unique(cases.map(c => c.investigationId))
    && unique(cases.map(c => c.incidentGroup));
  const b04 = [...freezeGaps];
  if (!independentCohort) b04.push('duplicate_investigation_or_incident_in_cohort');
  if (investigationCount < 30 || incidentCount < 30) b04.push('fewer_than_30_distinct_real_reviewed_investigations_and_incidents');
  if (validCases.length !== cases.length) b04.push('unqualified_case_in_cohort');
  if (!queries.length) b04.push('real_labelled_queries_and_human_search_missing');
  const scores: ReturnType<typeof quality>[] = [], humanScores: ReturnType<typeof quality>[] = [];
  const caseIds = new Set(validCases.map(c => c.id)), groups = new Set(cases.map(c => c.incidentGroup));
  for (const q of queries) {
    if (q.provenance !== 'real') b04.push('non_real_query');
    if (q.role !== dataset!.permission.role || q.permissionRevision !== dataset!.permission.revision
      || q.visibleCaseIds.some(id => !caseIds.has(id))
      || [...q.relevantCaseIds, ...q.rankedCaseIds, ...q.humanCaseIds].some(id => !q.visibleCaseIds.includes(id))) b04.push('query_permission_or_case_binding_invalid');
    if (groups.has(q.incidentGroup)) b04.push('query_incident_leaks_reference_cohort');
    if (!q.relevantCaseIds.length) b04.push('query_relevance_labels_empty');
    // No quality claim (including the human comparison) for a rejected cohort.
    // Accepted cohorts have identical case/investigation/incident cardinality,
    // so the fixed-five numerator and full relevant denominator are independent.
    if (independentCohort) {
      scores.push(quality(q.rankedCaseIds, q.relevantCaseIds));
      humanScores.push(quality(q.humanCaseIds, q.relevantCaseIds));
    }
  }
  if (!unique(queries.map(q => q.incidentGroup))) b04.push('duplicate_query_incident');
  const precision = mean(scores.map(s => s.precision)), recall = mean(scores.flatMap(s => s.recall === null ? [] : [s.recall]));
  if (precision === null || recall === null || precision < .8 || recall < .8) b04.push('retrieval_precision_or_recall_below_0_80');

  const baselineGaps = [...freezeGaps], comparisonGaps = [...freezeGaps];
  const series = (dataset?.baselines ?? []).map(b => {
    const gaps: string[] = [];
    if (b.provenance !== 'real') gaps.push('non_real_observations');
    const s = b.source;
    if (Date.parse(s.evaluatedAt) > Date.parse(dataset!.frozenAt) || Date.parse(s.validUntil) <= now
      || Date.parse(s.evaluatedAt) > now || s.latest.observedAt && Date.parse(s.latest.observedAt) > Date.parse(s.evaluatedAt)) gaps.push('source_snapshot_future_or_expired');
    if (s.identity && (s.identity.resource.type !== b.input.resource.type || s.identity.resource.id !== b.input.resource.id
      || !s.identity.metric.startsWith(`${b.input.metric}@`)
      || JSON.stringify(Object.entries(s.identity.dimensions).sort()) !== JSON.stringify(Object.entries(b.input.dimensions).sort()))) gaps.push('series_identity_mismatch');
    if (s.identity && s.buckets.some(p => `${p.metric.id}@${p.metric.semantic_version}` !== s.identity!.metric
      || p.unit !== s.identity!.unit
      || JSON.stringify(Object.entries(p.dimensions ?? {}).sort()) !== JSON.stringify(Object.entries(s.identity!.dimensions).sort()))) gaps.push('bucket_series_identity_mismatch');
    const result = calculateBaseline(b.input, s);
    if (result.status !== 'known' || result.state !== 'qualified') gaps.push('baseline_not_qualified');
    if (result.methodVersion !== BASELINE_METHOD || Date.parse(result.validation.until) - Date.parse(result.validation.from) !== 7 * DAY) gaps.push('method_or_holdout_invalid');
    baselineGaps.push(...gaps);
    const cg = [...gaps];
    if (!b.input.staticThreshold) cg.push('static_threshold_missing');
    const validation = s.buckets.filter(p => Date.parse(p.window.from) >= Date.parse(result.validation.from)
      && Date.parse(p.window.to) <= Date.parse(result.validation.until) && scalarNumber(p.value) !== null
      && p.accuracy === 'exact' && p.coverage >= .9 && (p.quality.status === 'good' || p.quality.status === 'partial' && p.quality.reason === 'gap'));
    if (!b.labels.length || b.labels.length !== validation.length
      || b.labels.some(l => !validation.some(p => p.window.from === l.at))) cg.push('holdout_labels_missing_or_not_exactly_aligned');
    let normal = 0, baselineFP = 0, staticFP = 0, important = 0, newImportantMisses = 0;
    for (const l of b.labels) {
      const bucket = validation.find(p => p.window.from === l.at), at = Date.parse(l.at);
      const slot = b.input.mode === 'daily' ? new Date(at).getUTCHours() : new Date(at).getUTCDay() * 24 + new Date(at).getUTCHours();
      const band = result.referenceBands.find(v => v.slot === slot), value = bucket ? scalarNumber(bucket.value) : null;
      if (!band || value === null || !b.input.staticThreshold) continue;
      const baselineFlag = value < band.lower || value > band.upper;
      const staticFlag = b.input.staticThreshold.operator === '>' ? value > b.input.staticThreshold.value : value < b.input.staticThreshold.value;
      if (l.label === 'normal') { normal++; if (baselineFlag) baselineFP++; if (staticFlag) staticFP++; }
      if (l.label === 'important') { important++; if (staticFlag && !baselineFlag) newImportantMisses++; }
    }
    if (!normal) cg.push('normal_labels_missing');
    if (!b.labels.some(l => l.label !== 'normal')) cg.push('anomaly_labels_missing');
    if (baselineFP > staticFP) cg.push('false_positive_rate_worse_than_static');
    if (newImportantMisses) cg.push('new_important_anomaly_misses');
    comparisonGaps.push(...cg);
    return { mode: b.input.mode, ...gate(gaps), methodVersion: result.methodVersion, staticRuleSha256: evidenceSha256(b.staticRuleVersion),
      validDays: b.provenance === 'real' ? result.quality.validDays : null, coverage: result.quality.coverage,
      reason: result.reason === null ? null : 'source_or_quality_gate_failed',
      comparison: { ...gate(cg), labelledSamples: b.labels.length, normalSamples: normal, importantSamples: important,
        baselineFalsePositiveRate: normal ? baselineFP / normal : null, staticFalsePositiveRate: normal ? staticFP / normal : null,
        newImportantMisses: b.labels.length && result.status === 'known' ? newImportantMisses : null } };
  });
  for (const mode of ['daily', 'weekly']) if (!series.some(s => s.mode === mode)) baselineGaps.push(`${mode}_real_observation_window_missing`);
  if (!series.length) comparisonGaps.push('real_labelled_temporal_comparison_missing');
  // B07 cannot pass while either required B06 window is missing.
  comparisonGaps.push(...baselineGaps);
  const b06 = gate(baselineGaps), b07 = gate(comparisonGaps), retrieval = gate(b04);
  return { schemaVersion: 1, evaluatedAt: new Date(now).toISOString(),
    dataEvidenceStatus: [retrieval, b06, b07].every(g => g.status === 'ready_for_independent_review') ? 'ready_for_independent_review' : 'blocked',
    productQualificationChanged: false, finalAcceptance: 'not_evaluated',
    B04: { ...retrieval, trustedRealInvestigations: dataset ? investigationCount : null,
      distinctRealIncidents: dataset ? incidentCount : null, queries: dataset ? queries.length : null,
      precisionAt5: precision, recallAt5: recall,
      humanPrecisionAt5: mean(humanScores.map(s => s.precision)), humanRecallAt5: mean(humanScores.flatMap(s => s.recall === null ? [] : [s.recall])) },
    B06: { ...b06, series }, B07: b07,
    externalGates: ['authorized_provenance_and_live_permission_review', 'MAX-192_reviewed_source_and_migration_evidence',
      'P11_integrated_action_and_safety_acceptance', 'parent_independent_review_and_verified_merge', 'Max_batch_final_acceptance'] };
}

/** The review binds the exact input bytes, including queries, labels, ACL,
 * algorithms, series identity and holdout. No canonicalization loophole. */
export function inspectEvidence(bytes?: string, review?: FreezeReview, now = Date.now()) {
  if (bytes === undefined) return evaluateReadiness(undefined, review, now);
  assert(Buffer.byteLength(bytes) <= 25_000_000);
  const dataset = parseDataset(JSON.parse(bytes));
  if (review) assert(review.datasetSha256 === evidenceSha256(bytes), 'FREEZE_HASH_MISMATCH');
  return { ...evaluateReadiness(dataset, review, now), datasetSha256: evidenceSha256(bytes) };
}

async function main() {
  try {
    const args = process.argv.slice(2), options = new Map<string, string>();
    for (let i = 0; i < args.length; i += 2) {
      assert(['--input', '--review', '--output'].includes(args[i]) && args[i + 1] && !options.has(args[i]));
      options.set(args[i], args[i + 1]);
    }
    assert(!options.has('--review') || options.has('--input'));
    const input = options.has('--input') ? resolve(options.get('--input')!) : undefined;
    const reviewFile = options.has('--review') ? resolve(options.get('--review')!) : undefined;
    const output = options.has('--output') ? resolve(options.get('--output')!) : undefined;
    // Never overwrite a frozen source or its review with a report.
    assert(!output || output !== input && output !== reviewFile);
    const report = inspectEvidence(input ? await readFile(input, 'utf8') : undefined,
      reviewFile ? JSON.parse(await readFile(reviewFile, 'utf8')) : undefined);
    const rendered = JSON.stringify(report, null, 2) + '\n';
    if (output) await writeFile(output, rendered, { flag: 'wx' });
    process.stdout.write(rendered);
    process.exitCode = report.dataEvidenceStatus === 'blocked' ? 2 : 0;
  } catch {
    // Invalid inputs may contain hidden case text, credentials or arbitrary paths.
    process.stderr.write('OPERATIONS_READINESS_INPUT_OR_OUTPUT_INVALID\n');
    process.exitCode = 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
