import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const rules = [
  ['private-key', /-----BEGIN\s+(?:(?:RSA|EC|OPENSSH|ENCRYPTED)\s+)?PRIVATE\s+KEY-----/g],
  ['jwt', /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g],
  ['bearer', /\bBearer\s+[A-Za-z0-9._~+/=-]{24,}/gi],
  ['api-key', /\b(?:sk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/g],
  ['credential-url', /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@[^\s/]+/gi],
  ['credential-field', /["']?\b(?:api[_-]?key|access[_-]?token|client[_-]?secret|jwt[_-]?secret(?:[_-]?key)?|db[_-]?password|password|passwd|pwd)["']?\s*[:=]\s*["']([^"'\r\n]{12,})["']/gi],
  ['credential-field-unquoted', /^[ \t]*(?:api[_-]?key|access[_-]?token|client[_-]?secret|jwt[_-]?secret(?:[_-]?key)?|db[_-]?password|password|passwd|pwd)\s*[:=][ \t]*([a-z0-9_+./=-]{12,})/gim],
  ['credential-field-multiline', /\b(?:api[_-]?key|access[_-]?token|client[_-]?secret|jwt[_-]?secret(?:[_-]?key)?|db[_-]?password|password|passwd|pwd)\s*:\s*[|>][-+]?[ \t]*\r?\n[ \t]+[^\s]{12,}/gi],
];

// Decode percent escapes while retaining offsets in the original text. Encoded
// line breaks must not corrupt the reported source location.
function decodeWithOffsets(text) {
  let decoded = '';
  const offsets = [];
  for (let i = 0; i < text.length; i++) {
    offsets.push(i);
    if (text[i] === '%' && /^[0-9a-f]{2}$/i.test(text.slice(i + 1, i + 3))) {
      decoded += String.fromCharCode(parseInt(text.slice(i + 1, i + 3), 16));
      i += 2;
    } else decoded += text[i];
  }
  return { text: decoded, offsets };
}

export function inspectSecrets(file, text) {
  const views = [{ text, offsets: undefined }, decodeWithOffsets(text)];
  const findings = new Map();
  for (const view of views) {
    for (const [rule, pattern] of rules) {
      pattern.lastIndex = 0;
      for (const match of view.text.matchAll(pattern)) {
        // In Bash, a double-quoted required/pure parameter expansion reads an
        // injected value. Defaults (:-), single quotes and mixed text remain
        // literals to audit; other secret-format rules still scan this text.
        if (rule === 'credential-field' && /\.sh$/i.test(file) && match[0].endsWith('"')
          && /^\$\{[A-Z_][A-Z0-9_]*(?::?\?[^}]*)?\}$/.test(match[1])) continue;
        const offset = view.offsets?.[match.index] ?? match.index;
        const line = text.slice(0, offset).split('\n').length;
        const fingerprint = createHash('sha256').update(JSON.stringify([file, rule, match[0]])).digest('hex');
        findings.set(`${rule}:${offset}`, { path: file, line, rule, fingerprint });
      }
    }
  }
  return [...findings.values()].sort((a, b) => a.line - b.line || a.rule.localeCompare(b.rule));
}

export function scanRepository({ cwd = process.cwd(), base, head } = {}) {
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'buffer', maxBuffer: 128 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  const commit = ref => git('rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`).toString().trim();
  if (head && !base) throw new Error('BASE_REQUIRED');
  const baseCommit = base ? commit(base) : undefined;
  const headCommit = head ? commit(head) : undefined;
  const treePaths = ref => git('ls-tree', '-r', '--name-only', '-z', ref).toString().split('\0').filter(Boolean);
  const paths = headCommit ? treePaths(headCommit) : [...new Set(git('ls-files', '--cached', '--others', '--exclude-standard', '-z').toString().split('\0').filter(Boolean))];
  const oldPaths = new Set(baseCommit ? treePaths(baseCommit) : []);
  const findings = [];
  const binaryPaths = [];
  let textFiles = 0;
  for (const file of paths) {
    let bytes;
    if (headCommit) bytes = git('show', `${headCommit}:${file}`);
    else {
      try {
        if (!lstatSync(`${cwd}/${file}`).isFile()) throw new Error('NON_REGULAR_SCAN_INPUT');
        bytes = readFileSync(`${cwd}/${file}`);
      }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    }
    if (bytes.includes(0)) { binaryPaths.push(file); continue; }
    textFiles++;
    const current = inspectSecrets(file, bytes.toString('utf8'));
    const previous = new Map();
    if (baseCommit && current.length && oldPaths.has(file)) {
      for (const finding of inspectSecrets(file, git('show', `${baseCommit}:${file}`).toString('utf8'))) {
        previous.set(finding.fingerprint, (previous.get(finding.fingerprint) ?? 0) + 1);
      }
    }
    for (const finding of current) {
      const remaining = previous.get(finding.fingerprint) ?? 0;
      if (remaining) previous.set(finding.fingerprint, remaining - 1);
      else findings.push(finding);
    }
  }
  return { mode: baseCommit ? 'incremental' : 'full', base: baseCommit ?? null, head: headCommit ?? null, textFiles, binaryPaths, findings };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2);
    let base, head;
    if (args.length) {
      if (![2, 4].includes(args.length) || args[0] !== '--base' || (args.length === 4 && args[2] !== '--head')) throw new Error();
      base = args[1]; head = args[3];
    }
    const result = scanRepository({ base, head });
    // Structured output contains positions and fingerprints only, never matches.
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.findings.length ? 1 : 0;
  } catch {
    console.error('SECRET_SCAN_FAILED: verify arguments, Git refs and readable files.');
    process.exitCode = 2;
  }
}
