import http from 'node:http';
import { once } from 'node:events';
import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SandboxClient } from './sandbox-client.js';

const secret = 'local-http-fixture'.repeat(2);
let server: http.Server;
let client: SandboxClient;
let statusCode = 200;
let responseBody = '{}';
const seen: string[] = [];

describe('MAX-480 / #377 sandbox HTTP response contract', () => {
  beforeAll(async () => {
    server = http.createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const expected = createHmac('sha256', secret)
        .update(String(request.headers['x-slide-timestamp'])).update('.')
        .update(String(request.headers['x-slide-nonce'])).update('.')
        .update(Buffer.concat(chunks)).digest('hex');
      if (request.headers['x-slide-signature'] !== expected) {
        response.writeHead(401).end();
        return;
      }
      seen.push(request.url!);
      response.writeHead(statusCode).end(responseBody);
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    client = new SandboxClient(`http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`, secret);
  });

  afterAll(async () => {
    const closed = new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    server.closeIdleConnections();
    await closed;
  });

  const methods = [
    { name: 'status', url: '/v1/status', phase: 'STATUS', call: () => client.status() },
    { name: 'execute', url: '/v1/jobs', phase: 'REQUEST', call: () => client.execute({ runtime: 'node', command: ['node', 'main.mjs'] }) },
    { name: 'post scan', url: '/v1/network-scans', phase: 'REQUEST', call: () => client.scanDatabaseEndpoints({ cidr: '10.0.0.0/24', profile: 'common_databases' }) },
  ];
  for (const method of methods) {
    it.each([
      [502, '<html>private upstream detail</html>'],
      [404, ''],
      [429, '{"error":"private upstream detail"}'],
    ])(`${method.name} preserves HTTP %s without exposing the response body`, async (code, body) => {
      statusCode = code;
      responseBody = body;
      await expect(method.call()).rejects.toEqual(new Error(`SANDBOX_${method.phase}_FAILED:${code}`));
      expect(seen.at(-1)).toBe(method.url);
    });

    it(`${method.name} rejects invalid successful JSON`, async () => {
      statusCode = 200;
      responseBody = 'private malformed body';
      await expect(method.call()).rejects.toEqual(new Error('SANDBOX_RESPONSE_INVALID'));
    });

    it(`${method.name} returns valid successful JSON`, async () => {
      statusCode = 200;
      responseBody = '{"status":"ok","jobId":"fixture-job"}';
      await expect(method.call()).resolves.toEqual({ status: 'ok', jobId: 'fixture-job' });
    });
  }
});
