/**
 * Shared WebSocket Protocol Types
 *
 * Extracted from gateway/protocol.ts — non-OpenClaw-specific types
 * shared across adapters. Plan 2 will migrate gateway code to use
 * these shared types directly.
 *
 * Contents:
 * - GatewayConfig — generic WS server config
 * - Request/Response types — standard RPC message envelope
 * - Protocol version constants
 * - Helper functions for creating requests/responses
 */

// ============== 协议版本 ==============

export const PROTOCOL_VERSION = 3;

// ============== Gateway 配置 ==============

export interface GatewayConfig {
  port: number;
  host?: string;
  authMode?: 'token' | 'password' | 'none';
  authToken?: string;
  maxConnections?: number;
}

// ============== Request/Response ==============

export interface Request {
  type: 'req';
  id: string;
  method: string;
  params?: Record<string, unknown>;
}

export interface ResponseError {
  code: string;
  message: string;
  details?: unknown;
}

export interface Response {
  type: 'res';
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: ResponseError;
}

// ============== Connect 握手 ==============

export interface ClientInfo {
  id: string;
  displayName?: string;
  version: string;
  platform: string;
  mode: 'control' | 'node' | 'webchat';
}

export interface ConnectParams {
  minProtocol: number;
  maxProtocol: number;
  client: ClientInfo;
  caps?: string[];
  auth?: {
    username?: string;
    password?: string;
    sessionToken?: string;
  };
}

// ============== 通用消息联合类型 ==============

export type GatewayMessage =
  | { type: 'connect'; params: ConnectParams }
  | Request
  | Response;

// ============== 辅助函数 ==============

/**
 * 创建 request 消息
 */
export function createRequest(method: string, params?: Record<string, unknown>, id?: string): Request {
  return {
    type: 'req',
    id: id ?? `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    method,
    params,
  };
}

/**
 * 创建成功 response
 */
export function createSuccessResponse(id: string, payload?: unknown): Response {
  return {
    type: 'res',
    id,
    ok: true,
    payload,
  };
}

/**
 * 创建错误 response
 */
export function createErrorResponse(id: string, code: string, message: string, details?: unknown): Response {
  return {
    type: 'res',
    id,
    ok: false,
    error: { code, message, details },
  };
}
