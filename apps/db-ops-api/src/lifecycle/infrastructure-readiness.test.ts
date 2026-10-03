import { afterEach, expect, it, vi } from 'vitest';
import { InfrastructureReadiness } from './infrastructure-readiness.js';
import { startupConfig } from './startup-config.js';
afterEach(() => vi.useRealTimers());
it('does not accumulate probes while the dependency is blocked', async () => {
  vi.useFakeTimers();
  const check = vi.fn(() => new Promise<boolean>(() => {}));
  const readiness = new InfrastructureReadiness(() => true, check);
  const probes = Promise.all([readiness.ready(), readiness.ready()]);
  await vi.advanceTimersByTimeAsync(3_001);
  expect(await probes).toEqual([false, false]); expect(check).toHaveBeenCalledOnce();
  const retry = readiness.ready(); await vi.advanceTimersByTimeAsync(3_001);
  expect(await retry).toBe(false); expect(check).toHaveBeenCalledOnce();
});
it('checks role state again after the dependency resolves', async () => {
  let ready = true;
  const probe = new InfrastructureReadiness(() => ready, async () => { ready = false; return true; });
  expect(await probe.ready()).toBe(false);
});
it('keeps optional features disabled and logs only an allowlisted configuration summary', () => {
  expect(startupConfig({})).toEqual({ metricsV2CollectionEnabled: false, memoryPipelineEnabled: false,
    memoryWorkspaceConfigured: false, memoryRetrievalMaxCount: 5, memoryRetrievalMaxTokens: 4096 });
  const config = startupConfig({ SLIDE_MEMORY_PIPELINE_ENABLED: 'true', SLIDE_MEMORY_WORKSPACE_ID: 'private-workspace',
    SLIDE_MEMORY_RETRIEVAL_MAX_COUNT: '3', SLIDE_MEMORY_RETRIEVAL_MAX_TOKENS: '512', JWT_SECRET_KEY: 'private-secret' });
  expect(config).toMatchObject({ memoryPipelineEnabled: true, memoryWorkspaceConfigured: true, memoryRetrievalMaxCount: 3, memoryRetrievalMaxTokens: 512 });
  expect(JSON.stringify(config)).not.toContain('private');
  expect(() => startupConfig({ SLIDE_MEMORY_PIPELINE_ENABLED: 'true' })).toThrow('MEMORY_WORKSPACE_ID_REQUIRED');
  expect(() => startupConfig({ METRICS_V2_COLLECTION_ENABLED: 'invalid' })).toThrow('METRIC_COLLECTION_ENABLED_INVALID');
  expect(() => startupConfig({ SLIDE_MEMORY_RETRIEVAL_MAX_TOKENS: '32769' })).toThrow('MEMORY_RETRIEVAL_LIMITS_INVALID');
});
