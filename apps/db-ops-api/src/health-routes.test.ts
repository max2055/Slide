import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const serverSource = readFileSync(resolve(import.meta.dirname, '../server.ts'), 'utf8');

describe('health API routes', () => {
  it('protects every detailed health endpoint with config:view', () => {
    for (const route of ['overview', 'consistency', 'readiness']) {
      expect(serverSource).toMatch(new RegExp(
        `fastify\\.get\\('/api/health/${route}'[\\s\\S]{0,180}preHandler: \\[verifyToken, requirePermission\\('config:view'\\)\\]`,
      ));
    }
  });

  it('uses the shared overview snapshot and supports forced refresh', () => {
    expect(serverSource).toContain("fastify.get('/api/health/overview'");
    expect(serverSource).toContain("refresh === 'true'");
    expect(serverSource.match(/consistencyChecker\.healthOverview/g)?.length).toBeGreaterThanOrEqual(3);
  });
});
