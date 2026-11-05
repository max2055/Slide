import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const BODY_OVER = 2_000_001;
let child;
let port;
let stderr = '';

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const chosen = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => resolve(chosen));
    });
  });
}

function post(body, { read = 'end' } = {}) {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      method: 'POST',
      path: '/v1/chat/completions',
      headers: {
        'content-type': 'application/json',
        'content-length': payload.length,
        connection: 'close',
      },
    }, (response) => {
      const chunks = [];
      if (read === 'first') {
        response.once('data', (chunk) => {
          resolve({
            status: response.statusCode,
            headers: response.headers,
            body: chunk.toString('utf8'),
            close: () => req.destroy(),
          });
        });
        return;
      }
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

before(async () => {
  port = await freePort();
  const env = { ...process.env, QUALIFICATION_CANCELLABLE_LLM_PORT: String(port) };
  delete env.NO_COLOR;
  delete env.FORCE_COLOR;
  child = spawn(process.execPath, ['scripts/qualification/cancellable-openai-server.mjs'], {
    cwd: root,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('mock did not listen')), 5000);
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
      if (output.includes(`listening on ${port}`)) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`mock exited before ready: ${code}`));
    });
  });
});

after(() => {
  if (child && child.exitCode === null) child.kill('SIGTERM');
});

test('malformed JSON, message shape, and read failures stay on this mock and the next request still streams', async () => {
  for (const body of ['{', 'not-json', '', 'null', '[]']) {
    assert.equal((await post(body)).status, 400, body);
  }
  for (const body of [
    { messages: {} },
    { messages: [null] },
    { messages: ['text'] },
    { messages: [1] },
    { messages: [{}] },
    { messages: [{ role: 1, content: 'x' }] },
    { messages: [{ role: 'user', content: 1 }] },
    { messages: [{ role: 'user', content: { text: 'x' } }] },
    { messages: [null, { role: 'user', content: 'later' }] },
  ]) {
    assert.equal((await post(body)).status, 400, JSON.stringify(body));
  }

  const truncated = await new Promise((resolve, reject) => {
    let buf = '';
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.end('POST /v1/chat/completions HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 40\r\nConnection: close\r\n\r\n{"mess');
    });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('truncated read timed out'));
    }, 3000);
    socket.on('data', (chunk) => { buf += chunk; });
    socket.on('error', (error) => { clearTimeout(timer); reject(error); });
    socket.on('close', () => { clearTimeout(timer); resolve(buf); });
  });
  assert.match(truncated, /^HTTP\/1\.1 400 /);

  await new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1', port, method: 'POST', path: '/v1/chat/completions',
      headers: { 'content-length': 100, connection: 'close' },
    });
    req.on('error', () => resolve());
    req.write('{"messages":');
    setTimeout(() => req.destroy(), 30);
    setTimeout(resolve, 150);
  });

  const recovered = await post({ messages: [{ role: 'user', content: 'hello' }] }, { read: 'first' });
  assert.equal(recovered.status, 200);
  assert.equal(recovered.headers['content-type'], 'text/event-stream');
  assert.match(recovered.body, /working /);
  recovered.close();
  assert.equal(child.exitCode, null);
  assert.equal(stderr, '');
});

test('body limit still returns 413 and a later legal request is served', async () => {
  const body = Buffer.concat([
    Buffer.from('{"messages":[{"role":"user","content":"'),
    Buffer.alloc(BODY_OVER, 0x61),
    Buffer.from('"}]}'),
  ]);
  assert.equal((await post(body)).status, 413);
  const next = await post({ messages: [{ role: 'user', content: 'after-limit' }] }, { read: 'first' });
  assert.equal(next.status, 200);
  assert.equal(next.headers['content-type'], 'text/event-stream');
  assert.match(next.body, /working /);
  next.close();
});

test('cancelling the open SSE stream leaves the mock able to stream again', async () => {
  const first = await post({ messages: [{ role: 'user', content: 'cancel-me' }] }, { read: 'first' });
  assert.equal(first.status, 200);
  assert.equal(first.headers['content-type'], 'text/event-stream');
  assert.match(first.body, /qualification-cancellable/);
  first.close();
  await new Promise((resolve) => setTimeout(resolve, 400));
  const second = await post({ messages: [{ role: 'user', content: 'after-cancel' }] }, { read: 'first' });
  assert.equal(second.status, 200);
  assert.equal(second.headers['content-type'], 'text/event-stream');
  assert.match(second.body, /working /);
  second.close();
  assert.equal(child.exitCode, null);
  assert.equal(stderr, '');
});

test('controlled qualification scenarios still complete without a real model', async () => {
  const key = 'runtime-qualification:length:max-289';
  const first = await post({ messages: [{ role: 'user', content: key }] });
  assert.equal(first.status, 200);
  assert.equal(first.headers['content-type'], 'text/event-stream');
  assert.match(first.body, /第一段。/);
  assert.match(first.body, /"finish_reason":"length"/);
  assert.match(first.body, /data: \[DONE\]/);
  const second = await post({ messages: [{ role: 'user', content: key }] });
  assert.match(second.body, /第二段。/);
  assert.match(second.body, /"finish_reason":"stop"/);
});
