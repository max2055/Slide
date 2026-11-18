// Test-only loopback entry. It runs inside the managed API process so the
// verifier's original Actor (and its private credential identity) reaches claim.
import Fastify from 'fastify';
import { createVerifyToken } from '../src/auth-middleware.js';
import { ActorContextService } from '../src/auth/actor-context.js';
import { loadSecurityConfig } from '../src/config/security-config.js';
import { dbConnection } from '../src/db-connection.js';
import { AgentRunService } from '../src/adapter/agent-run-service.js';

export function runtimeClaimFixture(nonce: string, env = process.env, ownerUsername = 'admin') {
  if (!/^[a-f0-9-]{36}$/.test(nonce)) throw new Error('INVALID_FIXTURE_NONCE');
  const secret = loadSecurityConfig(env).jwtSecret;
  if (!secret) throw new Error('FIXTURE_SECURITY_CONFIG_MISSING');
  const app = Fastify({ logger: false });
  const actors = new ActorContextService();
  const runs = new AgentRunService();
  const admitted = new Set<string>();
  app.post<{ Body: { sessionId: string; messageId: string; requestKey: string } }>('/claim', {
    preHandler: createVerifyToken(secret, actors),
    schema: { body: { type: 'object', additionalProperties: false, required: ['sessionId', 'messageId', 'requestKey'],
      properties: Object.fromEntries(['sessionId', 'messageId', 'requestKey'].map(k => [k, { type: 'string', minLength: 1, maxLength: 100 }])) } },
  }, async (request, reply) => {
    const actor = (request as any).user;
    const { sessionId, messageId, requestKey } = request.body;
    if (actor.username !== ownerUsername || admitted.has(sessionId)) return reply.code(403).send({ error: 'FIXTURE_SCOPE' });
    const pool = dbConnection.getPool();
    if (!pool) return reply.code(503).send({ error: 'FIXTURE_UNAVAILABLE' });
    const [rows] = await pool.query<any[]>(
      `SELECT cs.user_id FROM chat_sessions cs WHERE cs.session_id = ? AND cs.user_id = ?
       AND EXISTS (SELECT 1 FROM chat_messages cm WHERE cm.session_id = cs.session_id AND cm.role = 'user' AND cm.content LIKE ?)`,
      [sessionId, actor.userId, `runtime-qualification:recovery:${nonce}:%`]);
    if (rows.length !== 1) return reply.code(403).send({ error: 'FIXTURE_SCOPE' });
    // Lock out concurrent admissions before any asynchronous creation. Unknown
    // writes are never retried by this fixture, including after an error reply.
    if (admitted.has(sessionId)) return reply.code(403).send({ error: 'FIXTURE_SCOPE' });
    admitted.add(sessionId);
    try {
      const { run } = await runs.claim(actor.userId, sessionId, messageId, requestKey, actor);
      return { runId: run.id };
    } catch { return reply.code(403).send({ error: 'FIXTURE_CLAIM_REJECTED' }); }
  });
  return app;
}
