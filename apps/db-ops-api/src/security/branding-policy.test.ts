import { afterEach, describe, expect, it, vi } from 'vitest';
import { requireBrandingWrite } from './branding-policy.js';
import { securityEventService } from './security-event-service.js';

function replyDouble() {
  const send = vi.fn();
  const code = vi.fn(() => ({ send }));
  return { code, send };
}

describe('branding write policy', () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([
    [[], 403],
    [['instance:view'], 403],
    [['admin:*'], undefined],
    [['*'], undefined],
  ])('enforces the administrator permission boundary', async (permissions, expectedStatus) => {
    const reply = replyDouble();
    const record = vi.spyOn(securityEventService, 'record').mockResolvedValue();
    await requireBrandingWrite({ id: 'request-1', user: { userId: 7, permissions } }, reply);
    if (expectedStatus) {
      expect(reply.code).toHaveBeenCalledWith(expectedStatus);
      expect(reply.send).toHaveBeenCalledWith({ error: '权限不足' });
      expect(record).toHaveBeenCalledWith(expect.objectContaining({
        eventType: 'branding_write_denied', actorId: 7, requestId: 'request-1',
      }));
    } else {
      expect(reply.code).not.toHaveBeenCalled();
      expect(record).not.toHaveBeenCalled();
    }
  });
});
