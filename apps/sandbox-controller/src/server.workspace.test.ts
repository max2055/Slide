import http from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { once, EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { signRequest } from './request-auth.js';

// Keep the real HTTP handler, HMAC verification and filesystem; no shared DB or Docker.
vi.mock('./nonce-store.js', () => ({
  MySqlNonceStore: { fromEnvironment: () => ({ claim: async () => true, cleanup: async () => {} }) },
}));
vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  spawn: vi.fn(),
}));

const secret = 'test-controller-secret'.repeat(2);
const file = (name: string, content = 'ok') => ({ path: name, contentBase64: Buffer.from(content).toString('base64') });
let root: string;
let server: http.Server;
let baseUrl: string;
let cleanupTimer: ReturnType<typeof setInterval>;
const children: Array<EventEmitter & { stdout: PassThrough; stderr: PassThrough }> = [];

async function submit(files: unknown, signed = true) {
  const body = Buffer.from(JSON.stringify({ runtime: 'node', command: ['node', 'main.mjs'], files }));
  const timestamp = String(Date.now());
  const nonce = randomUUID();
  const response = await fetch(`${baseUrl}/v1/jobs`, {
    method: 'POST', body,
    headers: signed ? {
      'x-slide-timestamp': timestamp, 'x-slide-nonce': nonce,
      'x-slide-signature': signRequest(secret, timestamp, nonce, body),
    } : {},
  });
  return { status: response.status, body: await response.json() as { jobId: string; error?: string } };
}

async function expectClean() {
  await vi.waitFor(async () => expect(await fs.readdir(root)).toEqual(['other-task']));
  expect(await fs.readFile(path.join(root, 'other-task', 'keep.txt'), 'utf8')).toBe('keep');
}

describe('MAX-461 / #401 controller workspace failure recovery', () => {
  beforeAll(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'slide-workspace-')));
    await fs.mkdir(path.join(root, 'other-task'));
    await fs.writeFile(path.join(root, 'other-task', 'keep.txt'), 'keep');
    vi.stubEnv('SANDBOX_CONTROLLER_PORT', '0');
    vi.stubEnv('SANDBOX_CONTROLLER_SECRET', secret);
    vi.stubEnv('SANDBOX_WORKSPACE_ROOT', root);
    vi.stubEnv('SANDBOX_IMAGES', JSON.stringify({ node: `node@sha256:${'a'.repeat(64)}` }));
    vi.stubEnv('SANDBOX_EXECUTION_PROFILES', '{}');
    const createServer = vi.spyOn(http, 'createServer');
    const interval = vi.spyOn(globalThis, 'setInterval');
    await import('./server.js');
    server = createServer.mock.results[0].value;
    cleanupTimer = interval.mock.results[0].value;
    createServer.mockRestore();
    interval.mockRestore();
    if (!server.listening) await once(server, 'listening');
    baseUrl = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.mocked(spawn).mockReset();
    children.length = 0;
    try {
      await expectClean();
    } finally {
      // Keep each failure case isolated even when a regression leaves partial files.
      for (const entry of await fs.readdir(root)) {
        if (entry !== 'other-task') await fs.rm(path.join(root, entry), { recursive: true, force: true });
      }
    }
  });

  afterAll(async () => {
    clearInterval(cleanupTimer);
    if (server) {
      const closed = new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      server.closeIdleConnections();
      await closed;
    }
    vi.unstubAllEnvs();
    if (root) await fs.rm(root, { recursive: true, force: true });
  });

  it.each([
    ['invalid base64', [file('first.txt'), { path: 'second.txt', contentBase64: '!!!!' }], 'SANDBOX_FILE_CONTENT_INVALID'],
    ['noncanonical base64', [file('first.txt'), { path: 'second.txt', contentBase64: 'Zh==' }], 'SANDBOX_FILE_CONTENT_INVALID'],
    ['invalid path', [file('first.txt'), file('../escape')], 'SANDBOX_FILE_PATH_INVALID'],
    ['write collision', [file('first.txt'), file('first.txt')], 'EEXIST'],
    ['directory creation failure', [file('first.txt'), file('first.txt/child')], 'EEXIST'],
    ['cumulative size', [file('first.txt', 'a'.repeat(600_000)), file('second.txt', 'b'.repeat(500_000))], 'SANDBOX_FILES_TOO_LARGE'],
  ])('cleans partial files after %s', async (_name, files, error) => {
    const result = await submit(files);
    expect(result.status).toBe(400);
    expect(result.body.error).toContain(error);
    expect(spawn).not.toHaveBeenCalled();
    await expectClean();
  });

  it('cleans after final chmod failure', async () => {
    vi.spyOn(fs, 'chmod').mockRejectedValueOnce(new Error('chmod failed'));
    expect((await submit([file('first.txt')])).body.error).toBe('chmod failed');
    expect(spawn).not.toHaveBeenCalled();
    await expectClean();
  });

  it('cleans after a write leaves partial content and then fails', async () => {
    const writeFile = fs.writeFile.bind(fs);
    vi.spyOn(fs, 'writeFile').mockImplementation(async (...args: Parameters<typeof fs.writeFile>) => {
      if (String(args[0]).endsWith('/second.txt')) {
        await writeFile(args[0], 'partial');
        throw new Error('SANDBOX_TEST_WRITE_FAILED');
      }
      return writeFile(...args);
    });
    const result = await submit([file('first.txt'), file('second.txt')]);
    expect(result.body.error).toBe('SANDBOX_TEST_WRITE_FAILED');
    expect(spawn).not.toHaveBeenCalled();
    await expectClean();
  });

  it('never removes an existing job directory when initial mkdir fails', async () => {
    const mkdir = fs.mkdir.bind(fs);
    vi.spyOn(fs, 'mkdir').mockImplementation(async (...args: Parameters<typeof fs.mkdir>) => {
      if (args[1] && typeof args[1] === 'object' && args[1].recursive === false) {
        await mkdir(args[0]);
        await fs.writeFile(path.join(String(args[0]), 'keep.txt'), 'existing');
      }
      return mkdir(...args);
    });
    const result = await submit([file('first.txt')]);
    expect(result.body.error).toContain('EEXIST');
    const workspace = path.join(root, result.body.jobId);
    expect(await fs.readFile(path.join(workspace, 'keep.txt'), 'utf8')).toBe('existing');
    await fs.rm(workspace, { recursive: true });
  });

  it.each([false, true])('logs cleanup failure without replacing the primary outcome (prepared=%s)', async (prepared) => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const remove = fs.rm.bind(fs);
    const rm = vi.spyOn(fs, 'rm').mockRejectedValueOnce(new Error('private filesystem detail'));
    vi.mocked(spawn).mockImplementation(() => { throw new Error('SANDBOX_TEST_RUN_FAILED'); });
    // Execution failure exercises the existing outer finally after successful preparation.
    const result = prepared
      ? await submit([file('first.txt')])
      : await submit([file('first.txt'), { path: 'bad', contentBase64: '!' }]);
    await vi.waitFor(() => expect(log).toHaveBeenCalledWith(
      '[SandboxController] workspace cleanup failed', { jobId: result.body.jobId },
    ));
    expect(JSON.stringify(log.mock.calls)).not.toContain('private filesystem detail');
    expect(result.status).toBe(400);
    expect(result.body.error).toContain(prepared ? 'SANDBOX_TEST_RUN_FAILED' : 'SANDBOX_FILE_CONTENT_INVALID');
    expect(await fs.readFile(path.join(root, result.body.jobId, 'first.txt'), 'utf8')).toBe('ok');
    rm.mockRestore();
    await remove(path.join(root, result.body.jobId), { recursive: true, force: true });
  });

  it('rejects unsigned and excessive-file requests without creating a workspace', async () => {
    expect((await submit([file('first.txt')], false)).status).toBe(401);
    expect((await submit(Array.from({ length: 129 }, () => file('x')))).body.error).toBe('SANDBOX_FILES_INVALID');
    expect(spawn).not.toHaveBeenCalled();
  });

  it('keeps concurrent live workspaces and cleans each successful job independently', async () => {
    vi.mocked(spawn).mockImplementation(() => {
      const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() });
      children.push(child);
      return child as unknown as ReturnType<typeof spawn>;
    });
    const first = submit([file('main.mjs')]);
    await vi.waitFor(() => expect(children).toHaveLength(1));
    const args = vi.mocked(spawn).mock.calls[0][1] as string[];
    const workspace = args.find((arg) => arg.startsWith('type=bind,'))!.split('src=')[1].split(',')[0];
    const second = submit([file('main.mjs')]);
    await vi.waitFor(() => expect(children).toHaveLength(2));
    const failed = await submit([file('first.txt'), { path: 'bad', contentBase64: '!' }]);
    expect(failed.body.error).toBe('SANDBOX_FILE_CONTENT_INVALID');
    expect(await fs.readFile(path.join(workspace, 'main.mjs'), 'utf8')).toBe('ok');
    children[1].emit('close', 0, null);
    expect((await second).status).toBe(200);
    expect(await fs.readFile(path.join(workspace, 'main.mjs'), 'utf8')).toBe('ok');
    children[0].emit('close', 0, null);
    expect((await first).status).toBe(200);
    await expectClean();
  });
});
