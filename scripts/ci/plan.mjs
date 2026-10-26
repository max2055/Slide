import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const selections = ['api', 'browser', 'integration', 'recovery', 'sandbox', 'rollout', 'artifact', 'code'];

// Markdown and planning notes cannot change runtime behaviour. Contract JSON under
// docs/ is not documentation for this purpose: it is generated API/metrics output.
const docOnly = /^(?:docs\/.*\.mdx?$|(?:README|AGENTS|CLAUDE)\.md$|LICENSE$|\.planning\/)/i;
// Shared boundaries: any change here keeps the complete candidate.
const crossCutting = /(?:security|authorization|permission|credential|sandbox|approval|auth\/|adapter\/|websocket|(?:^|\/)ws\/|investigations\/|migrations\/|(?:^|\/)sql\/|contracts\/|db-connection|worker-startup|lifecycle\/)/i;
// Metric data, quality and query-chain changes keep their end-to-end checks.
const dataPath = /(?:metrics|metric-|quality|query)/i;
// Worker and scheduling chains are exercised by the recovery qualification
// (lease/failover, bounded queue, report and schedule recovery), so they keep it.
const workerPath = /(?:worker|schedul)/i;
// The recovery qualification runs the workflow assembly and report outbox
// tests directly, so the whole workflows module keeps recovery even where a
// file name mentions neither worker nor scheduling.
const workflowPath = /^apps\/db-ops-api\/src\/workflows\//;

export function planChecks(eventName, paths = []) {
  const plan = Object.fromEntries(selections.map(key => [key, false]));
  const full = () => Object.assign(plan, Object.fromEntries(selections.map(key => [key, true])));
  if (eventName !== 'pull_request' || paths.length === 0) return full();
  for (const path of paths) {
    if (docOnly.test(path)) continue;
    // Unknown or cross-cutting paths never shrink the candidate.
    if (crossCutting.test(path)) return full();
    if (/^frontend\/(?:src|e2e|public)\//.test(path)) {
      plan.browser = plan.integration = true;
      plan.code = true;
      continue;
    }
    if (/^apps\/db-ops-api\//.test(path)) {
      // Package, entry point or unknown backend location: verify everything.
      if (/^apps\/db-ops-api\/(?:package\.json|[^/]+$)/.test(path)) return full();
      if (dataPath.test(path)) { plan.api = plan.code = plan.browser = plan.integration = plan.recovery = true; continue; }
      if (workflowPath.test(path) || workerPath.test(path)) { plan.api = plan.code = plan.recovery = true; continue; }
      // Anything not explicitly classified is an unknown backend module, so
      // the conservative default keeps the complete candidate.
      return full();
    }
    return full();
  }
  return plan;
}

export function requiredJobs(plan) {
  for (const key of selections) {
    if (typeof plan?.[key] !== 'boolean') throw new Error(`Invalid CI selection: ${key}`);
  }
  if (plan.integration && !plan.browser) throw new Error('Integration requires browser checks');
  if (plan.rollout && !plan.api) throw new Error('Rollout requires the full SQL candidate');
  if (!plan.code && [plan.api, plan.browser, plan.integration, plan.recovery, plan.sandbox, plan.rollout, plan.artifact].some(Boolean)) {
    throw new Error('Documentation-only selection cannot require code checks');
  }
  return {
    backend: plan.code, frontend: plan.code, 'agent-core': plan.code, 'sandbox-controller': plan.code, security: true,
    browser: plan.browser, 'browser-qualification': plan.integration, 'browser-edge-qualification': plan.integration,
    'investigation-workspace-qualification': plan.integration,
    'recovery-qualification': plan.recovery, 'investigation-api-qualification': plan.api,
    'investigation-rollout-qualification': plan.rollout, 'rootless-sandbox-qualification': plan.sandbox,
  };
}

export function validateResults(plan, needs, includeRelease = true) {
  if (needs?.plan?.result !== 'success') throw new Error('CI planning did not succeed');
  const jobs = requiredJobs(plan);
  if (includeRelease) jobs['release-artifact'] = true;
  const failures = [];
  for (const [name, selected] of Object.entries(jobs)) {
    const expected = selected ? 'success' : 'skipped';
    if (needs[name]?.result !== expected) failures.push(`${name}: expected ${expected}, got ${needs[name]?.result ?? 'missing'}`);
  }
  if (failures.length) throw new Error(failures.join('\n'));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const eventName = process.env.GITHUB_EVENT_NAME;
  if (!eventName) throw new Error('GITHUB_EVENT_NAME is required');
  let paths = [];
  if (eventName === 'pull_request') {
    const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
    const base = event.pull_request?.base?.sha;
    const head = event.pull_request?.head?.sha;
    if (![base, head].every(sha => typeof sha === 'string' && /^[a-f0-9]{40,64}$/.test(sha))) {
      throw new Error('Missing or invalid pull request commit range');
    }
    paths = execFileSync('git', ['diff', '--name-only', '--no-renames', '-z', `${base}...${head}`, '--'], { encoding: 'utf8' }).split('\0').filter(Boolean);
  }
  const plan = planChecks(eventName, paths);
  requiredJobs(plan);
  const output = [`selection=${JSON.stringify(plan)}`, ...Object.entries(plan).map(([key, value]) => `${key}=${value}`)].join('\n') + '\n';
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, output);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## CI execution plan\n\nEvent: ${eventName}; changed paths: ${paths.length}.\n\n| Check | Selected |\n| --- | --- |\n${Object.entries(plan).map(([key, value]) => `| ${key} | ${value} |`).join('\n')}\n`);
  }
  console.log(output);
}
