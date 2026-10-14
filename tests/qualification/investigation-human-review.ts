/** Prepare an unsigned review packet. Never manufactures human decisions. */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dimensionKeys, hash, validateCorpus, validateRubric, type Corpus, type Rubric } from './investigation-eval.js';

export function humanReviewPacket(report: any, corpus: Corpus, rubric: Rubric) {
  validateCorpus(corpus); validateRubric(rubric);
  assert(report.corpusHash === hash(JSON.stringify(corpus)) && report.rubricHash === hash(JSON.stringify(rubric)), 'REVIEW_CORPUS_MISMATCH');
  assert(report.results?.length === corpus.samples.length, 'REVIEW_INCOMPLETE');
  const seen = new Set<string>();
  const results = corpus.samples.map(sample => {
    const output = report.results.find((r: any) => r.sampleId === sample.id);
    assert(output && !seen.has(output.sampleId) && output.sampleVersion === sample.version
      && output.sampleHash === hash(JSON.stringify(sample)), 'REVIEW_SAMPLE_MISMATCH');
    seen.add(output.sampleId);
    return { sampleId: sample.id, sampleVersion: sample.version, outputHash: hash(JSON.stringify(output.output)),
      sample, output: output.output, receipt: output.receipt, bindingChecks: output.checks,
      scores: Object.fromEntries(dimensionKeys.map(key => [key, { score: null, reason: '' }])),
      helpful: null, factSupport: (output.output?.facts ?? []).map((fact: any, index: number) => ({ index, fact, supported: null, reason: '' })) };
  });
  return { schemaVersion: 1, reportHash: hash(JSON.stringify(report)), rubricHash: report.rubricHash,
    reviewerKind: 'human', reviewer: '', reviewedAt: null, rubric, results,
    status: 'unsigned_unscored', blindComparison: { status: 'unavailable', reason: 'No baseline diagnosis report for the identical frozen input/version was supplied.' },
    instructions: '由真人填写 reviewer、reviewedAt、七维0/1/2及具体理由；null保持未评估。保留全部40例（含DB-06/NW-05失败），不得删难例。使用 investigation-real-eval.ts --review 导入；运行时硬安全仍需独立证据。' };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [input, output] = process.argv.slice(2);
  assert(input && output && !existsSync(output) && resolve(input) !== resolve(output), 'Usage: collected-report.json new-review-packet.json');
  const base = new URL('./fixtures/investigations/', import.meta.url);
  const packet = humanReviewPacket(JSON.parse(readFileSync(input, 'utf8')), JSON.parse(readFileSync(new URL('cases.json', base), 'utf8')), JSON.parse(readFileSync(new URL('judge-rubric.json', base), 'utf8')));
  writeFileSync(output, JSON.stringify(packet, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ samples: packet.results.length, status: packet.status, blindComparison: packet.blindComparison.status }));
}
