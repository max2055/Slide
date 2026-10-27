import { describe, expect, it } from 'vitest';
import { BindingPersistenceError } from './persistence-codec.js';
import {
  readLegacyPublished, readStoredBinding, TemplateBindingUnsupportedError,
  TEMPLATE_BINDING_UNSUPPORTED, bindingReadCode, isTemplateBindingUnsupported,
} from './package-reader.js';
import { createBuiltinRegistry } from '../packages/builtins.js';
import { resolvePolicy } from '../policy/resolver.js';
import { at, binding, capabilities, resource } from '../policy/test-support.js';

const registry = createBuiltinRegistry();

function legacyPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const value = binding();
  return {
    binding: value,
    resolved: resolvePolicy(registry, value, null, resource(), capabilities(), at),
    published_at: at,
    application: { applied_revision: 1, reported_at: at, status: 'applied', error_code: null },
    ...overrides,
  };
}

function codeOf(fn: () => unknown): string {
  try { fn(); } catch (error) {
    if (error instanceof BindingPersistenceError || error instanceof TemplateBindingUnsupportedError) return error.code;
    throw error;
  }
  throw new Error('expected the reader to fail closed');
}

describe('shared package-binding reader', () => {
  it('reads a no-envelope legacy row and the explicit package-v1 carrier as the same Published value', () => {
    const payload = legacyPayload();
    const plain = readStoredBinding(payload);
    expect(plain.source).toBe('package');
    expect(plain.source === 'package' && plain.published.binding.revision).toBe(1);
    expect(readLegacyPublished(JSON.stringify(payload)).binding.package).toEqual(binding().package);

    const enveloped = readStoredBinding({ envelope: 'package-v1', ...payload });
    expect(enveloped.source).toBe('package');
    expect(enveloped.source === 'package' && enveloped.published.published_at).toBe(at);
  });

  it('fails closed on an unknown envelope, an ambiguous two-source binding and a corrupt snapshot', () => {
    expect(codeOf(() => readLegacyPublished({ envelope: 'v9', ...legacyPayload() }))).toBe('BINDING_PAYLOAD_UNKNOWN_ENVELOPE');
    expect(codeOf(() => readLegacyPublished({ ...legacyPayload(), binding: {
      ...binding(), template_pins: [{ template_id: 'tpl', version: 1, content_hash: `sha256:${'a'.repeat(64)}` }],
    } }))).toBe('BINDING_PAYLOAD_AMBIGUOUS_SOURCE');
    const corrupt = legacyPayload();
    (corrupt.resolved as { plan: unknown }).plan = {};
    expect(codeOf(() => readLegacyPublished(corrupt))).toBe('BINDING_PAYLOAD_EFFECTIVE_INVALID');
  });

  it('never echoes a payload, parameter or driver message in the stable code', () => {
    const secret = 'mysql://user:password@host/secret';
    let error: unknown;
    try { readLegacyPublished({ envelope: secret }); } catch (caught) { error = caught; }
    expect((error as Error).message).toBe('BINDING_PAYLOAD_UNKNOWN_ENVELOPE');
    expect((error as Error).message).not.toContain('password');
    expect(bindingReadCode(error)).toBe('BINDING_PAYLOAD_UNKNOWN_ENVELOPE');
    expect(isTemplateBindingUnsupported(error)).toBe(false);
    expect(TEMPLATE_BINDING_UNSUPPORTED).toBe('TEMPLATE_BINDING_UNSUPPORTED');
  });
});
