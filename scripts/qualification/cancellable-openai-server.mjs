import http from 'node:http';

const port = Number(process.env.QUALIFICATION_CANCELLABLE_LLM_PORT || 28900);
const attempts = new Map();
const BODY_LIMIT = 2_000_000;

function finish(response, status) {
  try {
    if (response.writableEnded || response.destroyed) return;
    if (response.headersSent) {
      response.destroy();
      return;
    }
    response.writeHead(status).end();
  } catch {
    response.destroy();
  }
}

function messagesFrom(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const messages = payload.messages ?? [];
  if (!Array.isArray(messages)) return null;
  for (const message of messages) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) return null;
    if (typeof message.role !== 'string') return null;
    if (message.content != null && typeof message.content !== 'string') return null;
  }
  return messages;
}

async function readBody(request) {
  let body = '';
  try {
    for await (const chunk of request) {
      body += chunk;
      if (body.length > BODY_LIMIT) return { tooLarge: true };
    }
  } catch {
    return { failed: true };
  }
  return { body };
}

async function handle(request, response) {
  if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
    finish(response, 404);
    return;
  }
  const read = await readBody(request);
  if (read.failed) {
    finish(response, 400);
    return;
  }
  if (read.tooLarge) {
    finish(response, 413);
    return;
  }
  let payload;
  try {
    payload = JSON.parse(read.body);
  } catch {
    finish(response, 400);
    return;
  }
  const messages = messagesFrom(payload);
  if (!messages) {
    finish(response, 400);
    return;
  }
  const scenarioMessage = messages.find(m => m.role === 'user' && /runtime-qualification:(recovery|length|reject):/.test(m.content ?? ''));
  if (scenarioMessage) {
    const key = scenarioMessage.content;
    const attempt = (attempts.get(key) ?? 0) + 1;
    attempts.set(key, attempt);
    if (attempts.size > 100) attempts.delete(attempts.keys().next().value);
    const scenario = key.match(/runtime-qualification:(recovery|length|reject):/)[1];
    const content = scenario === 'reject' || (scenario === 'recovery' && attempt === 1)
      ? '正在分析数据库状态……\n'.repeat(20)
      : scenario === 'length' ? (attempt === 1 ? '第一段。' : '第二段。') : '安全结论：数据库连接正常。';
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    response.write(`data: ${JSON.stringify({ id: 'runtime-controlled', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ id: 'runtime-controlled', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: scenario === 'length' && attempt === 1 ? 'length' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 50 } })}\n\n`);
    response.end('data: [DONE]\n\n');
    return;
  }
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  const writeChunk = () => {
    if (response.writableEnded || response.destroyed) return;
    response.write(`data: ${JSON.stringify({
      id: 'qualification-cancellable',
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: { content: 'working ' }, finish_reason: null }],
    })}\n\n`);
  };
  writeChunk();
  const interval = setInterval(writeChunk, 250);
  const stop = () => clearInterval(interval);
  response.on('close', stop);
  response.on('error', stop);
}

const server = http.createServer((request, response) => {
  request.on('error', () => {});
  handle(request, response).catch(() => finish(response, 400));
});

server.listen(port, '127.0.0.1', () => console.log(`qualification cancellable LLM listening on ${port}`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
