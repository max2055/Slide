import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { securityEventService } from './security-event-service.js';

export const API_BODY_LIMIT = 1_048_576;

export function resolveCorsOrigins(env: NodeJS.ProcessEnv = process.env): string[] {
  const configured = env.CORS_ORIGINS?.split(',').map((value) => value.trim()).filter(Boolean) ?? [];
  if (configured.length > 0) return configured;
  if (env.NODE_ENV === 'production') throw new Error('CORS_ORIGINS_REQUIRED');
  return ['http://localhost:5173', 'http://127.0.0.1:5173'];
}

export function loginRateLimitKey(request: FastifyRequest): string {
  const body = request.body as { username?: unknown } | undefined;
  const username = typeof body?.username === 'string' ? body.username.trim().toLowerCase().slice(0, 128) : 'unknown';
  return `${request.ip}:${username}`;
}

export const loginRateLimitConfig = {
  max: 5,
  timeWindow: '1 minute',
  keyGenerator: loginRateLimitKey,
  onExceeded(request: FastifyRequest) {
    void securityEventService.record({
      eventType: 'login_rate_limited',
      reasonCode: 'LOGIN_RATE_LIMIT_EXCEEDED',
      resourceType: 'auth-login',
      requestId: request.id,
    }).catch(() => undefined);
  },
} as const;

export const sensitiveOperationRateLimitConfig = {
  max: 30,
  timeWindow: '1 minute',
} as const;

export const expensiveOperationRateLimitConfig = {
  max: 10,
  timeWindow: '1 minute',
} as const;

const PUBLIC_5XX_REASON_CODES = new Set([
  'SANDBOX_NOT_READY',
  'SANDBOX_NETWORK_NOT_READY',
  'SANDBOX_CONFIG_UPDATE_FAILED',
]);

// Backup routes already translate transport failures to fixed public codes.
// Preserve those codes, but never forward the accompanying exception details.
const PUBLIC_5XX_ERROR_CODES = new Set([
  'SSH_TARGET_DENIED',
  'SSH_CONNECT_FAILED',
  'SSH_COMMAND_FAILED',
  'SSH_COMMAND_TIMEOUT',
  'CONFIG_OUTPUT_LIMIT',
  'CONFIG_EMPTY',
  'CONFIG_BACKUP_STORE_UNAVAILABLE',
  'CONFIG_BACKUP_FAILED',
]);

export async function registerHttpSecurity(fastify: FastifyInstance, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  await fastify.register(cors, { origin: resolveCorsOrigins(env) });
  await fastify.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'", 'ws:', 'wss:'],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
  });
  await fastify.register(rateLimit, { global: false });

  fastify.addHook('preSerialization', async (_request, reply, payload) => {
    if (reply.statusCode >= 500 && payload && typeof payload === 'object') {
      const reasonCode = (payload as { reasonCode?: unknown }).reasonCode;
      if (typeof reasonCode === 'string' && PUBLIC_5XX_REASON_CODES.has(reasonCode)) {
        return { reasonCode };
      }
      const error = (payload as { error?: unknown }).error;
      if (typeof error === 'string' && PUBLIC_5XX_ERROR_CODES.has(error)) {
        return { error };
      }
      return { error: 'INTERNAL_ERROR' };
    }
    return payload;
  });
}
