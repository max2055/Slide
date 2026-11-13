import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
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
  return `account:${username || 'unknown'}`;
}

// Account budget is shared across IPs; read the body only after parsing.
export const loginRateLimitConfig = {
  hook: 'preValidation',
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

// Separate pre-parse IP budget also covers invalid JSON and missing usernames.
// createRateLimit avoids the plugin's per-request guard skipping a second limiter.
export function createLoginIpRateLimit(fastify: FastifyInstance) {
  const check = fastify.createRateLimit({ max: 30, timeWindow: '1 minute', keyGenerator: request => `ip:${request.ip}` });
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const result = await check(request);
    if (result.isAllowed === false && result.isExceeded) {
      loginRateLimitConfig.onExceeded(request);
      return reply.header('retry-after', result.ttlInSeconds).code(429).send({
        statusCode: 429, error: 'Too Many Requests', message: 'Too many login attempts',
      });
    }
  };
}

export const sensitiveOperationRateLimitConfig = {
  max: 30,
  timeWindow: '1 minute',
} as const;

export const expensiveOperationRateLimitConfig = {
  max: 10,
  timeWindow: '1 minute',
} as const;

const PUBLIC_5XX_REASON_CODES = new Set([
  'CREDENTIAL_REFERENCE_CREATE_FAILED',
  'AGENT_APPROVAL_SUBMIT_FAILED',
  'AGENT_APPROVAL_REVIEW_FAILED',
  'AGENT_APPROVAL_BATCH_REVIEW_FAILED',
  'SANDBOX_NOT_READY',
  'SANDBOX_NETWORK_NOT_READY',
  'SANDBOX_CONFIG_UPDATE_FAILED',
]);

// Backup routes already translate transport failures to fixed public codes.
// Preserve those codes, but never forward the accompanying exception details.
const PUBLIC_5XX_ERROR_CODES = new Set([
  'WORKFLOW_RUNTIME_UNAVAILABLE',
  'SSH_TARGET_DENIED',
  'SSH_CONNECT_FAILED',
  'SSH_CREDENTIAL_READ_FAILED',
  'CONFIG_BACKUP_VENDOR_UNSUPPORTED',
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

  fastify.addHook('preSerialization', async (request, reply, payload) => {
    if (reply.statusCode >= 500 && payload && typeof payload === 'object') {
      if (request.routeOptions.url === '/api/health/ready' && reply.statusCode === 503) {
        return { ready: false };
      }
      const reasonCode = (payload as { reasonCode?: unknown }).reasonCode;
      if (typeof reasonCode === 'string' && PUBLIC_5XX_REASON_CODES.has(reasonCode)) {
        return { reasonCode };
      }
      const error = (payload as { error?: unknown }).error;
      if (typeof error === 'string' && (PUBLIC_5XX_ERROR_CODES.has(error) || error.startsWith('SOURCE_'))) {
        return { error };
      }
      return { error: 'INTERNAL_ERROR' };
    }
    return payload;
  });
}
