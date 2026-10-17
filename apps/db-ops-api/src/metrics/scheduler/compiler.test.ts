import { afterEach, expect, it, vi } from 'vitest';
import { createBuiltinRegistry, builtinReleases } from '../packages/builtins.js';
import { sealRelease } from '../packages/model.js';
import { runPackage } from '../packages/runner.js';
import { resolvePolicy } from '../policy/resolver.js';
import { binding, resource, capabilities, at, pin } from '../policy/test-support.js';
import { compilePlan } from './compiler.js';

const registry = createBuiltinRegistry();
const resolved = () => resolvePolicy(registry, binding(), null, resource(), capabilities(), at);
afterEach(() => vi.useRealTimers());
it('compiles a shared query and expands the public Counter dependency', () => {
  const p = compilePlan(registry, resolved());
  expect(p.queries).toHaveLength(1); expect(p.metricKeys).toHaveLength(3);
  expect(p.requestsPerHour).toBe(60); expect(p.intervalMs).toBe(60000);
});
it('keeps stable resource jitter and does not accelerate a costly resource to another resource cadence', () => {
  const slow = binding(), fast = binding(2);
  slow.overrides = { interval_ms: { mode: 'set', value: 120000 } };
  fast.overrides = { interval_ms: { mode: 'set', value: 10000 } };
  const a = compilePlan(registry, resolvePolicy(registry, slow, null, resource(), capabilities(), at));
  const b = compilePlan(registry, resolvePolicy(registry, fast, null, resource(2), capabilities(2), at));
  expect([a.intervalMs, b.intervalMs]).toEqual([120000, 10000]);
  expect(a.jitterMs).toBe(compilePlan(registry, resolvePolicy(registry, slow, null, resource(), capabilities(), at)).jitterMs);
  expect(a.jitterMs).not.toBe(b.jitterMs); expect(a.jitterMs).toBeLessThan(10000);
});
it('rejects conflicting sources and disabled dependencies, while a disabled plan has no requests', () => {
  const r = resolved(); r.metric_templates[0].source = { kind: 'collector', collector_id: 'wrong', raw_field: 'wrong' };
  expect(() => compilePlan(registry, r)).toThrow('PLAN_SOURCE');
  const d = resolved(); d.metric_templates.find(t => t.metric.id.includes('queries'))!.enabled = false;
  expect(() => compilePlan(registry, d)).toThrow('PLAN_DEPENDENCY');
  const b = binding(); b.overrides = { enabled: 'disable' };
  expect(compilePlan(registry, resolvePolicy(registry, b, null, resource(), capabilities(), at)).requestsPerHour).toBe(0);
});
it('merges distinct outputs of the same fixed implementation into one read and isolates a missing output', async () => {
  const packages = createBuiltinRegistry(), r = builtinReleases()[0];
  r.package.version = '1.1.0';
  const c = r.package.collectors[0], mapping = c.mappings.pop()!;
  r.package.collectors.push({ ...c, id: 'second', mappings: [mapping] });
  r.documentation.push({ ...r.documentation[0], collector_id: 'second' });
  const installed = packages.install(sealRelease(r));
  const collect = vi.fn(async () => [{ dimensions: {}, fields: { Uptime: { encoding: 'float64' as const, value: 10 } } }]);
  const result = await runPackage(packages, { package: { id: installed.package.id, version: installed.package.version, digest: installed.package.digest }, credential_ref: 'credential:test', overrides: {} }, {
    resource: resource(), binding_id: 'instance:1', attempt_id: 'fixture', config_revision: 1, observed_at: at, clock: () => at,
    evidence: {}, collect, resolve: async () => ({ method: 'sql', pool: { query: async () => [[], []] } }),
  });
  expect(collect).toHaveBeenCalledTimes(1);
  expect(result.observations.some(o => o.observation.metric.id === 'db.uptime_seconds' && o.observation.value !== null)).toBe(true);
  expect(result.attempts.some(a => a.error === 'parse_error')).toBe(true);
});
it('isolates transformation failure within a single multi-output batch', async () => {
  const result = await runPackage(registry, { package: pin, credential_ref: 'credential:test', overrides: {} }, {
    resource: resource(), binding_id: 'instance:1', attempt_id: 'partial', config_revision: 1, observed_at: at, clock: () => at,
    evidence: {}, collect: async () => [{ dimensions: {}, fields: { Uptime: { encoding: 'float64', value: 10 } } }],
    resolve: async () => ({ method: 'sql', pool: { query: async () => [[], []] } }),
  });
  expect(result.attempts[0].status).toBe('partial'); expect(result.attempts[0].observation_ids).toHaveLength(1);
});
it('after cancellation during the first SSH command never starts the second command', async () => {
  vi.useFakeTimers();
  const controller = new AbortController(), r = builtinReleases()[1];
  let release!: (value: unknown[]) => void;
  const execCommands = vi.fn(() => new Promise<unknown[]>(resolve => { release = resolve; }));
  const running = runPackage(registry, { package: { id: r.package.id, version: r.package.version, digest: r.package.digest }, credential_ref: 'credential:test', overrides: {} }, {
    resource: { type: 'server', id: '1', attributes: { 'os.family': { value: 'linux', source: 'test', observed_at: at } } },
    binding_id: 'server:1', attempt_id: 'cancel', config_revision: 1, observed_at: at, clock: () => at, evidence: {}, signal: controller.signal,
    resolve: async () => ({ method: 'ssh', client: {} as never, pool: { execCommands: execCommands as never } }),
  });
  const rejected = expect(running).rejects.toThrow();
  await vi.advanceTimersByTimeAsync(0); controller.abort(new Error('cancel'));
  release([{ stdout: '10 20', stderr: '', exitCode: 0 }]);
  await rejected; expect(execCommands).toHaveBeenCalledTimes(1);
});
