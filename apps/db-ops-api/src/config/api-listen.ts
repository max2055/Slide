/**
 * API 进程的监听目标。
 *
 * 端口优先级与原 server.ts 一致：PORT、BACKEND_PORT、API_PORT，都为空才是 3000。
 * 绑定地址固定 0.0.0.0，不读取 HOST。通配地址探活仍用 localhost，
 * 因此默认请求保持 http://localhost:3000/api/health。
 * listen 成功后记录实际绑定，探活优先用它，避免 PORT=0 时把临时端口探成 0。
 */

export const API_BIND_HOST = '0.0.0.0';

export interface ApiProbeTarget {
  bindHost: string;
  port?: number;
  probeUrl?: string;
  error?: string;
}

interface RecordedBind {
  address: string;
  port: number;
}

let recordedBind: RecordedBind | undefined;

function selectedPortRaw(env: NodeJS.ProcessEnv): string {
  for (const value of [env.PORT, env.BACKEND_PORT, env.API_PORT]) {
    if (value) return value;
  }
  return '3000';
}

export function resolveApiListenPort(env: NodeJS.ProcessEnv = process.env): number {
  const raw = selectedPortRaw(env);
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`无效的 API 监听端口：${raw}`);
  }
  return port;
}

export function probeHostForBindAddress(address: string): string {
  if (address === '0.0.0.0' || address === '::' || address === '::0' || address === '[::]') return 'localhost';
  return address;
}

export function apiHealthProbeUrl(address: string, port: number): string {
  const host = probeHostForBindAddress(address);
  const formatted = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return `http://${formatted}:${port}/api/health`;
}

export function noteApiBoundAddress(address: string, port: number): void {
  recordedBind = { address, port };
}

export function resetRecordedApiBind(): void {
  recordedBind = undefined;
}

export function readApiProbe(env: NodeJS.ProcessEnv = process.env): ApiProbeTarget {
  if (recordedBind) {
    return {
      bindHost: recordedBind.address,
      port: recordedBind.port,
      probeUrl: apiHealthProbeUrl(recordedBind.address, recordedBind.port),
    };
  }
  try {
    const port = resolveApiListenPort(env);
    return { bindHost: API_BIND_HOST, port, probeUrl: apiHealthProbeUrl(API_BIND_HOST, port) };
  } catch (error: unknown) {
    return {
      bindHost: API_BIND_HOST,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

interface ApiListener {
  listen(options: { port: number; host: string }): Promise<unknown>;
  server: { address(): string | { address: string; port: number } | null };
}

/** server.ts 启动 HTTP 时使用。返回操作系统实际接受的端口。 */
export async function bindApiListener(server: ApiListener, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const requested = resolveApiListenPort(env);
  await server.listen({ port: requested, host: API_BIND_HOST });
  const bound = server.server.address();
  if (bound && typeof bound === 'object') {
    noteApiBoundAddress(bound.address, bound.port);
    return bound.port;
  }
  noteApiBoundAddress(API_BIND_HOST, requested);
  return requested;
}
