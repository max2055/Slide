import { readFileSync } from 'node:fs';
import ts from 'typescript';
import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import { capabilityService } from '../../src/resources/capability-service.js';

// server.ts starts workers on import; execute its production capability registrations verbatim.
const source = readFileSync(new URL('../../server.ts', import.meta.url), 'utf8');
const start = source.indexOf("  fastify.get('/api/resources/:type/:id/capabilities/:key'");
const end = source.indexOf("  fastify.get('/api/resources/:type/:id/observations/:metricId'", start);
if (start < 0 || end < 0) throw new Error('Capability route registration not found');
const registration = ts.transpileModule(source.slice(start, end), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;
export function registerCapabilityRoutes(fastify: FastifyInstance, verifyToken: preHandlerHookHandler) {
  new Function('fastify', 'verifyToken', 'capabilityService', registration)(fastify, verifyToken, capabilityService);
}
