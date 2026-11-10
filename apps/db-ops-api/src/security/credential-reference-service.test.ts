import { describe, expect, it, vi } from 'vitest';
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

// MAX-349: validation must precede both encryption and executor acquisition.
it('rejects an oversized secret without encryption or storage', async () => {
  const executor = vi.fn();
  const encrypt = vi.fn();
  const service = new CredentialReferenceService(executor, (value) => value, encrypt);
  await expect(service.create(9, 'slide_add_database', 'x'.repeat(16_385)))
    .rejects.toThrow('CREDENTIAL_REFERENCE_INPUT_INVALID');
  expect(executor).not.toHaveBeenCalled();
  expect(encrypt).not.toHaveBeenCalled();
});
