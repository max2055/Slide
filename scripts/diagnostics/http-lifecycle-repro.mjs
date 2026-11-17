// Minimal real-HTTP timing diagnostic, no application database or Provider.
// This demonstrates compatibility risk; it is not a base-commit replay.
import { createRequire } from 'node:module';
const require = createRequire(new URL('../../apps/db-ops-api/package.json', import.meta.url));
const Fastify = require('fastify');
for (const count of [1, 2]) {
  const app = Fastify();
  let entered = 0;
  try {
    for (let i = 0; i < count; i++) app.addHook('preSerialization', async (_request, _reply, payload) => payload);
    app.addHook('onSend', async (_request, _reply, payload) => payload);
    app.get('/health', async (_request, reply) => { reply.send({ status: 'ok' }); });
    app.get('/anonymous', {
      preHandler: async (_request, reply) => { reply.code(401).send({ error: 'AUTH_REQUIRED' }); },
    }, async (request, reply) => {
      entered++;
      if (!request.user) return reply.code(503).send({ error: 'INTERNAL_ERROR' });
      return {};
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const url = `http://127.0.0.1:${app.server.address().port}`;
    const health = await fetch(`${url}/health`), body = await health.text();
    const anonymous = await fetch(`${url}/anonymous`); await anonymous.arrayBuffer();
    console.log(JSON.stringify({ preSerializationHooks: count, healthStatus: health.status,
      healthBytes: Buffer.byteLength(body), anonymousStatus: anonymous.status, handlerEntered: entered }));
  } finally { await app.close(); }
}
