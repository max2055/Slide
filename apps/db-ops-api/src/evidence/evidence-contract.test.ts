import { describe, expect, it } from 'vitest';
import { evidenceId, validateEvidenceItem } from './evidence-contract.js';
const content = { schemaVersion: 1, kind: 'observation', status: 'fact', subject: { resource: { type: 'instance', id: 1 } }, quality: 'good', observedAt: '2026-09-08T00:00:00.000Z', validUntil: '2026-09-08T00:05:00.000Z', source: 'collector', correlationId: 'c1', provenance: 'metrics_history', dimensions: { a: '1', b: '2' }, payload: { metricId: 'cpu_usage', value: 1 } } as const;
describe('evidence contract', () => {
  it('accepts a bounded versioned item', () => expect(validateEvidenceItem({ ...content, id: evidenceId(content) })).toBe(true));
  it('canonicalizes nested keys and includes dimensions', () => {
    expect(evidenceId(content)).toBe(evidenceId({ ...content, payload: { value: 1, metricId: 'cpu_usage' }, dimensions: { b: '2', a: '1' } }));
    expect(evidenceId(content)).not.toBe(evidenceId({ ...content, dimensions: { a: 'changed' } }));
  });
  it('rejects unknown fields, bad digests, oversized and invalid time windows', () => {
    for (const patch of [{ unexpected: true }, { schemaVersion: 2 }, { validUntil: '2026-09-07T00:00:00.000Z' }, { source: 'x'.repeat(257) }, { payload: { secret: 'x' } }, { quality: 'healthy' }]) {
      const value = { ...content, ...patch };
      expect(validateEvidenceItem({ ...value, id: evidenceId(value) })).toBe(false);
    }
    expect(validateEvidenceItem({ ...content, id: 'a'.repeat(64) })).toBe(false);
  });
});
