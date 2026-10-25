import { afterEach, describe, expect, it, vi } from 'vitest';
import { encryptData } from '../db-connection.js';
import { llmService } from '../llm-service.js';
import { checkProviderConnections } from './provider-config-backup-service.js';
import {
  PROVIDER_CONFIG_BACKUP_FORMAT,
  PROVIDER_CONFIG_BACKUP_VERSION,
  ProviderConfigBackupError,
  assertNoSecrets,
  backupChecksum,
  buildBackupDocument,
  buildRestorePlan,
  findSecretLeaks,
  parseBackupArtifact,
  sanitizeBaseUrl,
  serializeBackupDocument,
  verifyRestoredConfiguration,
  type ProviderConfigRecord,
} from './provider-config-backup.js';

const ciphertext = 'v2:0123456789ab:0123456789abcdef01234567:0123456789abcdef0123456789abcdef:0011223344556677';
const now = new Date('2026-10-25T08:00:00.000Z');

function record(overrides: Partial<ProviderConfigRecord> = {}): ProviderConfigRecord {
  return {
    id: 5,
    name: 'deepseek',
    display_name: '深度求索',
    deployment_type: 'api',
    api_format: 'openai-completions',
    api_key_encrypted: ciphertext,
    api_base_url: 'https://api.deepseek.com/v1',
    default_model: 'deepseek-chat',
    models_supported: [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }],
    context_window: 128000,
    supports_function_call: true,
    supports_vision: false,
    input_cost_per_1k: 0.001,
    output_cost_per_1k: 0.002,
    enabled: true,
    is_default: true,
    temperature: 0.7,
    max_tokens: 2048,
    timeout_ms: 30000,
    rate_limit_per_minute: 60,
    daily_quota: null,
    daily_quota_alert_threshold: 80,
    ...overrides,
  };
}

function documentFor(providers: ProviderConfigRecord[], bindings: Array<{ scene: 'chat' | 'sql_analysis' | 'fault_diagnosis' | 'health_check'; provider_id: number; model: string }> = []) {
  return buildBackupDocument(providers, bindings, { database: 'db_ops_ai', now });
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return error instanceof ProviderConfigBackupError ? error.code : 'UNKNOWN';
  }
  return 'NO_ERROR';
}

describe('provider configuration backup artifact', () => {
  it('keeps only a stored_auth flag and never the ciphertext or key column', () => {
    const document = documentFor([record()], [{ scene: 'chat', provider_id: 5, model: 'deepseek-chat' }]);
    const text = serializeBackupDocument(document);
    expect(document.providers[0]).toMatchObject({ name: 'deepseek', source_id: 5, stored_auth: true });
    expect(text).not.toContain(ciphertext);
    expect(text).not.toContain('api_key_encrypted');
    expect(text).not.toMatch(/"api_key"/);
    expect(document.scene_bindings).toEqual([{ scene: 'chat', provider: 'deepseek', model: 'deepseek-chat' }]);
    expect(() => assertNoSecrets(JSON.parse(text))).not.toThrow();
    expect(document.format).toBe(PROVIDER_CONFIG_BACKUP_FORMAT);
    expect(document.version).toBe(PROVIDER_CONFIG_BACKUP_VERSION);
  });

  it('strips URL userinfo and credential query parameters', () => {
    const document = documentFor([record({
      api_base_url: 'https://user:pa55@api.example.test/v1?api_key=abc123&region=cn',
    })]);
    expect(document.providers[0].api_base_url).toBe('https://api.example.test/v1?region=cn');
    expect(document.redactions).toEqual(expect.arrayContaining([
      { field: 'providers.deepseek.api_base_url', reason: 'url_userinfo' },
      { field: 'providers.deepseek.api_base_url', reason: 'url_query_credential' },
    ]));
    const text = serializeBackupDocument(document);
    expect(text).not.toContain('pa55');
    expect(text).not.toContain('abc123');
  });

  it('sanitizes unparsable URLs without dropping ordinary hosts', () => {
    expect(sanitizeBaseUrl('api.example.test:8443/v1')).toEqual({ value: 'api.example.test:8443/v1', reasons: [] });
    expect(sanitizeBaseUrl('https://user:secret@host/v1?token=abc')).toEqual({
      value: 'https://host/v1',
      reasons: ['url_userinfo', 'url_query_credential'],
    });
    expect(sanitizeBaseUrl('::::?x-api-key=abc&region=cn')).toEqual({
      value: '::::?region=cn',
      reasons: ['url_query_credential'],
    });
    expect(sanitizeBaseUrl(null)).toEqual({ value: null, reasons: [] });
  });

  it('redacts common credential query-key variants but keeps api-version', () => {
    const variants = [
      'x-api-key', 'subscription-key', 'client_secret', 'clientSecret',
      'secret_key', 'access_key', 'accessToken', 'APIKey',
    ];
    for (const key of variants) {
      const sanitized = sanitizeBaseUrl(`https://api.example.test/v1?${key}=abc123&api-version=2024-06-01`);
      expect(sanitized.value, key).toBe('https://api.example.test/v1?api-version=2024-06-01');
      expect(sanitized.reasons, key).toContain('url_query_credential');
      expect(findSecretLeaks({ [key]: 'abc123' }), key).toContainEqual({ path: `$.${key}`, rule: 'sensitive-key' });
      expect(findSecretLeaks({ url: `https://api.example.test/v1?${key}=abc123` }), key)
        .toContainEqual({ path: '$.url', rule: 'inline-credential' });
      expect(findSecretLeaks({ url: sanitized.value }), key).toEqual([]);
    }
    const versionOnly = 'https://api.example.test/v1?api-version=2024-06-01';
    expect(sanitizeBaseUrl(versionOnly)).toEqual({ value: versionOnly, reasons: [] });
    expect(findSecretLeaks({ url: versionOnly })).toEqual([]);
    expect(findSecretLeaks({ stored_auth: true, max_tokens: 2048, maxTokens: 1024, author: 'alice', api_version: '2024-06-01' })).toEqual([]);
    const encoded = 'https://api.example.test/v1?client%5Fsecret=abc123&api-version=2024-06-01';
    expect(sanitizeBaseUrl(encoded).value).toBe(versionOnly);
    expect(findSecretLeaks({ url: encoded })).toContainEqual({ path: '$.url', rule: 'inline-credential' });
  });

  it('detects secret-like keys and values without echoing them', () => {
    expect(findSecretLeaks({ api_key: 'anything' })).toContainEqual({ path: '$.api_key', rule: 'sensitive-key' });
    expect(findSecretLeaks({ note: 'sk-abcdefghijklmnopqrstuvwx' })).toContainEqual({ path: '$.note', rule: 'provider-key' });
    expect(findSecretLeaks({ encrypted: ciphertext })).toContainEqual({ path: '$.encrypted', rule: 'encrypted-v2' });
    expect(findSecretLeaks({ url: 'https://root:pa55@db.example.test' })).toContainEqual({ path: '$.url', rule: 'url-userinfo' });
    expect(findSecretLeaks({ jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.signaturevalue' }))
      .toContainEqual({ path: '$.jwt', rule: 'jwt' });
    let message = '';
    try {
      assertNoSecrets({ note: 'sk-abcdefghijklmnopqrstuvwx' });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('$.note:provider-key');
    expect(message).not.toContain('abcdefghijklmnop');
  });

  it('round-trips and rejects tampered, unsupported or duplicate artifacts', () => {
    const text = serializeBackupDocument(documentFor([record()], [{ scene: 'chat', provider_id: 5, model: 'deepseek-chat' }]));
    expect(parseBackupArtifact(text)).toEqual(JSON.parse(text));

    const tampered = JSON.parse(text);
    tampered.providers[0].api_key_encrypted = 'opaque-ciphertext';
    expect(codeOf(() => parseBackupArtifact(JSON.stringify(tampered)))).toBe('PROVIDER_CONFIG_BACKUP_SECRET_DETECTED');

    const unsupported = { ...JSON.parse(text), version: 2 };
    expect(codeOf(() => parseBackupArtifact(JSON.stringify(unsupported)))).toBe('PROVIDER_CONFIG_BACKUP_UNSUPPORTED');

    const parsed = JSON.parse(text);
    const duplicate = { ...parsed, providers: [parsed.providers[0], parsed.providers[0]] };
    expect(() => parseBackupArtifact(JSON.stringify(duplicate))).toThrow(/duplicate provider/);

    const invalidScene = { ...parsed, scene_bindings: [{ scene: 'unknown', provider: 'deepseek', model: 'deepseek-chat' }] };
    expect(codeOf(() => parseBackupArtifact(JSON.stringify(invalidScene)))).toBe('PROVIDER_CONFIG_BACKUP_INVALID_ARTIFACT');

    const longModel = JSON.parse(text);
    longModel.providers[0].default_model = 'm'.repeat(101);
    expect(codeOf(() => parseBackupArtifact(JSON.stringify(longModel)))).toBe('PROVIDER_CONFIG_BACKUP_INVALID_ARTIFACT');
  });

  it('computes the documented SHA-256 checksum', () => {
    expect(backupChecksum('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('provider configuration restore plan', () => {
  it('plans creates, updates, extra-provider disabling, credentials and bindings', () => {
    const backup = documentFor([
      record({ id: 1, name: 'alpha', display_name: 'Alpha' }),
      record({ id: 2, name: 'gamma', display_name: 'Gamma', is_default: false }),
    ], [
      { scene: 'chat', provider_id: 1, model: 'deepseek-chat' },
      { scene: 'sql_analysis', provider_id: 99, model: 'gone' },
    ]);
    const current = [
      record({ id: 1, name: 'alpha', display_name: 'Old Alpha', api_key_encrypted: null }),
      record({ id: 7, name: 'extra', display_name: 'Extra', is_default: false }),
    ];
    const plan = buildRestorePlan(current, [], backup);
    expect(plan.create).toEqual(['gamma']);
    expect(plan.update).toEqual([{ name: 'alpha', changed_fields: ['display_name'] }]);
    expect(plan.unchanged).toEqual([]);
    expect(plan.disable_extra).toEqual(['extra']);
    expect(plan.credentials_required).toEqual(['alpha', 'gamma']);
    expect(plan.bindings_changed).toEqual(['chat', 'sql_analysis']);
    expect(plan.dangling_bindings).toHaveLength(1);
  });

  it('reports no provider changes for a matching configuration', () => {
    const backup = documentFor([record()]);
    const plan = buildRestorePlan([record()], [], backup);
    expect(plan.create).toEqual([]);
    expect(plan.update).toEqual([]);
    expect(plan.unchanged).toEqual(['deepseek']);
    expect(plan.credentials_required).toEqual([]);
    expect(plan.base_url_redactions).toEqual([]);
  });

  it('flags providers whose stored base URL credentials will be removed', () => {
    const providerUrl = 'https://user:pass@api.example.test/v1?x-api-key=abc&region=cn';
    const current = [
      record(),
      record({ id: 2, name: 'beta', display_name: 'Beta', is_default: false, api_base_url: providerUrl }),
    ];
    const document = documentFor(current);
    expect(document.providers.find(provider => provider.name === 'beta')?.api_base_url)
      .toBe('https://api.example.test/v1?region=cn');
    const plan = buildRestorePlan(current, [], document);
    expect(plan.base_url_redactions).toEqual(['beta']);
    expect(plan.update).toContainEqual({ name: 'beta', changed_fields: ['api_base_url'] });
    const verification = verifyRestoredConfiguration(current, [], document);
    expect(verification.issues).toContainEqual(expect.objectContaining({
      code: 'BASE_URL_CREDENTIALS_REMOVED', severity: 'warning', provider: 'beta',
    }));
  });
});

describe('provider configuration verification', () => {
  const binding = { scene: 'chat' as const, provider_id: 5, model: 'deepseek-chat' };

  it('accepts a matching restored configuration and resolves bound scenes', () => {
    const document = documentFor([record()], [binding]);
    const result = verifyRestoredConfiguration([record()], [binding], document);
    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.summary).toMatchObject({ providers_expected: 1, providers_present: 1, credentials_required: [] });
  });

  it('reports missing providers, field drift, extra enabled providers and binding drift', () => {
    const document = documentFor([record()], [binding]);
    const missing = verifyRestoredConfiguration([], [], document);
    expect(missing.ok).toBe(false);
    expect(missing.issues.map(issue => issue.code)).toEqual(expect.arrayContaining(['PROVIDER_MISSING', 'BINDING_MISMATCH']));

    const drifted = verifyRestoredConfiguration([
      record({ display_name: 'Other' }),
      record({ id: 8, name: 'extra', display_name: 'Extra' }),
    ], [{ ...binding, provider_id: 6 }], document);
    expect(drifted.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'PROVIDER_FIELD_MISMATCH', provider: 'deepseek', fields: ['display_name'] }),
      expect.objectContaining({ code: 'EXTRA_PROVIDER_ENABLED', provider: 'extra' }),
      expect.objectContaining({ code: 'BINDING_MISMATCH', scene: 'chat' }),
    ]));
    expect(drifted.summary.extra_enabled).toEqual(['extra']);
  });

  it('treats a missing key as a warning unless credentials are required', () => {
    const document = documentFor([record()], [binding]);
    const current = [record({ api_key_encrypted: null })];
    const warning = verifyRestoredConfiguration(current, [binding], document);
    expect(warning.ok).toBe(true);
    expect(warning.issues).toContainEqual(expect.objectContaining({ code: 'CREDENTIAL_REQUIRED', severity: 'warning' }));
    expect(warning.summary.credentials_required).toEqual(['deepseek']);

    const strict = verifyRestoredConfiguration(current, [binding], document, { requireCredentials: true });
    expect(strict.ok).toBe(false);
  });

  it('fails when a bound scene cannot resolve its model', () => {
    const document = documentFor([record({ supports_function_call: false })], [binding]);
    const result = verifyRestoredConfiguration([record({ supports_function_call: false })], [binding], document);
    expect(result.ok).toBe(false);
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'SCENE_UNRESOLVABLE', scene: 'chat' }));
  });

  it('preserves a dangling binding as a warning and skips its scene resolution', () => {
    const dangling = { scene: 'chat' as const, provider_id: 99, model: 'gone' };
    const document = documentFor([record()], [dangling]);
    const result = verifyRestoredConfiguration([record()], [dangling], document);
    expect(result.ok).toBe(true);
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'DANGLING_BINDING', severity: 'warning', scene: 'chat' }));
  });

  it('does not require a global default when every scene is bound explicitly', () => {
    const bindings = [
      { scene: 'chat' as const, provider_id: 5, model: 'deepseek-chat' },
      { scene: 'sql_analysis' as const, provider_id: 5, model: 'deepseek-chat' },
      { scene: 'fault_diagnosis' as const, provider_id: 5, model: 'deepseek-chat' },
      { scene: 'health_check' as const, provider_id: 5, model: 'deepseek-chat' },
    ];
    const provider = record({ is_default: false });
    const document = documentFor([provider], bindings);
    const result = verifyRestoredConfiguration([provider], bindings, document);
    expect(result.ok).toBe(true);
  });
});

describe('provider connection checks', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('checks only enabled providers for "all" and reports missing credentials for explicit names', async () => {
    vi.stubEnv('ENCRYPTION_KEY', '0123456789abcdef'.repeat(4));
    const key = encryptData('sk-test-connection');
    const base = {
      display_name: 'Provider', api_format: 'openai-completions', api_base_url: 'https://api.example.test/v1',
      default_model: 'm', models_supported: [{ id: 'm' }], context_window: 128000,
      supports_function_call: true, supports_vision: false, max_tokens: 2048,
    };
    const rows = [
      { ...base, name: 'alpha', deployment_type: 'api', api_key_encrypted: key, enabled: 1 },
      { ...base, name: 'local-disabled', deployment_type: 'local', api_key_encrypted: null, enabled: 0 },
      { ...base, name: 'no-key', deployment_type: 'api', api_key_encrypted: null, enabled: 1 },
    ];
    const pool = { query: vi.fn().mockResolvedValue([rows]) } as any;
    const test = vi.spyOn(llmService, 'testConnectionWithConfig').mockResolvedValue({ success: true, model: 'm' });
    const all = await checkProviderConnections(pool, 'all');
    expect(all).toEqual([
      expect.objectContaining({ provider: 'alpha', checked: true, success: true }),
      expect.objectContaining({ provider: 'no-key', checked: false, skipped: true, error: 'CREDENTIAL_NOT_CONFIGURED' }),
    ]);
    expect(test).toHaveBeenCalledTimes(1);

    const explicit = await checkProviderConnections(pool, ['no-key']);
    expect(explicit).toEqual([{ provider: 'no-key', checked: false, success: false, error: 'CREDENTIAL_NOT_CONFIGURED' }]);
    const missing = await checkProviderConnections(pool, ['absent']);
    expect(missing).toEqual([{ provider: 'absent', checked: false, success: false, error: 'PROVIDER_NOT_FOUND' }]);
  });
});
