// Test-only login assembly for the isolated streaming schema. Identity and
// grants are read by the production SQL/JWT services, never copied from JSON.
import { AuthDatabaseService } from '../src/auth-database-service.js';
import { ActorAuthenticationError, ActorContextService, signAccessToken } from '../src/auth/actor-context.js';
import { loadSecurityConfig } from '../src/config/security-config.js';
import { chatDatabaseService } from '../src/chat-database-service.js';

export function streamingIdentity(env = process.env) {
  const secret = loadSecurityConfig(env).jwtSecret;
  if (!secret) throw new Error('STREAMING_SECURITY_CONFIG_MISSING');
  const actors = new ActorContextService();
  const users = new AuthDatabaseService();
  return { actors, secret,
    registerLogin(app: any) {
      app.post('/api/auth/login', async (request: any, reply: any) => {
        const { username, password } = request.body ?? {};
        if (typeof username !== 'string' || typeof password !== 'string'
          || !await users.verifyPassword(username, password)) return reply.code(401).send({ error: 'INVALID_CREDENTIALS' });
        const user = await users.getUserByUsername(username);
        if (!user) return reply.code(401).send({ error: 'INVALID_CREDENTIALS' });
        const actor = await actors.loadActiveActor(user.id);
        return { token: signAccessToken(actor, secret) };
      });
    },
    async createSession(token: string | undefined) {
      if (!token) throw new ActorAuthenticationError();
      const actor = await actors.authenticateAccessToken(token, secret);
      const session = await chatDatabaseService.createSession(actor, { title: 'MAX-129 real stream' });
      return { actor, session };
    },
  };
}
