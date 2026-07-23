import { hasPermission } from '../auth/require-permission.js';
import { securityEventService } from './security-event-service.js';

export async function requireBrandingWrite(request: any, reply: any): Promise<unknown> {
  const user = request.user;
  const authorized = user && hasPermission(new Set(Array.isArray(user.permissions) ? user.permissions : []), 'admin:*');
  if (authorized) return;

  await securityEventService.record({
    eventType: 'branding_write_denied',
    reasonCode: user ? 'BRANDING_ADMIN_REQUIRED' : 'BRANDING_AUTH_REQUIRED',
    actorId: Number.isInteger(Number(user?.userId)) ? Number(user.userId) : undefined,
    resourceType: 'branding-config',
    resourceId: 'system-branding',
    requestId: request.id,
  }).catch(() => undefined);
  return reply.code(user ? 403 : 401).send({ error: user ? '权限不足' : '请先登录' });
}
