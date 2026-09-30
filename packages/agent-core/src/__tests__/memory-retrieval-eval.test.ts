import { it, expect } from 'vitest';
import { evaluateRetrieval } from './helpers/retrieval-evaluation.js';
it('frozen ≥200 records/≥50 queries meets Recall@5, budget, scope/source negatives and median cost gates', async () => {
  const report = await evaluateRetrieval();
  expect(report.records).toBeGreaterThanOrEqual(200); expect(report.queries).toBeGreaterThanOrEqual(50);
  expect(report.metrics.recallAt5).toBeGreaterThanOrEqual(0.9);
  expect(report.metrics.medianTokenReduction).toBeGreaterThanOrEqual(0.5);
  expect(report.metrics.forbiddenReturned).toBe(0); expect(report.metrics.scopeNegativeReturned).toBe(0);
  expect(report.metrics.unmatchedReturned).toBe(0); expect(report.metrics.deterministic).toBe(true); expect(report.metrics.withinBudget).toBe(true);
}, 30000);
