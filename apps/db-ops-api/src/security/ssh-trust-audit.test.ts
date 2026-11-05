import { afterEach, expect, it, vi } from 'vitest';
import { dbConnection } from '../db-connection.js';
import { recordSshTrustRequest } from './ssh-trust-audit.js';

afterEach(() => vi.restoreAllMocks());
it('refuses compatibility without an authenticated actor or durable audit store', async () => {
  vi.spyOn(dbConnection, 'getPool').mockReturnValue(null);
  await expect(recordSshTrustRequest(1, 'server', '7', 'insecure')).rejects.toThrow('SSH_TRUST_AUDIT_UNAVAILABLE');
  const execute = vi.fn().mockResolvedValue([]);
  vi.mocked(dbConnection.getPool).mockReturnValue({ execute } as any);
  await expect(recordSshTrustRequest(0, 'server', '7', 'insecure')).rejects.toThrow('SSH_TRUST_AUDIT_UNAVAILABLE');
  expect(execute).not.toHaveBeenCalled();
  execute.mockRejectedValue(new Error('AUDIT_WRITE_FAILED'));
  await expect(recordSshTrustRequest(1, 'server', '7', 'insecure')).rejects.toThrow('AUDIT_WRITE_FAILED');
});
it('records only actor and resource metadata and leaves ordinary policy paths untouched', async () => {
  const execute = vi.fn().mockResolvedValue([]);
  vi.spyOn(dbConnection, 'getPool').mockReturnValue({ execute } as any);
  await recordSshTrustRequest(1, 'server', '7', undefined);
  await recordSshTrustRequest(1, 'server', '7', 'pinned');
  expect(execute).not.toHaveBeenCalled();
  await recordSshTrustRequest(1, 'server', '7', 'insecure');
  expect(execute).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO ssh_trust_decisions'), [1, 'server', '7', 'insecure']);
});
