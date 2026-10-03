import type { LLMProvider } from '../llm-database-service.js';

export class CredentialDestinationError extends Error {
  constructor(message: string, readonly status = 403) { super(message); }
}

export function explicitDraftKey(value?: string): string | undefined {
  const key = value?.trim();
  // Redacted UI values never grant permission to move a stored credential.
  return key && !/[*•●…]|\.{3}|\[redacted\]/iu.test(key) ? key : undefined;
}

export function normalizeCredentialDestination(value: string): string {
  try {
    // Do not accept path rewriting disguised as URL canonicalization.
    if (!/^https?:\/\//i.test(value) || /[\\\s]/u.test(value) || /%(?:2e|2f|5c)/i.test(value)
      || /(?:^|\/)\.{1,2}(?:\/|$)/.test(value)) throw new Error();
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
    return url.origin + url.pathname.replace(/\/+$/, '');
  } catch {
    throw new CredentialDestinationError('LLM_DESTINATION_INVALID：请填写不含凭证、查询参数或路径重写的 HTTP(S) Base URL', 400);
  }
}

export function providerBaseURL(provider: Pick<LLMProvider, 'api_base_url' | 'api_format' | 'deployment_type'>): string {
  // Match SDK defaults by protocol, never infer a trusted host from a display name.
  return provider.api_base_url || (provider.deployment_type === 'local' ? 'http://localhost:11434'
    : provider.api_format === 'anthropic-messages' ? 'https://api.anthropic.com' : 'https://api.openai.com/v1');
}

export interface CredentialTestInput {
  baseURL?: string; apiKey?: string; apiFormat?: string; deploymentType?: string;
}

/** Validate metadata before the callback is allowed to decrypt a saved key. */
export async function resolveTestCredential(saved: LLMProvider | null, input: CredentialTestInput,
  readSavedKey: (name: string) => Promise<string | null>) {
  const deploymentType = (input.deploymentType?.trim() || saved?.deployment_type || 'api') as LLMProvider['deployment_type'];
  const config = {
    api_base_url: input.baseURL?.trim() || (saved ? providerBaseURL(saved) : ''),
    api_format: input.apiFormat?.trim() || saved?.api_format || (deploymentType === 'local' ? 'ollama' : 'openai-completions'),
    deployment_type: deploymentType,
  };
  const baseURL = normalizeCredentialDestination(config.api_base_url);
  if (!['openai-completions', 'anthropic-messages', 'ollama'].includes(config.api_format)
    || !['local', 'cloud', 'api'].includes(config.deployment_type)) {
    throw new CredentialDestinationError('LLM_TEST_INVALID_CONFIGURATION', 400);
  }
  const draftKey = explicitDraftKey(input.apiKey);
  if (!draftKey && saved && baseURL !== normalizeCredentialDestination(providerBaseURL(saved))) {
    throw new CredentialDestinationError('LLM_CREDENTIAL_DESTINATION_MISMATCH：请先保存供应商地址配置，或填写本次草稿 API Key');
  }
  const apiKey = draftKey || (saved ? await readSavedKey(saved.name) : null) || '';
  if (!apiKey && config.deployment_type !== 'local') throw new CredentialDestinationError('LLM_CREDENTIAL_NOT_CONFIGURED：请填写 API Key', 400);
  return { apiKey, baseURL, apiFormat: config.api_format, deploymentType: config.deployment_type };
}

/** Both SDKs accept an injected fetch; override any SDK redirect default. */
export const credentialSafeFetch: typeof fetch = (input, init) => fetch(input, { ...init, redirect: 'error' });
