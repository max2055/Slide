import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { evaluateRetrieval } from '../../packages/agent-core/src/__tests__/helpers/retrieval-evaluation.js';
const report = await evaluateRetrieval();
if (process.env.MEMORY_RETRIEVAL_REPORT) await fs.writeFile(process.env.MEMORY_RETRIEVAL_REPORT, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ records: report.records, queries: report.queries, fixtureHash: report.fixtureHash, metrics: report.metrics }));
assert(report.metrics.recallAt5 >= 0.9 && report.metrics.medianTokenReduction >= 0.5);
assert(report.metrics.forbiddenReturned === 0 && report.metrics.scopeNegativeReturned === 0 && report.metrics.unmatchedReturned === 0);
assert(report.metrics.deterministic && report.metrics.withinBudget);
