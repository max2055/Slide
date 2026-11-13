import { describe, expect, it } from 'vitest';
import { resolveProviderFromBaseUrl } from './provider-catalog.js';

describe('native catalog endpoint classification (#330)', () => {
  const hosts = [
    ['api.anthropic.com', 'anthropic'], ['api.openai.com', 'openai'],
    ['dashscope.aliyuncs.com', 'bailian'], ['api.deepseek.com', 'deepseek'],
    ['api.minimax.chat', 'minimax'], ['open.bigmodel.cn', 'glm'],
  ];
  it.each(hosts)('matches only the exact host %s', (host, type) => {
    expect(resolveProviderFromBaseUrl(`https://${host.toUpperCase()}/v1`)).toBe(type);
    for (const url of [`https://${host}.evil.invalid/v1`, `https://example.invalid/${host}`,
      `https://${host}@example.invalid`, `https://example.invalid?q=${host}`,
      `not-a-url-${host}`, `ftp://${host}`]) {
      expect(resolveProviderFromBaseUrl(url), url).toBeNull();
    }
  });
  it('parses the local Ollama host and port', () => {
    for (const host of ['localhost', '127.0.0.1']) {
      expect(resolveProviderFromBaseUrl(`http://${host}:11434/api`)).toBe('ollama');
      for (const url of [`http://example.invalid/${host}:11434`, `http://${host}:11435`,
        `http://${host}:114340`]) expect(resolveProviderFromBaseUrl(url)).toBeNull();
    }
    expect(resolveProviderFromBaseUrl('http://localhost.evil.invalid:11434')).toBeNull();
  });
});
