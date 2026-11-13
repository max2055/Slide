import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { OpenAIProvider } from '../openai-provider.js';

async function collect(chunks: string[], finishReason: string | null = 'stop') {
  const provider = new OpenAIProvider({ apiKey: 'fixture' });
  (provider as any).client.chat.completions.create = async () => (async function* () {
    for (const content of chunks) yield { choices: [{ delta: { content } }] };
    if (finishReason) yield { choices: [{ delta: {}, finish_reason: finishReason }] };
  })();
  let content = '', thinking = '';
  const response = await provider.chatStream([], [], {
    onContentDelta: delta => { content += delta; },
    onThinkingDelta: delta => { thinking += delta; },
  });
  return { content, thinking, response };
}

describe('#452 embedded reasoning stream boundaries', () => {
  it('separates successive blocks through the real SDK HTTP/SSE transport', async () => {
    const server = createServer(async (req, res) => {
      for await (const _ of req) { /* drain the SDK request */ }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      for (const content of ['hello <thi', 'nk>private', '</thi', 'nk><think>second</think> answer']) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
      }
      res.end('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const address = server.address() as { port: number };
      const provider = new OpenAIProvider({ apiKey: 'fixture', baseURL: `http://127.0.0.1:${address.port}/v1` });
      let content = '', thinking = '';
      const result = await provider.chatStream([], [], {
        onContentDelta: delta => { content += delta; },
        onThinkingDelta: delta => { thinking += delta; },
      });
      expect(content).toBe('hello  answer');
      expect(thinking).toBe('privatesecond');
      expect(result).toMatchObject({ content, reasoningContent: thinking, finishReason: 'stop' });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });

  it('reproduces the reported split opening tag', async () => {
    const result = await collect(['hello <thi', 'nk>private reasoning', '</think> answer']);
    expect(result.content).toBe('hello  answer');
    expect(result.thinking).toBe('private reasoning');
  });

  for (const [open, close] of [
    ['<think>', '</think>'], ['<thinking>', '</thinking>'],
    ['< ThInK \t>', '< / ThInK \n>'], ['< thinking >', '</ thinking >'],
  ]) {
    const text = `hello ${open}private reasoning${close} answer`;
    it(`separates ${open} at every pair of chunk boundaries and character by character`, async () => {
      const assertChunks = async (chunks: string[]) => {
        const result = await collect(chunks);
        expect(result.content, JSON.stringify(chunks)).toBe('hello  answer');
        expect(result.thinking, JSON.stringify(chunks)).toBe('private reasoning');
        expect(result.response).toMatchObject({ content: result.content, reasoningContent: result.thinking, finishReason: 'stop' });
      };
      await assertChunks([text]);
      await assertChunks([...text]);
      for (let first = 1; first < text.length; first++) {
        for (let second = first + 1; second < text.length; second++) {
          await assertChunks([text.slice(0, first), text.slice(first, second), text.slice(second)]);
        }
      }
    });
  }

  it.each([
    ['<think>a</think><think>b</think> answer', ' answer', 'ab'],
    ['hello<think>a</think> <thinking>b</thinking> end', 'hello  end', 'ab'],
    ['<think></think> <think> </think> ', '  ', ' '],
    ['a < b <<threshold> c', 'a < b <<threshold> c', ''],
    ['answer <thi', 'answer <thi', ''],
    ['answer < think ', 'answer < think ', ''],
    ['<think>unfinished </thi', '', 'unfinished </thi'],
    ['<think>  ', '', '  '],
  ])('preserves text and stream tails: %s', async (text, content, thinking) => {
    for (const chunks of [[text], [...text]]) {
      for (const finish of ['stop', 'length', null]) {
        const result = await collect(chunks, finish);
        expect(result.content).toBe(content);
        expect(result.thinking).toBe(thinking);
        expect(result.response).toMatchObject({ content: content || null, reasoningContent: thinking || null,
          finishReason: finish ?? 'error', ...(finish ? {} : { errorCode: 'INCOMPLETE_STREAM' }) });
      }
    }
  });
});
