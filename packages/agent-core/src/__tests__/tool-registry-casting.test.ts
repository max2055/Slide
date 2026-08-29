import { describe, expect, it } from 'vitest';
import { castToolParams, ToolRegistry } from '../tool-registry.js';
import type { ToolSchema } from '../types.js';

const schema: ToolSchema['parameters'] = {
  type: 'object',
  properties: {
    port: { type: 'integer' },
    ratio: { type: 'number' },
  },
};

describe('castToolParams numeric validation', () => {
  it('does not partially parse malformed numeric strings', () => {
    const result = castToolParams({ port: '3306oops', ratio: '1.2ms' }, schema);

    expect(result).toEqual({ port: '3306oops', ratio: '1.2ms' });
  });

  it('accepts complete numeric strings', () => {
    const result = castToolParams({ port: '3306', ratio: '1.25' }, schema);

    expect(result).toEqual({ port: 3306, ratio: 1.25 });
  });

  it('preserves thrown tool exceptions for runner-level fatal error handling', async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'exploding',
      description: 'throws',
      parameters: { type: 'object', properties: {} },
      readOnly: false,
      concurrencySafe: false,
      exclusive: false,
      execute: async () => { throw new Error('infra unavailable'); },
    });

    await expect(registry.execute('exploding', {}, { preserveErrors: true })).rejects.toThrow('infra unavailable');
  });
});
