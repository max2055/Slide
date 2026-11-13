import { afterEach, beforeEach, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { StructuredMemoryStore } from '../memory-record.js';

let directory: string;
let store: StructuredMemoryStore;
let children: Array<{ child: ChildProcess; done: Promise<void> }>;
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-lock-'));
  store = new StructuredMemoryStore(directory);
  children = [];
});
afterEach(async () => {
  for (const { child } of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  await Promise.allSettled(children.map(c => c.done));
  await fs.rm(directory, { recursive: true, force: true });
});

async function worker(body: string) {
  const script = path.join(directory, `worker-${crypto.randomUUID()}.mts`);
  const core = fileURLToPath(new URL('../memory-record.ts', import.meta.url));
  const loader = fileURLToPath(new URL('../../../../apps/db-ops-api/node_modules/tsx/dist/loader.mjs', import.meta.url));
  await fs.writeFile(script, `import fs from 'node:fs/promises';
import path from 'node:path';
import { StructuredMemoryStore } from ${JSON.stringify(core)};
const store = new StructuredMemoryStore(${JSON.stringify(directory)});
const gate = () => new Promise(resolve => process.once('message', resolve));
${body}
process.disconnect();`);
  const child = spawn(process.execPath, ['--import', loader, script], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = '';
  child.stderr!.on('data', chunk => { stderr += chunk; });
  const done = new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`worker ${code}/${signal}: ${stderr}`)));
  });
  void done.catch(() => undefined);
  children.push({ child, done });
  const ready = new Promise<void>((resolve, reject) => {
    child.once('message', () => resolve());
    void done.then(() => reject(new Error('worker exited before barrier')), reject);
  });
  await ready;
  return { child, done };
}

async function deadOwner() {
  const exited = await worker(`process.send('ready');`);
  await exited.done;
  return { pid: exited.child.pid!, host: os.hostname(), token: 'dead-owner' };
}
async function increment() {
  await store.transaction(state => {
    state.budgets.counter ??= { attempts: 0, tokens: 19 };
    state.budgets.counter.attempts++;
  });
}

// #450 / #451: original failures reproduced through the public transaction API.
it.each(['', '{"pid":', 'dead'])('recovers legacy %j lock with an empty crashed reclaim guard', async value => {
  const dead = await deadOwner();
  await fs.writeFile(store.file + '.lock', value === 'dead' ? JSON.stringify(dead) : value);
  await fs.writeFile(store.file + '.lock.reclaim', '');
  await increment();
  await increment();
  expect(JSON.parse(await fs.readFile(store.file, 'utf8')).budgets.counter).toEqual({ attempts: 2, tokens: 19 });
  // Obsolete guard is diagnostic evidence, never interpreted as new ownership.
  expect(await fs.readFile(store.file + '.lock.reclaim', 'utf8')).toBe('');
});

it.each(['created', 'partial', 'guard', 'release'])('SIGKILL at %s boundary recovers safely; live owner remains busy regardless of age', async phase => {
  const crashed = await worker(`
const open = fs.open.bind(fs), rename = fs.rename.bind(fs), rmdir = fs.rmdir.bind(fs);
const pause = async () => { const wait = gate(); process.send('paused'); await wait; };
fs.open = async (file, ...args) => {
  const handle = await open(file, ...args);
  if (file === store.file + '.lock' && ${JSON.stringify(phase)} === 'created') await pause();
  if (file === store.file + '.lock' && ${JSON.stringify(phase)} === 'partial') {
    handle.writeFile = async () => { await handle.write('{"pid":'); await pause(); };
  }
  return handle;
};
fs.rename = async (from, to) => {
  await rename(from, to);
  if (to === store.file + '.lock.owner' && ${JSON.stringify(phase)} === 'guard') await pause();
};
fs.rmdir = async dir => {
  await rmdir(dir);
  if (path.dirname(String(dir)) === store.file + '.lock.owner' && ${JSON.stringify(phase)} === 'release') await pause();
};
await store.transaction(state => { state.budgets.counter = { attempts: 1, tokens: 19 }; });`);
  if (phase !== 'release') {
    await fs.utimes(store.file + '.lock.owner', 1, 1);
    await expect(increment()).rejects.toThrow('MEMORY_STORE_BUSY');
  }
  crashed.child.kill('SIGKILL');
  await expect(crashed.done).rejects.toThrow('SIGKILL');
  await increment();
  const counter = JSON.parse(await fs.readFile(store.file, 'utf8')).budgets.counter;
  expect(counter).toEqual({ attempts: phase === 'release' ? 2 : 1, tokens: 19 });
  await expect(fs.stat(store.file + '.lock.owner')).rejects.toMatchObject({ code: 'ENOENT' });
}, 15000);

it('a delayed stale remover cannot remove a fresh owner after another reclaimer wins', async () => {
  const dead = await deadOwner();
  const guard = store.file + '.lock.owner';
  const marker = Buffer.from(JSON.stringify(dead)).toString('base64url');
  await fs.mkdir(path.join(guard, marker), { recursive: true });
  const delayed = await worker(`const rmdir = fs.rmdir.bind(fs);
let paused = false;
fs.rmdir = async dir => {
  if (!paused && String(dir) === ${JSON.stringify(path.join(guard, marker))}) {
    paused = true; const wait = gate(); process.send('stale observed'); await wait;
  }
  return rmdir(dir);
};
try { await store.transaction(() => { throw new Error('unexpected entry'); }); }
catch (error) { if (error.message !== 'MEMORY_STORE_BUSY') throw error; }`);
  const fresh = await worker(`await store.transaction(async state => {
state.budgets.counter = { attempts: 1, tokens: 19 };
const wait = gate(); process.send('held'); await wait;
});`);
  delayed.child.send('resume');
  await delayed.done;
  await expect(increment()).rejects.toThrow('MEMORY_STORE_BUSY');
  expect(await fs.readdir(guard)).toHaveLength(1);
  fresh.child.send('commit');
  await fresh.done;
  await increment();
  expect(JSON.parse(await fs.readFile(store.file, 'utf8')).budgets.counter.attempts).toBe(2);
}, 15000);

it.each(['foreign', 'invalid'])('fails closed for %s guard ownership', async kind => {
  const marker = kind === 'foreign'
    ? Buffer.from(JSON.stringify({ pid: 123, host: 'another-host', token: 'foreign' })).toString('base64url') : 'invalid';
  await fs.mkdir(path.join(store.file + '.lock.owner', marker), { recursive: true });
  await expect(increment()).rejects.toThrow('MEMORY_STORE_BUSY');
  expect(await fs.readdir(store.file + '.lock.owner')).toEqual([marker]);
});

it('simultaneous processes serialize increments through transactions after a dead owner', async () => {
  const dead = await deadOwner();
  await fs.writeFile(store.file + '.lock', JSON.stringify(dead));
  const workers = await Promise.all(Array.from({ length: 4 }, () => worker(`
const wait = gate(); process.send('ready'); await wait;
for (let count = 0, attempts = 0; count < 10; attempts++) {
  if (attempts > 2000) throw new Error('contention did not resolve');
  try {
    await store.transaction(async state => {
      state.budgets.counter ??= { attempts: 0, tokens: 19 };
      const prior = state.budgets.counter.attempts;
      await new Promise(resolve => setImmediate(resolve));
      state.budgets.counter.attempts = prior + 1;
    });
    count++;
  } catch (error) { if (error.message !== 'MEMORY_STORE_BUSY') throw error; }
}
`)));
  for (const { child } of workers) child.send('start');
  await Promise.all(workers.map(w => w.done));
  expect(JSON.parse(await fs.readFile(store.file, 'utf8')).budgets.counter).toEqual({ attempts: 40, tokens: 19 });
}, 20000);
