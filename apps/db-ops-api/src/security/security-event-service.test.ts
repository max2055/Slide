import { describe, expect, it, vi } from 'vitest';
import { SecurityEventService } from './security-event-service.js';

describe('security event service', () => {
  it('writes a typed, deduplicated event without attacker input or secrets', async () => {
    const execute = vi.fn().mockResolvedValue([{}]);
    const service = new SecurityEventService(() => ({ execute } as any));
    await service.record({
      eventType: 'approval_execution_denied',
      reasonCode: 'APPROVAL_MISMATCH',
      actorId: 7,
      resourceType: 'database-instance',
      resourceId: '2',
      requestId: 'request-1',
      occurredAt: Date.parse('2026-07-23T16:00:00Z'),
    });
    expect(execute).toHaveBeenCalledWith(expect.stringContaining('ON DUPLICATE KEY UPDATE'), [
      'approval_execution_denied', 'APPROVAL_MISMATCH', 7, 'database-instance', '2', 'request-1', expect.stringMatching(/^[0-9a-f]{64}$/),
    ]);
    expect(JSON.stringify(execute.mock.calls)).not.toContain('password');
  });
});
