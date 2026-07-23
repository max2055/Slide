import { Value } from '@sinclair/typebox/value';
import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { listAdapterCapabilities } from '../adapters/capability-matrix.js';
import { publicInstanceDto } from '../security/public-dto.js';
import { AdapterCapabilitiesResponseSchema, DatabaseInstanceSchema, DatabaseInstancesResponseSchema, HealthResponseSchema } from './public-api.js';
import { buildClientTypes, buildOpenApiDocument } from './generate-public-api.js';

describe('generated public API contract', () => {
  it('accepts actual health and adapter capability responses', () => {
    expect(Value.Check(HealthResponseSchema, { status: 'ok', timestamp: new Date().toISOString() })).toBe(true);
    expect(Value.Check(AdapterCapabilitiesResponseSchema, { adapters: listAdapterCapabilities() })).toBe(true);
  });

  it('accepts redacted instance DTOs and rejects missing credential metadata', () => {
    const dto = publicInstanceDto({
      id: 1, name: 'primary', db_type: 'mysql', host: '127.0.0.1', port: 3306,
      database_name: 'slide', health_status: 'healthy', health_score: 100, status: 'active',
      created_at: '2026-07-23T00:00:00.000Z', password_encrypted: 'ciphertext',
    });
    expect(Value.Check(DatabaseInstanceSchema, dto)).toBe(true);
    expect(Value.Check(DatabaseInstanceSchema, { ...dto, hasCredential: undefined })).toBe(false);
    expect(dto).not.toHaveProperty('password_encrypted');
  });

  it('generates deterministic documented operations and frontend types', () => {
    const document = buildOpenApiDocument() as any;
    expect(Object.keys(document.paths)).toEqual(['/api/adapters/capabilities', '/api/database/instances', '/api/health']);
    expect(buildClientTypes()).toContain('export interface DatabaseInstance');
    expect(buildClientTypes()).toBe(buildClientTypes());
  });

  it('compiles all response schemas in Fastify', async () => {
    const app = Fastify();
    app.get('/health', { schema: { response: { 200: HealthResponseSchema } } }, async () => ({ status: 'ok', timestamp: new Date().toISOString() }));
    app.get('/capabilities', { schema: { response: { 200: AdapterCapabilitiesResponseSchema } } }, async () => ({ adapters: listAdapterCapabilities() }));
    app.get('/instances', { schema: { response: { 200: DatabaseInstancesResponseSchema } } }, async () => []);
    await expect(app.ready()).resolves.toBe(app);
    await app.close();
  });
});
