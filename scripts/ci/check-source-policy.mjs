import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const sourcePath = /^(?:apps|packages|frontend|tests|scripts|\.github)\/[\s\S]*\.(?:[cm]?[jt]sx?|sh|ya?ml)$/i;
const privatePath = /\/Users\/[^/\s'"`]+\/|\/home\/[^/\s'"`]+\/|[a-z]:[\\/]+Users[\\/]+|\.config[\\/]+slide-test-access/i;
const focusedTest = /^\s*(?:test|it|describe)(?:\.(?:concurrent|serial))?\.only\b/;

export function inspectLine(path, line, text) {
  if (!sourcePath.test(path) || /^\s*(?:\/\/|\/\*|\*|#)/.test(text)) return [];
  const findings = [];
  if (privatePath.test(text)) findings.push({ path, line, rule: 'private-path', message: 'Use injected configuration and task-owned temporary paths, not a developer home or private credential path.' });
  if (focusedTest.test(text)) findings.push({ path, line, rule: 'focused-test', message: 'Remove .only; the selected suite must run all its tests.' });
  return findings;
}

export function inspectDiff(path, diff) {
  const findings = [];
  let line = 0;
  for (const text of diff.split('\n')) {
    const hunk = text.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) { line = Number(hunk[1]); continue; }
    if (!line) continue;
    if (text.startsWith('+')) findings.push(...inspectLine(path, line++, text.slice(1)));
    else if (text.startsWith(' ')) line++;
  }
  return findings;
}

export function checkSourcePolicy(base = 'HEAD', head, cwd = process.cwd()) {
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  // Resolve refs before passing them to diff; PR callers supply the merge base.
  const commit = ref => git('rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`).trim();
  const baseCommit = commit(base);
  const ranges = head ? [[baseCommit, commit(head)]] : [[baseCommit], ['--cached', baseCommit]];
  const findings = [];
  for (const range of ranges) {
    const paths = git('diff', '--name-only', '--no-renames', '-z', ...range, '--').split('\0').filter(Boolean);
    for (const path of paths.filter(path => sourcePath.test(path))) {
      findings.push(...inspectDiff(path, git('diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--unified=0', ...range, '--', path)));
    }
  }
  if (!head) {
    for (const path of git('ls-files', '--others', '--exclude-standard', '-z').split('\0').filter(path => sourcePath.test(path))) {
      readFileSync(`${cwd}/${path}`, 'utf8').split('\n').forEach((text, index) => findings.push(...inspectLine(path, index + 1, text)));
    }
  }
  return [...new Map(findings.map(finding => [JSON.stringify(finding), finding])).values()];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.length > 2) throw new Error('Usage: node scripts/ci/check-source-policy.mjs [base [head]]');
  const findings = checkSourcePolicy(...args);
  // Never echo source lines: a rejected line may contain credentials.
  for (const finding of findings) console.error(`${finding.path}:${finding.line} [${finding.rule}] ${finding.message}`);
  console.log(`Source policy: ${findings.length} violation(s).`);
  process.exitCode = findings.length ? 1 : 0;
}
