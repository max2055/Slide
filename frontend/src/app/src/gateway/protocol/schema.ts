/**
 * Simplified Gateway Protocol Schema
 */

export const PROTOCOL_VERSION = 3;

export type ConnectParams = {
  minProtocol?: number;
  maxProtocol?: number;
  client: {
    id: string;
    version: string;
    mode: string;
  };
  role: string;
  scopes: string[];
  caps?: string[];
  deviceId?: string;
  deviceIdentity?: {
    deviceId: string;
    platform?: string | null;
    deviceFamily?: string | null;
  };
  signedAtMs: number;
  token?: string;
  nonce: string;
};

export type HelloOk = {
  ok: true;
  protocol: number;
  server: string;
  version: string;
  nonce?: string;
};

export type Request = {
  type: "req";
  id: string;
  method: string;
  params?: Record<string, unknown>;
};

export type Response = {
  type: "res";
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
};

export type AgentEvent = {
  type: "event";
  event: string;
  payload?: unknown;
};

export type ChatStreamEvent = {
  type: "event";
  event: "chat.stream";
  payload: {
    sessionKey: string;
    runId: string;
    delta?: string;
    done?: boolean;
  };
};

export function isConnectMessage(msg: unknown): msg is { type: "connect"; protocol: number } {
  return (
    typeof msg === "object" &&
    msg !== null &&
    (msg as { type?: unknown }).type === "connect" &&
    typeof (msg as { protocol?: unknown }).protocol === "number"
  );
}

export function isRequestMessage(msg: unknown): msg is Request {
  return (
    typeof msg === "object" &&
    msg !== null &&
    (msg as { type?: unknown }).type === "req" &&
    typeof (msg as { id?: unknown }).id === "string" &&
    typeof (msg as { method?: unknown }).method === "string"
  );
}

export function createSuccessResponse(id: string, payload?: unknown): Response {
  return { type: "res", id, ok: true, payload };
}

export function createErrorResponse(
  id: string,
  code: string,
  message: string,
  details?: unknown,
): Response {
  return { type: "res", id, ok: false, error: { code, message, details } };
}
