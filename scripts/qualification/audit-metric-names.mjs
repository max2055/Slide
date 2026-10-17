import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

// Check current code/configuration. Historical SQL, tests and evidence are immutable.
const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
const generation = /metrics?-v[12]|metrics?_v[12]|MetricsV[12]|METRICS_V[12]/g;
const exceptions = new Map([
  ['apps/db-ops-api/src/metrics/legacy-routes.ts', 'Same handler/auth alias; Sunset 2026-11-15; remove after external callers migrate.'],
  ['apps/db-ops-api/src/metrics/rollout/alert-publication-fence.ts', 'Recognize historical notification source to retain publication fencing; remove after old notifications drain.'],
]);
const residuals = [], permitted = [], historical = [];
for (const file of files) {
  if (!/^(apps\/|frontend\/|packages\/|scripts\/|docker|compose|\.env)/.test(file)) continue;
  if (/\.(?:md|png|jpg|zip|gz|svg|lock)$/.test(file)) continue;
  if (/\/(?:sql\/migrations|migrations\/metric-history)\//.test(file)
      || /\.(?:test|spec)\./.test(file) || /\/(?:tests|e2e)\//.test(file)
      || file === 'scripts/qualification/audit-metric-names.mjs') {
    historical.push(file);
    continue;
  }
  if (!/\.(?:[cm]?js|tsx?|json|ya?ml|example|conf|toml)$/.test(file) && !/\.env/.test(file)) continue;
  if (generation.test(file)) residuals.push({ file, reason: 'generation directory or filename' });
  generation.lastIndex = 0;
  readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
    const matches = [...line.matchAll(generation)].map(match => match[0]);
    if (matches.length) {
      const item = { file, line: index + 1, matches };
      if (exceptions.has(file)) permitted.push({ ...item, reason: exceptions.get(file) });
      else residuals.push(item);
    }
    if (/\b(?:import|export)\b.*(?:from\s*|import\s*\().*['"][^'"]*migrations\/metric-history\//.test(line)) {
      residuals.push({ file, line: index + 1, reason: 'production import of historical implementation' });
    }
  });
}
const report = {
  code_head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  scope: 'Tracked runtime code and configuration; database metadata covered by unified-metrics.mysql.test.ts.',
  permitted, residuals, historical_file_count: historical.length,
};
if (process.argv[2]) writeFileSync(process.argv[2], JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
if (residuals.length) process.exitCode = 1;
