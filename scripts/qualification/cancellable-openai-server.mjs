import http from 'node:http';

const port = Number(process.env.QUALIFICATION_CANCELLABLE_LLM_PORT || 28900);
const attempts = new Map();
const server = http.createServer(async (request, response) => {
  if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
    response.writeHead(404).end();
    return;
  }
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 2_000_000) { response.writeHead(413).end(); return; }
  }
  const messages = JSON.parse(body).messages ?? [];
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
  const writeChunk = () => response.write(`data: ${JSON.stringify({
    id: 'qualification-cancellable',
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta: { content: 'working ' }, finish_reason: null }],
  })}\n\n`);
  writeChunk();
  const interval = setInterval(writeChunk, 250);
  response.on('close', () => clearInterval(interval));
});

server.listen(port, '127.0.0.1', () => console.log(`qualification cancellable LLM listening on ${port}`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
