import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { createConfigurationRegistry } from '../config/registry.js';
import { PolicyService } from '../policy/service.js';
import { MemoryPolicyStore, admin, pin, capabilities, testResources } from '../policy/test-support.js';
import { identify, sample } from '../../contracts/metrics/fixtures.js';
import { MetricObservationPageSchema } from '../../contracts/metrics/public-api.js';
import { MetricConsumerService, type ConsumerStore } from '../consumers/service.js';
import { decodeObservationCursor, encodeObservationCursor, observationCursorBinding, type ObservationKey } from './page.js';

const fixture = JSON.parse(readFileSync(new URL('../../../../../docs/slide/metrics-v2/consumers/fixtures.json', import.meta.url), 'utf8'));
const metric = { id: fixture.metric, semantic_version: '1.0.0' };
const series = { resource_type: 'instance' as const, resource_id: '1', metric, dimensions: {} };
const position: ObservationKey = { at: '2026-09-18 00:01:30.000', id: 'obs-2' };

describe('opaque observation cursor', () => {
  it('round-trips the keyset position and never exposes a readable offset', () => {
    const binding = observationCursorBinding(series, fixture.window.from, fixture.window.to);
    const cursor = encodeObservationCursor(position, binding);
    expect(cursor).not.toContain(position.id);
    expect(cursor).not.toContain('offset');
    expect(decodeObservationCursor(cursor, binding)).toEqual(position);
  });

  it('refuses a cursor minted for another resource, metric, dimensions or window', () => {
    const binding = observationCursorBinding(series, fixture.window.from, fixture.window.to);
    const cursor = encodeObservationCursor(position, binding);
    const other = [
      { ...series, resource_id: '2' },
      { ...series, metric: { ...metric, semantic_version: '2.0.0' } },
      { ...series, dimensions: { device: 'sda' } },
    ];
    for (const candidate of other) {
      expect(() => decodeObservationCursor(cursor, observationCursorBinding(candidate, fixture.window.from, fixture.window.to)))
        .toThrow('QUERY_INPUT_INVALID');
    }
    expect(() => decodeObservationCursor(cursor, observationCursorBinding(series, fixture.window.from, '2026-09-18T03:00:00.000Z')))
      .toThrow('QUERY_INPUT_INVALID');
  });

  it('rejects a malformed or truncated cursor', () => {
    const binding = observationCursorBinding(series, fixture.window.from, fixture.window.to);
    for (const cursor of ['', 'not-a-cursor', Buffer.from('{"a":"x"}').toString('base64url'),
      encodeObservationCursor({ at: 'yesterday', id: 'x' }, binding)]) {
      expect(() => decodeObservationCursor(cursor, binding)).toThrow('QUERY_INPUT_INVALID');
    }
  });
});

describe('formal raw observation page', () => {
  let service: MetricConsumerService, reads: number, captured: { from: string; to: string; options: { limit: number; after: ObservationKey | null } } | null;
  const request = (overrides: Record<string, unknown> = {}) => ({ resource: fixture.resource, metric, dimensions: {},
    from: fixture.window.from, to: fixture.window.to, ...overrides });

  beforeEach(async () => {
    reads = 0; captured = null;
    const registry = createConfigurationRegistry();
    const mem = new MemoryPolicyStore();
    const policies = new PolicyService(mem, registry, testResources, () => fixture.window.to);
    await policies.changeBinding(admin, fixture.resource, { expected_revision: 0, package: pin }, true);
    mem.caps.set('instance:1', capabilities());
    const observation = identify({ ...sample(fixture.metric), resource_id: '1', observed_at: fixture.observed_at,
      collected_at: fixture.observed_at, stored_at: fixture.observed_at });
    const store: ConsumerStore = {
      queryWindow: async () => [observation], inventory: async () => testResources.inventory(fixture.resource),
      dimensions: async () => [{}], attempts: async () => [],
      readObservationPage: async (_series, from, to, options) => {
        reads++; captured = { from, to, options };
        return options.after
          ? { observations: [observation], total: 2, has_more: false, next: null }
          : { observations: [observation], total: 2, has_more: true, next: position };
      },
    };
    service = new MetricConsumerService(policies, registry, store, () => fixture.window.to);
  });

  it('returns the declared page contract with id, observed_at, value, unit, quality, accuracy and sources', async () => {
    const page = await service.observations(admin, request());
    expect(() => MetricObservationPageSchema.parse(page)).not.toThrow();
    expect(page).toMatchObject({ contract_version: '1.0.0', resource: fixture.resource, metric, dimensions: {},
      window: { from: fixture.window.from, to: fixture.window.to }, order: 'observed_at,observation_id', total: 2, has_more: true });
    expect(page.observations[0]).toMatchObject({ id: expect.any(String), observed_at: fixture.observed_at,
      unit: 's', quality: { status: 'good' }, accuracy: 'exact' });
    expect(page.observations[0].sources).toHaveLength(1);
    expect(page.next_cursor).toBeDefined();
    expect(page.observations[0]).not.toHaveProperty('lineage');
  });

  it('defaults to 100 rows and passes only the decoded position to the store', async () => {
    const first = await service.observations(admin, request());
    expect(captured!.options).toEqual({ limit: 100, after: null });
    const second = await service.observations(admin, request({ cursor: first.next_cursor }));
    expect(captured!.options.after).toEqual(position);
    expect(second.has_more).toBe(false);
    expect(second.next_cursor).toBeUndefined();
  });

  it('re-authorizes every page before reading and never resumes a revoked cursor', async () => {
    const first = await service.observations(admin, request());
    const revoked = { ...admin, permissions: ['instance:view'] as string[], instanceScopes: {} };
    const before = reads;
    await expect(service.observations(revoked, request({ cursor: first.next_cursor }))).rejects.toThrow('POLICY_FORBIDDEN');
    expect(reads).toBe(before);
  });

  it('rejects an unknown metric or version, an unknown dimension, and a foreign cursor/window', async () => {
    await expect(service.observations(admin, request({ metric: { id: 'db.not_a_metric', semantic_version: '1.0.0' } })))
      .rejects.toThrow('UNKNOWN_METRIC');
    await expect(service.observations(admin, request({ metric: { id: fixture.metric, semantic_version: '2.0.0' } })))
      .rejects.toThrow('UNKNOWN_METRIC');
    await expect(service.observations(admin, request({ dimensions: { device: 'sda' } }))).rejects.toThrow('QUERY_INPUT_INVALID');
    const first = await service.observations(admin, request());
    await expect(service.observations(admin, request({ cursor: first.next_cursor, dimensions: { device: 'sda' } })))
      .rejects.toThrow('QUERY_INPUT_INVALID');
    await expect(service.observations(admin, request({ cursor: first.next_cursor,
      to: '2026-09-18T03:00:00.000Z' }))).rejects.toThrow('QUERY_INPUT_INVALID');
    expect(reads).toBe(1);
  });

  it('bounds the limit and window before any store read', async () => {
    for (const limit of [0, 1001, 1.5]) await expect(service.observations(admin, request({ limit }))).rejects.toThrow();
    await expect(service.observations(admin, request({ to: fixture.window.from }))).rejects.toThrow('QUERY_WINDOW');
    await expect(service.observations(admin, request({ to: '2026-10-25T00:00:00.000Z' }))).rejects.toThrow('QUERY_WINDOW');
    expect(reads).toBe(0);
  });
});
