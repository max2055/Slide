import { readFileSync } from 'node:fs';
import ts from 'typescript';
import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import { requirePermission } from '../../src/auth/require-permission.js';
import { agentManagementService } from '../../src/agent-management-service.js';

// Exercise the production registration block without booting unrelated agents,
// collectors or platform migrations. Authentication is injected by the fixture.
export function registerExtensionRoutes(app: FastifyInstance, verifyToken: preHandlerHookHandler) {
  const source = readFileSync(new URL('../../server.ts', import.meta.url), 'utf8');
  const start = source.indexOf("  fastify.get('/api/agent/extensions',");
  const end = source.indexOf('  // GET /api/agent/tools', start);
  if (start < 0 || end < 0) throw new Error('Production extension route block not found');
  const { outputText } = ts.transpileModule(source.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
  new Function('fastify', 'verifyToken', 'requirePermission', 'agentManagementService', outputText)(app, verifyToken, requirePermission, agentManagementService);
}
