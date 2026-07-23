import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

type Coverage = { id: string; command: string; evidence: string };

const root = resolve(import.meta.dirname, '../..');
const review = readFileSync(resolve(root, '.planning/phases/131-system-level-code-review/131-REVIEW.md'), 'utf8');
const findings = [...review.matchAll(/^### ((?:CR|HI|ME|LO|DR|TG|OPT)-\d+)/gm)].map((match) => match[1]);

// This is an index, not a release decision.  139-EVIDENCE-MATRIX.md records
// the command result and environment manifest for the current commit.
const coverage: Coverage[] = [
  ['CR-01', 'apps/db-ops-api/src/auth/security-boundaries.test.ts'], ['CR-02', 'apps/db-ops-api/src/auth/security-boundaries.test.ts'], ['CR-03', 'apps/db-ops-api/src/__tests__/sql-validator.test.ts'],
  ['HI-01', 'apps/db-ops-api/tests/migration-runner.test.ts'], ['HI-02', 'apps/db-ops-api/src/operations/operation-service.test.ts'], ['HI-03', 'apps/db-ops-api/src/auth/security-boundaries.test.ts'], ['HI-04', 'frontend/src/app/ui/views/ai-analysis-result.test.ts'], ['HI-05', 'apps/db-ops-api/src/consistency-checker.test.ts'], ['HI-06', 'apps/db-ops-api/tests/alert-evaluator.test.ts'], ['HI-07', 'apps/db-ops-api/tests/metric-registry.test.ts'], ['HI-08', 'apps/db-ops-api/tests/event-service.test.ts'], ['HI-09', 'apps/db-ops-api/tests/report-scheduler.test.ts'], ['HI-10', 'apps/db-ops-api/src/adapter/__tests__/agent-run-service.test.ts'], ['HI-11', 'apps/db-ops-api/src/workflows/notification-dispatch.test.ts'], ['HI-12', 'apps/db-ops-api/src/migrations/runner.ts'], ['HI-13', 'apps/db-ops-api/src/security/public-dto.test.ts'],
  ['ME-01', 'frontend/src/app/ui/app-chat-session.test.ts'], ['ME-02', 'frontend/src/app/ui/direct-gateway.test.ts'], ['ME-03', 'apps/db-ops-api/tests/collection-scheduler.test.ts'], ['ME-04', 'apps/db-ops-api/tests/monitor-collector.test.ts'], ['ME-05', 'frontend/src/app/ui/views/agents-capabilities.test.ts'], ['ME-06', 'apps/db-ops-api/tests/adapter-capability-matrix.test.ts'], ['ME-07', 'apps/db-ops-api/src/operations/operation-service.test.ts'],
  ['LO-01', 'frontend/src/app/ui/views/__tests__/navigation-cleanup.test.ts'], ['DR-01', 'apps/db-ops-api/src/__tests__/cron-executor.test.ts'], ['DR-02', 'apps/db-ops-api/src/workflows/worker-runtime.test.ts'], ['DR-03', 'apps/db-ops-api/tests/migration-runner.test.ts'], ['DR-04', 'apps/db-ops-api/src/consistency-checker.test.ts'],
  ['TG-01', 'apps/db-ops-api/package.json'], ['TG-02', 'apps/db-ops-api/src/auth/security-boundaries.test.ts'], ['TG-03', 'apps/db-ops-api/tests/schema-validator.ts'], ['TG-04', 'frontend/playwright.config.ts'], ['TG-05', 'apps/db-ops-api/tests/adapter-capability-matrix.test.ts'], ['TG-06', 'tests/qualification/coverage-matrix.ts'],
  ['OPT-01', 'frontend/vite.config.js'], ['OPT-02', 'frontend/src/app/ui/views/__tests__/navigation-cleanup.test.ts'], ['OPT-03', 'apps/db-ops-api/src/security/public-dto.ts'],
].map(([id, evidence]) => ({ id, evidence, command: 'pnpm --filter slide-api test' }));

const mapped = new Map(coverage.map((entry) => [entry.id, entry]));
const missing = findings.filter((id) => !mapped.has(id));
const unknown = coverage.map((entry) => entry.id).filter((id) => !findings.includes(id));
if (missing.length || unknown.length) {
  throw new Error(`qualification coverage mismatch: missing=${missing.join(',') || '-'} unknown=${unknown.join(',') || '-'}`);
}
const absentEvidence = coverage.filter((entry) => !existsSync(resolve(root, entry.evidence))).map((entry) => entry.evidence);
if (absentEvidence.length) throw new Error(`qualification evidence files missing: ${absentEvidence.join(',')}`);

if (process.argv.includes('--validate')) {
  console.log(`qualification coverage valid: ${coverage.length}/${findings.length} findings mapped`);
}

const checkCiAt = process.argv.indexOf('--check-ci');
if (checkCiAt >= 0) {
  const ciPath = process.argv[checkCiAt + 1];
  if (!ciPath) throw new Error('--check-ci requires a workflow path');
  const workflow = readFileSync(resolve(root, ciPath), 'utf8');
  for (const required of ['agent-core:', 'recovery-qualification:', 'bootstrap-upgrade', 'failover', 'backup-restore', 'stability']) {
    if (!workflow.includes(required)) throw new Error(`qualification CI gate missing: ${required}`);
  }
  console.log('qualification CI gates valid');
}
