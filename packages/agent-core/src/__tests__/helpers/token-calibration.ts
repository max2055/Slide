import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { FamilyTokenCounter, conservativePromptEstimate, tokenPayload } from '../../token-estimation.js';
import type { Message, ToolSchema } from '../../types.js';

export interface CalibrationSample {
  id: string; category: string; model: string; messages: Message[]; tools: ToolSchema[]; payload: string;
  groundTruth: { tokens: number; source: string; encoding: string; scope: string } | null;
}
export function evaluateTokenCalibration() {
  const corpus = JSON.parse(fs.readFileSync(new URL('../fixtures/token-calibration-v1.json', import.meta.url), 'utf8')) as
    { schemaVersion: number; sampleCount: number; sha256: string; samples: CalibrationSample[] };
  if (createHash('sha256').update(JSON.stringify(corpus.samples)).digest('hex') !== corpus.sha256) throw new Error('CALIBRATION_CORPUS_CHANGED');
  const counter = new FamilyTokenCounter();
  const samples = corpus.samples.flatMap(s => {
    if (tokenPayload(s.messages, s.tools) !== s.payload) throw new Error('CALIBRATION_SERIALIZATION_CHANGED');
    const family = counter.count(s.messages, s.tools, s.model);
    const fallback = conservativePromptEstimate(s.messages, s.tools, s.model);
    return [family, fallback].filter(value => value !== undefined).map(value => ({
      id: s.id, category: s.category, groundTruth: s.groundTruth, ...value!,
      relativeError: s.groundTruth ? (value!.tokens - s.groundTruth.tokens) / s.groundTruth.tokens : null,
      rawRelativeError: s.groundTruth ? (value!.rawTokens - s.groundTruth.tokens) / s.groundTruth.tokens : null,
    }));
  });
  const percentile = (values: number[], p: number) => values.length ? [...values].sort((a, b) => a - b)[Math.ceil(p * values.length) - 1] : null;
  const metrics = (rows: typeof samples) => {
    const measured = rows.filter(r => r.groundTruth);
    return { samples: rows.length, groundTruthSamples: measured.length,
      p50AbsoluteRelativeError: percentile(measured.map(r => Math.abs(r.relativeError!)), 0.5),
      p95AbsoluteRelativeError: percentile(measured.map(r => Math.abs(r.relativeError!)), 0.95),
      rawP50AbsoluteRelativeError: percentile(measured.map(r => Math.abs(r.rawRelativeError!)), 0.5),
      rawP95AbsoluteRelativeError: percentile(measured.map(r => Math.abs(r.rawRelativeError!)), 0.95),
      underestimationRate: measured.length ? measured.filter(r => r.relativeError! < 0).length / measured.length : null };
  };
  return { schemaVersion: 1, corpusSha256: corpus.sha256, sampleCount: corpus.sampleCount,
    groundTruthScope: 'Python tiktoken 0.12.0 serialized-payload encoding; NOT measured provider chat usage',
    methods: Object.fromEntries(['exact', 'family-tokenizer', 'conservative-heuristic'].map(method =>
      [method, metrics(samples.filter(s => s.method === method))])),
    categories: Object.fromEntries([...new Set(samples.map(s => s.category))].map(category =>
      [category, Object.fromEntries(['family-tokenizer', 'conservative-heuristic'].map(method =>
        [method, metrics(samples.filter(s => s.category === category && s.method === method))]))])),
    samples };
}
