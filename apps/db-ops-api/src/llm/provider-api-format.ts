/** Formats implemented by both connection tests and regular calls. */
export const SUPPORTED_API_FORMATS = ['anthropic-messages', 'openai-completions', 'ollama'] as const;
export type SupportedApiFormat = typeof SUPPORTED_API_FORMATS[number];
export const API_FORMAT_MIGRATION_MESSAGE = 'LLM_API_FORMAT_UNSUPPORTED：此协议不受运行时支持，请迁移到服务商支持的协议及对应端点；历史值不会自动转换';

export function isSupportedApiFormat(value: string): value is SupportedApiFormat {
  return (SUPPORTED_API_FORMATS as readonly string[]).includes(value);
}
