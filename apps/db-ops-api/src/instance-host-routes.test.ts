import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Value } from '@sinclair/typebox/value';
import { describe, expect, it } from 'vitest';
import * as contracts from './contracts/public-api.js';
import { buildClientTypes, buildOpenApiDocument } from './contracts/generate-public-api.js';

const serverSource = readFileSync(resolve(import.meta.dirname, '../server.ts'), 'utf8');
const serverDatabaseSource = readFileSync(resolve(import.meta.dirname, './server-database-service.ts'), 'utf8');

function routeBlock(method: 'get' | 'put' | 'delete', path: string): string {
  const marker = `fastify.${method}('${path}'`;
  const start = serverSource.indexOf(marker);
  if (start === -1) return '';
  const next = serverSource.indexOf('\n  fastify.', start + marker.length);
  return serverSource.slice(start, next === -1 ? serverSource.length : next);
}

describe('instance-host route contract', () => {
  it('registers both relationship directions through the domain service', () => {
    expect(serverSource).toContain("from './src/resources/instance-host-service.js'");
    expect(routeBlock('get', '/api/database/instances/:id/hosts')).toContain('instanceHostService.listHosts(');
    expect(routeBlock('put', '/api/database/instances/:id/hosts')).toContain('instanceHostService.replaceHosts(');
    expect(routeBlock('delete', '/api/database/instances/:id/hosts/:serverId')).toContain('instanceHostService.unlinkHost(');
    expect(routeBlock('get', '/api/servers/:id/instances')).toContain('instanceHostService.listInstances(');
  });

  it('requires explicit instance permission while the service enforces scope and server permission', () => {
    const list = routeBlock('get', '/api/database/instances/:id/hosts');
    const replace = routeBlock('put', '/api/database/instances/:id/hosts');
    const unlink = routeBlock('delete', '/api/database/instances/:id/hosts/:serverId');
    const reverse = routeBlock('get', '/api/servers/:id/instances');

    expect(list).toContain("preHandler: [verifyToken, requirePermission('instance:view'), requireInstanceAccess('read-only')]");
    expect(replace).toContain("preHandler: [verifyToken, requirePermission('instance:manage'), requireInstanceAccess('read-write')]");
    expect(unlink).toContain("preHandler: [verifyToken, requirePermission('instance:manage'), requireInstanceAccess('read-write')]");
    expect(reverse).toContain("preHandler: [verifyToken, requirePermission('instance:view')]");
    for (const block of [list, replace, unlink, reverse]) {
      expect(block).toContain('(request as any).user');
      expect(block).toContain('instanceHostHttpError(');
    }
  });

  it('validates path identifiers and the replacement body', () => {
    for (const block of [
      routeBlock('get', '/api/database/instances/:id/hosts'),
      routeBlock('put', '/api/database/instances/:id/hosts'),
      routeBlock('delete', '/api/database/instances/:id/hosts/:serverId'),
      routeBlock('get', '/api/servers/:id/instances'),
    ]) {
      expect(block).toContain('parsePositiveRouteId(');
      expect(block).toContain("RESOURCE_REF_INVALID");
    }
    expect(routeBlock('put', '/api/database/instances/:id/hosts')).toContain('ReplaceInstanceHostsBodySchema');
  });

  it('returns enriched mappings after replacement and stable not-found errors', () => {
    const replace = routeBlock('put', '/api/database/instances/:id/hosts');
    expect(replace).toContain('await instanceHostService.replaceHosts(');
    expect(replace).toContain('await instanceHostService.listHosts(');
    expect(serverSource).toContain("case 'RESOURCE_FORBIDDEN':");
    expect(serverSource).toContain("case 'INSTANCE_NOT_FOUND':");
    expect(serverSource).toContain('statusCode: 404');
  });

  it('blocks deletion of a server with active instance links using 409', () => {
    expect(serverDatabaseSource).toContain('instanceHostService.assertServerDeletable(id)');
    const deletion = routeBlock('delete', '/api/servers/:id');
    expect(deletion).toContain("result.error === 'SERVER_HAS_INSTANCE_RELATIONS'");
    expect(deletion).toContain('reply.code(409)');
  });
});

describe('instance-host public schemas', () => {
  const exported = contracts as Record<string, any>;

  it('accepts valid mappings and rejects malformed payloads', () => {
    const schema = exported.ReplaceInstanceHostsBodySchema;
    expect(schema).toBeDefined();
    if (!schema) return;

    expect(Value.Check(schema, {
      hosts: [
        { serverId: 20, role: 'primary', notes: 'writer' },
        { serverId: 21, role: 'replica' },
      ],
    })).toBe(true);
    expect(Value.Check(schema, { hosts: [{ serverId: 0, role: 'primary' }] })).toBe(false);
    expect(Value.Check(schema, { hosts: [{ serverId: 20, role: 'writer' }] })).toBe(false);
    expect(Value.Check(schema, { hosts: 'not-an-array' })).toBe(false);
    expect(Value.Check(schema, { hosts: [], unexpected: true })).toBe(false);
  });

  it('publishes schemas, documented operations, and generated frontend types', () => {
    expect(exported.InstanceHostsResponseSchema).toBeDefined();
    expect(exported.HostedInstancesResponseSchema).toBeDefined();
    const document = buildOpenApiDocument() as any;
    expect(document.paths).toHaveProperty('/api/database/instances/{id}/hosts');
    expect(document.paths).toHaveProperty('/api/database/instances/{id}/hosts/{serverId}');
    expect(document.paths).toHaveProperty('/api/servers/{id}/instances');
    expect(buildClientTypes()).toContain('export interface InstanceHostMapping');
    expect(buildClientTypes()).toContain('export interface HostedInstance');
  });
});
