// Opt-in test preload; never prints request data or exception properties.
import { channel } from 'node:diagnostics_channel';
const started = performance.now();
const codes = new Set(['PLATFORM_UNAVAILABLE', 'WORKFLOW_RUNTIME_UNAVAILABLE', 'TRIGGER_READ_UNAVAILABLE', 'INTERNAL_ERROR']);
function emit(value) {
  try { process.stderr.write(JSON.stringify({ event: 'test-request', ms: Math.round(performance.now() - started), ...value }) + '\n'); }
  catch { /* Observation cannot change HTTP or shutdown behavior. */ }
}
function id(request) {
  const value = request.headers['x-slide-test-request'];
  if (request.url === '/api/health') return 'startup-health';
  return typeof value === 'string' && /^(?:p10-anon-[1-4]|startup-login)$/.test(value) ? value : undefined;
}
if (process.env.SLIDE_TEST_REQUEST_EVIDENCE === '1') {
  channel('fastify.initialization').subscribe(({ fastify }) => {
    try {
      fastify.server.on('listening', () => emit({ phase: 'listening' }));
      fastify.server.prependListener('request', request => {
        if (request.url === '/api/health') emit({ phase: 'health-transport' });
      });
      const addHook = fastify.addHook;
      addHook.call(fastify, 'onRoute', route => {
        const handler = route.handler;
        route.handler = async function (request, reply) {
          if (id(request)) emit({ id: id(request), phase: 'handler-enter', status: reply.statusCode, sent: reply.sent });
          if (id(request) !== 'startup-login') return handler.call(this, request, reply);
          const { authDatabaseService: service } = await import('../../apps/db-ops-api/src/auth-database-service.ts');
          const { dbConnection } = await import('../../apps/db-ops-api/src/db-connection.ts');
          const originals = {};
          for (const name of ['getUserByUsername', 'verifyPassword']) {
            originals[name] = service[name];
            service[name] = async function (...args) {
              const result = await originals[name].apply(this, args);
              emit({ id: 'startup-login', phase: name === 'verifyPassword' ? 'password-match' : 'active-user-visible', status: Boolean(result) });
              return result;
            };
          }
          try {
            const [rows] = await dbConnection.getPool().query('SELECT DATABASE() AS db, CURRENT_USER() AS principal');
            emit({ id: 'startup-login', phase: 'database-association', status: rows[0].db === process.env.DB_NAME && rows[0].principal === process.env.DB_USER + '@%' });
            return await handler.call(this, request, reply);
          } finally {
            for (const name of Object.keys(originals)) service[name] = originals[name];
          }
        };
      });
      let ordinal = 0;
      fastify.addHook = function (name, hook) {
        if ((name === 'onRequest' || name === 'preHandler') && hook.length < 3) {
          const branch = ++ordinal, original = hook;
          hook = async function (request, reply) {
            try { return await original.call(this, request, reply); }
            finally { if (id(request)) emit({ id: id(request), phase: name, branch, status: reply.statusCode, sent: reply.sent }); }
          };
        }
        return addHook.call(this, name, hook);
      };
      addHook.call(fastify, 'onSend', async (request, reply, payload) => {
        if (id(request)) {
          let code = 'unclassified';
          try {
            const parsed = typeof payload === 'string' ? JSON.parse(payload) : null;
            if (codes.has(parsed?.error)) code = parsed.error;
            else if (reply.statusCode === 401) code = 'AUTHENTICATION_REQUIRED';
          } catch { /* Only stable whitelist fields leave this process. */ }
          emit({ id: id(request), phase: 'response', status: reply.statusCode, code });
        }
        return payload;
      });
    } catch { emit({ phase: 'observation-unavailable' }); }
  });
}
