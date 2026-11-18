import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import mysql from 'mysql2/promise';
import bcrypt from 'bcrypt';
import Fastify from 'fastify';
import { WebSocket } from 'ws';
import { ToolRegistry } from '@slide/agent-core';
import { DirectAdapter } from '../src/adapter/direct-adapter.js';
import { dbConnection } from '../src/db-connection.js';
import { MigrationRunner } from '../src/migrations/runner.js';
import { createVerifyToken } from '../src/auth-middleware.js';
import { registerChatRoutes } from '../src/chat-routes.js';
import { chatDatabaseService } from '../src/chat-database-service.js';
import { chatCredential } from '../src/auth/chat-credential.js';
import { streamingIdentity } from './streaming-auth-fixture.js';

const port = Number(process.env.STREAMING_FIXTURE_MYSQL_PORT);
test('streaming fixture real SQL/JWT/HTTP/WS identity preflight', { skip: !port, timeout: 30_000 }, async t => {
  assert.ok(port > 0 && port !== 3306);
  const schema = 'max684_stream_preflight_' + randomUUID().replaceAll('-', '');
  const config = { host: '127.0.0.1', port, user: 'root', password: '' };
  const admin = mysql.createPool(config), pool = mysql.createPool({ ...config, database: schema });
  const app = Fastify(); const sockets: WebSocket[] = [];
  const workspace = await mkdtemp(join(tmpdir(), 'max684-stream-preflight-'));
  const secret = randomBytes(32).toString('hex');
  const saved = { JWT_SECRET_KEY: process.env.JWT_SECRET_KEY, AGENT_WS_PORT: process.env.AGENT_WS_PORT, AGENT_WS_HOST: process.env.AGENT_WS_HOST };
  Object.assign(process.env, { JWT_SECRET_KEY: secret, AGENT_WS_PORT: '0', AGENT_WS_HOST: '127.0.0.1' });
  let adapter: DirectAdapter | undefined, modelCalls = 0, toolCalls = 0, httpCalls = 0;
  try {
    await admin.query('CREATE DATABASE ' + schema); await new MigrationRunner(pool).run();
    assert.equal(await dbConnection.initialize({ ...config, database: schema }), true);
    const password = randomBytes(24).toString('hex');
    for (const [id, username] of [[68491, 'stream-owner'], [68492, 'stream-no-chat']] as const) {
      await pool.query('INSERT INTO users(id,username,password_hash) VALUES(?,?,?)', [id, username, await bcrypt.hash(password, 10)]);
    }
    await pool.query("INSERT INTO roles(id,name) VALUES(68491,'stream-owner')");
    await pool.query('INSERT INTO user_roles(user_id,role_id) VALUES(68491,68491)');
    await pool.query("INSERT INTO role_permissions(role_id,permission_id) SELECT 68491,id FROM permissions WHERE code='chat:view'");
    const identity = streamingIdentity(); identity.registerLogin(app);
    await registerChatRoutes(app, { service: chatDatabaseService, verifyToken: createVerifyToken(secret, identity.actors),
      handleChatSend: async () => { httpCalls++; } });
    const url = await app.listen({ host: '127.0.0.1', port: 0 });
    const login = async (username: string) => {
      const response = await fetch(url + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) });
      assert.equal(response.status, 200); return (await response.json()).token;
    };
    const token = await login('stream-owner'), denied = await login('stream-no-chat');
    let sessionId = '';
    await t.test('legitimate login token creates an owned session with original credential identity', async () => {
      const { actor, session } = await identity.createSession(token); sessionId = session.session_id;
      assert.equal(actor.userId, 68491); assert.ok(chatCredential(actor)); assert.equal(session.user_id, actor.userId);
      assert.ok(actor.permissions.includes('chat:view'));
    });
    const count = async () => { const [rows] = await pool.query<any[]>('SELECT COUNT(*) AS n FROM chat_sessions'); return rows[0].n; };
    for (const [name, jwt] of [['missing', undefined], ['no chat grant', denied]] as const) await t.test(name + ' identity creates no session or HTTP send', async () => {
      const before = await count(); await assert.rejects(identity.createSession(jwt)); assert.equal(await count(), before);
      const response = await fetch(url + '/api/chat/send', { method: 'POST', headers: { 'content-type': 'application/json', ...(jwt ? { authorization: 'Bearer ' + jwt } : {}) }, body: JSON.stringify({ sessionKey: sessionId, message: 'controlled negative' }) });
      assert.equal(response.status, jwt ? 403 : 401); assert.equal(httpCalls, 0);
    });
    const tools = new ToolRegistry();
    tools.register({ name: 'fixture_query', description: 'counter only', parameters: {}, readOnly: true, execute: async () => { toolCalls++; return {}; } });
    const provider: any = { getDefaultModel: () => 'controlled-preflight', chat: async () => { modelCalls++; throw new Error('UNEXPECTED_MODEL_CALL'); }, chatStream: async () => { modelCalls++; throw new Error('UNEXPECTED_MODEL_CALL'); } };
    adapter = new DirectAdapter({ workspace, tools, toolsForActor: () => tools, llmProvider: provider, actorContextService: identity.actors });
    await adapter.start(); const server = (adapter as any).wsServer;
    if (!server.address()) await once(server, 'listening');
    await t.test('missing/no-chat WS admission makes zero model and tool calls', async () => {
      for (const jwt of [undefined, denied]) {
        const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}`); sockets.push(ws);
        const messages: any[] = []; ws.on('message', data => messages.push(JSON.parse(String(data))));
        await once(ws, 'open'); const closed = once(ws, 'close');
        if (jwt) {
          const authenticated = once(ws, 'message');
          ws.send(JSON.stringify({ type: 'auth', token: jwt }));
          assert.equal(JSON.parse(String((await authenticated)[0])).type, 'auth_ok');
        }
        const rejected = jwt ? Promise.race([once(ws, 'message'), closed.then(() => { throw new Error('CLOSED_BEFORE_AUTHORIZATION_REPLY'); })]) : undefined;
        ws.send(JSON.stringify({ type: 'chat.send', sessionKey: sessionId, message: 'controlled negative' }));
        if (rejected) {
          const rejection = JSON.parse(String((await rejected)[0]));
          assert.ok(['error', 'protocol.error'].includes(rejection.type)); ws.close();
        }
        const [code] = await closed;
        if (!jwt) assert.equal(code, 4002);
        assert.equal(messages.some(e => e.type === 'run.started'), false);
        assert.equal(modelCalls, 0); assert.equal(toolCalls, 0);
      }
    });
  } finally {
    for (const ws of sockets) ws.close(); await adapter?.dispose(); await app.close(); await dbConnection.close();
    await pool.end(); await admin.query('DROP DATABASE IF EXISTS ' + schema); await admin.end(); await rm(workspace, { recursive: true, force: true });
    for (const [key,value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});
