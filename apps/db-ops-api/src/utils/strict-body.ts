/**
 * 严格请求体校验工具
 *
 * 用于防止前端发送的字段被后端静默忽略。
 * 当请求体包含未声明的字段时，返回明确错误而非无声丢弃。
 *
 * 用法:
 *   const check = strictBody(request.body as Record<string, unknown>,
 *     ['username', 'password', 'email'], 'POST /api/users');
 *   if (check.error) return reply.code(400).send(check.error);
 *   const { username, password, email } = check.body;
 *
 * warnUnknown: 非阻塞模式 — 只打印 warning 日志，不拒绝请求。
 *   用于透传到 service 层的端点，监控前端是否发送了多余字段。
 */

const WARNED = new Set<string>(); // deduplicate warnings

export function warnUnknown(
  body: Record<string, unknown>,
  allowedFields: string[],
  endpoint: string
): void {
  const unknown = Object.keys(body).filter(k => !allowedFields.includes(k));
  if (unknown.length > 0) {
    const key = `${endpoint}:${unknown.sort().join(',')}`;
    if (!WARNED.has(key)) {
      WARNED.add(key);
      console.warn(`[strict-body] ${endpoint} 收到未知字段: ${unknown.join(', ')}。允许的字段: ${allowedFields.join(', ')}`);
    }
  }
}

export type StrictBodyResult<T extends Record<string, unknown>> = {
  body: T;
  error: null;
} | {
  body: null;
  error: { error: string };
}

/**
 * 校验请求体只包含允许的字段。
 *
 * @param rawBody  - 原始 request.body
 * @param allowedFields - 允许的字段名列表
 * @param endpoint - 端点名称（用于错误消息）
 * @param guidance - 可选：特定字段的引导说明，如 { role: '角色分配请使用 POST /api/v1/rbac/users/{userId}/roles' }
 */
export function strictBody<T extends Record<string, unknown>>(
  rawBody: Record<string, unknown>,
  allowedFields: string[],
  endpoint: string,
  guidance?: Record<string, string>
): StrictBodyResult<T> {
  const unknown = Object.keys(rawBody).filter(k => !allowedFields.includes(k));
  if (unknown.length > 0) {
    const guidedFields = unknown.filter(k => guidance?.[k]);
    const plainFields = unknown.filter(k => !guidance?.[k]);
    const messages: string[] = [];
    if (plainFields.length > 0) {
      messages.push(`未知字段: ${plainFields.join(', ')}`);
    }
    if (guidedFields.length > 0) {
      for (const f of guidedFields) {
        messages.push(`字段 "${f}" 不被 ${endpoint} 接受。${guidance![f]}`);
      }
    }
    messages.push(`允许的字段: ${allowedFields.join(', ')}`);
    return { body: null, error: { error: messages.join('；') } };
  }
  return { body: rawBody as unknown as T, error: null };
}

/**
 * 轻量版 — 只检查并返回错误字符串，不返回 body。
 * 用于不想重构解构语句的端点。
 */
export function rejectUnknown(
  body: Record<string, unknown>,
  allowedFields: string[],
  endpoint: string,
  guidance?: Record<string, string>
): string | null {
  const result = strictBody(body, allowedFields, endpoint, guidance);
  return result.error?.error || null;
}
