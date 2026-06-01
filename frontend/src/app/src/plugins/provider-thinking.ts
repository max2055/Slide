// Stub file for provider-thinking.ts
// Provides thinking-related configuration for different providers

export function resolveProviderBinaryThinking(params: {
  provider: string;
  context: { provider: string; modelId: string };
}): boolean | undefined {
  // Return undefined to let the caller use default behavior
  return undefined;
}

export function resolveProviderXHighThinking(params: {
  provider: string;
  context: { provider: string; modelId: string };
}): boolean | undefined {
  // Return undefined to let the caller use default behavior
  return undefined;
}

export function resolveProviderDefaultThinkingLevel(params: {
  provider: string;
  context: { provider: string; modelId: string; reasoning?: boolean };
}): string | undefined {
  // Return undefined to let the caller use default behavior
  return undefined;
}
