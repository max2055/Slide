import http from 'node:http';

const port = Number(process.env.QUALIFICATION_CANCELLABLE_LLM_PORT || 28900);
const server = http.createServer((request, response) => {
  if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
    response.writeHead(404).end();
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
