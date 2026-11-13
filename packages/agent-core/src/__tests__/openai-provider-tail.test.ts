import { createServer } from 'node:http';
import { once } from 'node:events';
import { expect, it } from 'vitest';
import { OpenAIProvider } from '../openai-provider.js';

// #688: exercise the SDK's HTTP/SSE path, without a live model or credentials.
const prefixes = ['<', '<t', '<th', '<thi', '<thin', '<think', '<thinki', '<thinkin', '<thinking'];
const cases: { chunks: string[]; content: string | null; reasoning: string | null }[] = prefixes.map(tail => ({ chunks: ['答案 ', tail], content: '答案 ' + tail, reasoning: null as string | null }));
cases.push(
  { chunks: ['<think>未闭合 ', '<thi'], content: null, reasoning: '未闭合 <thi' },
  { chunks: ['<think> ', ' '], content: null, reasoning: '  ' },
  { chunks: ['<think>推理</think>答案'], content: '答案', reasoning: '推理' },
  { chunks: ['<thi', 'nk>推理</thi', 'nk>答案'], content: '答案', reasoning: '推理' },
  { chunks: ['前文<thi', 'nking>推理</thinking>答案'], content: '前文答案', reasoning: '推理' },
);
it.each(cases)('#688 SSE chunks $chunks preserve answer and reasoning', async ({ chunks, content, reasoning }) => {
  const server = createServer(async (req, res) => {
    for await (const _ of req) { /* drain request */ }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const text of chunks) res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: text } }] }) + '\n\n');
    res.end('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as { port: number };
  try {
    const provider = new OpenAIProvider({ apiKey: 'controlled-fixture', baseURL: `http://127.0.0.1:${address.port}/v1` });
    let answer = '', thinking = '';
    const result = await provider.chatStream([], [], {
      onContentDelta: delta => { answer += delta; },
      onThinkingDelta: delta => { thinking += delta; },
    });
    expect(result).toMatchObject({ content, reasoningContent: reasoning, finishReason: 'stop' });
    expect(answer).toBe(content ?? '');
    expect(thinking).toBe(reasoning ?? '');
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
