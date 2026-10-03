import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

describe('Fastify async validation security boundary', () => {
  it('preserves the schema-validated body instead of unwrapping attacker-controlled value', async () => {
    const app = Fastify();
    app.post('/operation', {
      schema: {
        body: {
          $async: true,
          type: 'object',
          required: ['operation', 'value'],
          properties: {
            operation: { type: 'string', const: 'read' },
            value: { type: 'object', additionalProperties: true },
          },
          additionalProperties: false,
        },
      },
    }, async request => request.body);

    try {
      const payload = { operation: 'read', value: { operation: 'delete' } };
      const response = await app.inject({ method: 'POST', url: '/operation', payload });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(payload);
    } finally {
      await app.close();
    }
  });
});
