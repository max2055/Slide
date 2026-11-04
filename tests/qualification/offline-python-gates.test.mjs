// Regression for #403 / MAX-283. All writes stay in disposable synthetic trees.
// Included by CI's node --test tests/qualification/*.test.mjs entry point.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../../', import.meta.url));
const verifyPath = 'docs/slide/metrics-v2/v1/verify.py';
const freezePath = 'tests/qualification/freeze-token-calibration.py';
const corpusPath = 'packages/agent-core/src/__tests__/fixtures/token-calibration-v1.json';
const modes = [
  { name: 'normal', args: [], optimize: '' },
  { name: '-O', args: ['-O'], optimize: '' },
  { name: '-OO', args: ['-OO'], optimize: '' },
  { name: 'PYTHONOPTIMIZE=1', args: [], optimize: '1' },
  { name: 'PYTHONOPTIMIZE=2', args: [], optimize: '2' },
];

function python(cwd, mode, args, extraEnv = {}) {
  const result = spawnSync('python3', ['-B', ...mode.args, ...args], {
    cwd, encoding: 'utf8', timeout: 30_000,
    env: { ...process.env, PYTHONOPTIMIZE: mode.optimize, ...extraEnv },
  });
  if (process.env.OFFLINE_GATE_TRACE) {
    appendFileSync(process.env.OFFLINE_GATE_TRACE, JSON.stringify({
      mode: mode.name, args, status: result.status, stdout: result.stdout, stderr: result.stderr,
    }) + '\n');
  }
  assert.ifError(result.error);
  assert.equal(result.signal, null, result.stderr);
  return result;
}

function unchanged(path, expected) {
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  assert.equal(hash(readFileSync(path)), hash(expected), 'frozen file changed');
}

function rejected(result, diagnostic) {
  assert.notEqual(result.status, 0, `unexpected acceptance: ${result.stdout}`);
  assert.doesNotMatch(result.stdout, /PASS:|Frozen \d+ samples/);
  assert.match(result.stderr, diagnostic);
}

function sandbox(t) {
  const dir = mkdtempSync(join(tmpdir(), 'slide-offline-gates-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('metrics gate rejects illegal input and preserves snapshots in every Python mode', async (t) => {
  const dir = sandbox(t);
  const here = join(dir, dirname(verifyPath));
  cpSync(join(root, dirname(verifyPath)), here, { recursive: true });
  // Read-only source inputs; snapshots and fixture mutations live in the sandbox.
  for (const path of ['apps', 'frontend']) symlinkSync(join(root, path), join(dir, path), 'dir');
  const setup = python(dir, modes[0], ['-c', `
import json, runpy
m = runpy.run_path('${verifyPath}')
(m['HERE'] / 'inventory.json').write_text(json.dumps(m['snapshot']()))
`]);
  assert.equal(setup.status, 0, setup.stderr);
  const inventoryPath = join(here, 'inventory.json');
  const inventory = readFileSync(inventoryPath);
  const fixturePath = join(here, 'fixtures.json');
  const fixture = readFileSync(fixturePath);

  for (const mode of modes) {
    await t.test(`${mode.name}: valid CLI input passes`, () => {
      const result = python(dir, mode, [verifyPath]);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /PASS: \d+ registry identities/);
      unchanged(inventoryPath, inventory);
    });

    await t.test(`${mode.name}: snapshot drift is nonzero without rewriting inventory`, () => {
      const drift = Buffer.from('{"drift":true}\n');
      writeFileSync(inventoryPath, drift);
      try {
        rejected(python(dir, mode, [verifyPath]), /source snapshot drift/);
        unchanged(inventoryPath, drift);
      } finally { writeFileSync(inventoryPath, inventory); }
    });

    const mutations = [
      ['duplicate registry identity', "data['registry'].append(data['registry'][0].copy())", /duplicate registry identity/],
      ['unmapped ID', "data['registry'][0]['id'] = 'not_a_registered_metric'", /unmapped legacy IDs/],
      ['wrong target mapping', "data['registry'][0]['target_type'] = 'server'", /mapping|target|registry/],
      ['missing source', "data['references'][0]['path'] = 'does-not-exist.ts'", /does-not-exist/],
    ];
    for (const [name, mutate, diagnostic] of mutations) {
      await t.test(`${mode.name}: ${name} fails without PASS`, () => {
        rejected(python(dir, mode, ['-c', `
import json, runpy
m = runpy.run_path('${verifyPath}')
data = json.loads((m['HERE'] / 'inventory.json').read_text())
${mutate}
m['verify'](data)
`]), diagnostic);
        unchanged(inventoryPath, inventory);
      });
    }

    const invalidFixtures = [
      ['non-synthetic fixture', f => { f.synthetic = false; }],
      ['wrong semantic version', f => { f.resources[0].semantic_version = 'wrong'; }],
      ['wrong arithmetic', f => { f.resources[0].expected['db.uptime_seconds'] = -1; }],
      ['invalid negative case', f => { f.non_mappable[0].mapping_allowed = true; }],
      ['sensitive fixture field', f => { f.secret = 'synthetic-sentinel'; }],
    ];
    for (const [name, mutate] of invalidFixtures) {
      await t.test(`${mode.name}: --refresh rejects ${name} before any snapshot write`, () => {
        const invalid = JSON.parse(fixture);
        mutate(invalid);
        writeFileSync(fixturePath, JSON.stringify(invalid));
        // A stale sentinel proves refresh did not overwrite the old snapshot.
        const sentinel = Buffer.from('previous frozen inventory\n');
        writeFileSync(inventoryPath, sentinel);
        try {
          rejected(python(dir, mode, [verifyPath, '--refresh']), /Error/);
          unchanged(inventoryPath, sentinel);
        } finally {
          writeFileSync(fixturePath, fixture);
          writeFileSync(inventoryPath, inventory);
        }
      });
    }

    await t.test(`${mode.name}: --refresh accepts reviewed valid input`, () => {
      writeFileSync(inventoryPath, '{}\n');
      try {
        const result = python(dir, mode, [verifyPath, '--refresh']);
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /PASS:/);
        assert.deepEqual(JSON.parse(readFileSync(inventoryPath)), JSON.parse(inventory));
      } finally { writeFileSync(inventoryPath, inventory); }
    });
  }
});

test('freeze CLI checks tokenizer version before encoding or overwriting frozen corpus', async (t) => {
  const dir = sandbox(t);
  const script = join(dir, freezePath);
  mkdirSync(dirname(script), { recursive: true });
  cpSync(join(root, freezePath), script);
  const corpus = join(dir, corpusPath);
  mkdirSync(dirname(corpus), { recursive: true });
  const sentinel = Buffer.from('previous frozen corpus\n');
  const stubPath = join(dirname(script), 'tiktoken.py');
  for (const mode of modes) {
    for (const version of ['0.11.0', '0.13.0', null]) {
      await t.test(`${mode.name}: rejects tokenizer ${version ?? 'missing version'}; corpus unchanged`, () => {
        writeFileSync(corpus, sentinel);
        // A functional stub makes optimized bypass return zero and overwrite,
        // rather than hiding the defect behind a missing tokenizer API.
        writeFileSync(stubPath, `${version === null ? '' : `__version__ = '${version}'\n`}
class Encoding:
    def encode(self, payload, disallowed_special=()):
        return [1]
def get_encoding(name):
    print('ENCODING_REACHED')
    return Encoding()
`);
        const result = python(dir, mode, [freezePath], { PYTHONPATH: dirname(script) });
        rejected(result, /tiktoken|tokenizer/);
        assert.doesNotMatch(result.stdout, /ENCODING_REACHED/);
        unchanged(corpus, sentinel);
      });
    }
    await t.test(`${mode.name}: pinned tokenizer reaches generation (controlled stub)`, () => {
      writeFileSync(stubPath, `__version__ = '0.12.0'
class Encoding:
    def encode(self, payload, disallowed_special=()):
        return [1]
def get_encoding(name):
    return Encoding()
`);
      const result = python(dir, mode, [freezePath], { PYTHONPATH: dirname(script) });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /Frozen 140 samples/);
      assert.equal(JSON.parse(readFileSync(corpus)).sampleCount, 140);
    });
  }
});
