import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const serverSource = readFileSync(resolve(import.meta.dirname, '../../server.ts'), 'utf8');

function routeBlock(prefix: string): string {
  const start = serverSource.indexOf(prefix);
  if (start < 0) return '';
  const next = serverSource.indexOf('\n  fastify.', start + prefix.length);
  return serverSource.slice(start, next < 0 ? serverSource.length : next);
}

describe('network-device alert rule route contract', () => {
  it('passes network_device_id through when creating a target-specific rule', () => {
    expect(routeBlock("fastify.post('/api/alert-rules'"))
      .toContain('network_device_id: data.network_device_id');
  });
});
