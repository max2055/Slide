import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { readFileSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const frontendRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(frontendRoot, '..');
const playwrightCli = path.join(frontendRoot, 'node_modules/@playwright/test/cli.js');
const partsPort = 5188;

test('parts output directory keeps failure traces out of the main Playwright run', async () => {
  const parts = (await import('./playwright.parts.config.ts')).default;
  const main = (await import('./playwright.config.ts')).default;
  assert.equal(main.outputDir, undefined);
  assert.equal(main.use.trace, 'retain-on-failure');
  assert.equal(typeof parts.outputDir, 'string');
  assert.equal(parts.use.trace, 'retain-on-failure');
  assert.equal(path.isAbsolute(parts.outputDir), false);
  const partsRelative = parts.outputDir.replace(/^\.\//, '');
  assert.notEqual(partsRelative, 'test-results');
  assert.equal(partsRelative.includes('..'), false);
  const sameRootMain = path.resolve(frontendRoot, 'test-results');
  const sameRootParts = path.resolve(frontendRoot, parts.outputDir);
  assert.notEqual(sameRootMain, sameRootParts);
  assert.equal(sameRootParts.startsWith(sameRootMain + path.sep), false);
  assert.equal(sameRootMain.startsWith(sameRootParts + path.sep), false);

  const userMain = await listOrNull(path.join(frontendRoot, 'test-results'));
  const userParts = await listOrNull(path.join(frontendRoot, partsRelative));
  const evidenceDir = process.env.MAX298_EVIDENCE_DIR || '';
  const root = await mkdirTemp();
  const runs = [];
  try {
    await writeFile(path.join(root, 'package.json'), '{"name":"max298-output-isolation","private":true}\n');
    await symlink(path.join(frontendRoot, 'node_modules'), path.join(root, 'node_modules'), 'dir');
    await writeFile(path.join(root, 'playwright.config.ts'), await readFile(path.join(frontendRoot, 'playwright.config.ts')));
    await writeFile(path.join(root, 'playwright.parts.config.ts'), await readFile(path.join(frontendRoot, 'playwright.parts.config.ts')));
    await mkdir(path.join(root, 'e2e'), { recursive: true });
    await writeFile(path.join(root, 'index.html'), '<!doctype html><title>max298</title>\n');
    await writeFile(path.join(root, 'e2e/message-parts.spec.ts'), [
      "import { expect, test } from '@playwright/test';",
      "test('controlled failure retains a trace', async ({ page }) => {",
      "  await page.goto('about:blank');",
      "  expect(1).toBe(2);",
      '});',
      '',
    ].join('\n'));

    const mainDir = path.join(root, 'test-results');
    const partsDir = path.join(root, partsRelative);
    await assertPortFree(partsPort);

    const firstMain = await runConfig(root, 'playwright.config.ts');
    runs.push(firstMain);
    assert.equal(firstMain.code, 1, firstMain.output);
    const mainTrace = await findTrace(mainDir);
    assert.ok(mainTrace, 'main config did not retain a failure trace');
    const mainSentinel = path.join(mainDir, 'isolation-sentinel.txt');
    await writeFile(mainSentinel, 'main-trace-must-survive-parts\n');
    const mainTraceHash = await sha256(mainTrace);

    const partsRun = await runConfig(root, 'playwright.parts.config.ts');
    runs.push(partsRun);
    assert.equal(partsRun.code, 1, partsRun.output);
    const partsTrace = await findTrace(partsDir);
    assert.ok(partsTrace, `parts config did not retain a failure trace\n${partsRun.output}`);
    assert.equal(await readFile(mainSentinel, 'utf8'), 'main-trace-must-survive-parts\n');
    assert.equal(await sha256(mainTrace), mainTraceHash);
    const partsSentinel = path.join(partsDir, 'isolation-sentinel.txt');
    await writeFile(partsSentinel, 'parts-trace-must-survive-main\n');
    const partsTraceHash = await sha256(partsTrace);

    const secondMain = await runConfig(root, 'playwright.config.ts');
    runs.push(secondMain);
    assert.equal(secondMain.code, 1, secondMain.output);
    assert.equal(await readFile(partsSentinel, 'utf8'), 'parts-trace-must-survive-main\n');
    assert.equal(await sha256(partsTrace), partsTraceHash);
    await assert.rejects(readFile(mainSentinel, 'utf8'));
    const replacedMainTrace = await findTrace(mainDir);
    assert.ok(replacedMainTrace, 'main config did not recreate its own failure trace');

    assert.equal(await listOrNull(path.join(frontendRoot, 'test-results')), userMain);
    assert.equal(await listOrNull(path.join(frontendRoot, partsRelative)), userParts);
    assertIgnore(`frontend/${partsRelative}/trace.zip`, 'frontend/test-results-parts/');
    assertDockerignore(partsRelative);
    assertCiEntry();

    if (evidenceDir) {
      await mkdir(evidenceDir, { recursive: true });
      await writeFile(path.join(evidenceDir, 'main-first-trace.zip'), await readFile(mainTrace));
      await writeFile(path.join(evidenceDir, 'parts-trace.zip'), await readFile(partsTrace));
      await writeFile(path.join(evidenceDir, 'main-second-trace.zip'), await readFile(replacedMainTrace));
      await writeFile(path.join(evidenceDir, 'report.json'), JSON.stringify({
        mainOutputDir: 'test-results',
        partsOutputDir: parts.outputDir,
        mainTraceHash,
        partsTraceHash,
        replacedMainTraceHash: await sha256(replacedMainTrace),
        runs: runs.map(({ config, code }) => ({ config, code })),
        files: {
          mainAfterParts: await walk(mainDir),
          partsAfterSecondMain: await walk(partsDir),
        },
      }, null, 2));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
    if (evidenceDir && runs.length) {
      await mkdir(evidenceDir, { recursive: true });
      await writeFile(path.join(evidenceDir, 'playwright.log'), runs.map(run => `## ${run.config} exit ${run.code}\n${run.output}`).join('\n'));
    }
  }
});

async function mkdirTemp() {
  const root = path.join(tmpdir(), `max298-output-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(root, { recursive: true });
  return root;
}

function runConfig(root, config) {
  return new Promise((resolve) => {
    const env = { ...process.env };
    delete env.PLAYWRIGHT_MANAGED_ENV;
    const child = spawn(process.execPath, [playwrightCli, 'test', '--config', config, '--reporter=line', '--workers=1'], {
      cwd: root,
      env,
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    const timer = setTimeout(() => { child.kill('SIGTERM'); }, 120_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ config, code, output });
    });
  });
}

async function findTrace(dir) {
  const files = await walk(dir).catch(() => []);
  return files.find((file) => file.endsWith(`${path.sep}trace.zip`)) || '';
}

async function walk(dir, acc = []) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, acc);
    else acc.push(full);
  }
  return acc;
}

async function listOrNull(dir) {
  try {
    return (await readdir(dir)).sort().join('\n');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function sha256(file) {
  return createHash('sha256').update(await readFile(file)).digest('hex');
}

function assertPortFree(port) {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', () => reject(new Error(`port ${port} is already in use`)));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve()));
  });
}

function assertIgnore(repoPath) {
  const output = execFileSync('git', ['check-ignore', '-v', '--', repoPath], { cwd: repoRoot, encoding: 'utf8' });
  assert.match(output, /test-results/);
  const gitignore = readFileSync(path.join(repoRoot, '.gitignore'), 'utf8');
  const directory = repoPath.slice(0, repoPath.lastIndexOf('/'));
  assert.match(gitignore, new RegExp(`^${directory}/$`, 'm'));
}

function assertDockerignore(partsRelative) {
  const rules = readFileSync(path.join(repoRoot, '.dockerignore'), 'utf8');
  const previous = rules.split('\n').filter((line) => line.trim() !== '**/test-results*').join('\n');
  const file = `frontend/${partsRelative}/trace.zip`;
  assert.equal(dockerExcludes(previous, file), false);
  assert.equal(dockerExcludes(rules, file), true);
  assert.equal(dockerExcludes(rules, 'frontend/playwright.parts.config.ts'), false);
  assert.equal(dockerExcludes(rules, 'frontend/test-results/trace.zip'), true);
}

function assertCiEntry() {
  const workflow = readFileSync(path.join(repoRoot, '.github/workflows/ci.yml'), 'utf8');
  assert.match(workflow, /name: Playwright parts output isolation[\s\S]*playwright\.parts-output-isolation\.test\.mjs/);
  assert.equal(workflow.includes('path: frontend/test-results/'), false);
  assert.equal(workflow.includes('path: frontend/test-results\n'), false);
}

function dockerExcludes(rules, file) {
  let excluded = false;
  for (const raw of rules.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const negate = line.startsWith('!');
    const pattern = negate ? line.slice(1) : line;
    if (dockerMatch(pattern, file)) excluded = !negate;
  }
  return excluded;
}

function dockerMatch(pattern, file) {
  const candidates = [file];
  const parts = file.split('/');
  for (let i = 1; i < parts.length; i += 1) candidates.push(parts.slice(0, i).join('/'));
  const regex = dockerToRegExp(pattern);
  return candidates.some((candidate) => regex.test(candidate));
}

function dockerToRegExp(pattern) {
  let source = '';
  const body = pattern.replace(/^\//, '');
  for (let i = 0; i < body.length; i += 1) {
    if (body.startsWith('**/', i)) {
      source += '(?:.*/)?';
      i += 2;
      continue;
    }
    if (body.startsWith('**', i)) {
      source += '.*';
      i += 1;
      continue;
    }
    if (body[i] === '*') {
      source += '[^/]*';
      continue;
    }
    source += body[i].replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`);
}
