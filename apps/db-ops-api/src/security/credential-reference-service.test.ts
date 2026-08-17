import { describe, expect, it } from 'vitest';
import { CredentialReferenceService } from './credential-reference-service.js';

describe('Agent credential references', () => {
  it('atomically consumes an actor/tool-bound credential once', async () => {
    let available = true;
    const executor = {
      execute: async (sql: string) => {
        if (sql.includes('SELECT secret_encrypted')) {
          return [[{ secret_encrypted: 'encrypted-secret' }]];
        }
        if (sql.includes("SET status = 'consumed'")) {
          const affectedRows = available ? 1 : 0;
          available = false;
          return [{ affectedRows }];
        }
        throw new Error('unexpected SQL');
      },
    };
    const service = new CredentialReferenceService(
      () => executor as any,
      (value) => value.replace('encrypted-', ''),
      (value) => `encrypted-${value}`,
    );

    await expect(service.consume('ref-1', 7, 'slide_add_database')).resolves.toBe('secret');
    await expect(service.consume('ref-1', 7, 'slide_add_database')).resolves.toBeNull();
  });
});
