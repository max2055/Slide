import { Client } from 'ssh2';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import sshSessionPool from '../../ssh-session-pool.js';
import { HostBlockDiscovery } from './host-counter.js';
import { collectFixed, type Transport } from '../packages/adapters.js';
import { builtinReleases, createBuiltinRegistry } from '../packages/builtins.js';
import { runPackage } from '../packages/runner.js';
import { SemanticQueryService } from '../query.js';
const port = Number(process.env.METRICS_V2_TEST_SSH_PORT), password = process.env.METRICS_V2_TEST_SSH_PASSWORD;
describe.skipIf(!port || !password)('isolated SSH kernel block lifecycle discovery', () => {
  const client = new Client(), discovery = new HostBlockDiscovery();
  const transport: Transport = { method: 'ssh', client, pool: sshSessionPool };
  beforeAll(async () => { await new Promise<void>((resolve, reject) => client.once('ready', resolve).once('error', reject)
    .connect({ host: '127.0.0.1', port, username: 'fixture', password, readyTimeout: 5000 })); });
  afterAll(() => { client.end(); });
  it('collects real diskseq/proc evidence and preserves continuity across SSH commands', async () => {
    const first = await collectFixed('builtin:linux.block.v1', transport, { host_blocks: discovery }, 5000, 100);
    const second = await collectFixed('builtin:linux.block.v1', transport, { host_blocks: discovery }, 5000, 100);
    expect(first.length).toBeGreaterThan(0);
    expect(second.map(r => r.counter)).toEqual(first.map(r => r.counter));
    const registry = createBuiltinRegistry(), release = builtinReleases().find(r => r.package.id === 'linux-host')!;
    const block = release.package.collectors.find(c => c.implementation_ref === 'builtin:linux.block.v1')!;
    const selection = { package: (({ id, version, digest }) => ({ id, version, digest }))(release.package), credential_ref: 'credential:isolated-ssh', overrides: {} };
    const run = (n: number, states?: Awaited<ReturnType<typeof runPackage>>['states']) => runPackage(registry, selection, {
      collector_ids: [block.id], resource: { type: 'server', id: '1', attributes: { 'os.family': { value: 'linux', source: 'fixture', observed_at: new Date().toISOString() } } },
      binding_id: 'server:1', attempt_id: `sample:${n}`, config_revision: 1, observed_at: new Date().toISOString(),
      evidence: { host_blocks: discovery }, resolve: async () => transport, states });
    const a = await run(1), b = await run(2, a.states);
    expect(a.attempts[0].status).toBe('succeeded'); expect(b.attempts[0].status).toBe('succeeded');
    const firstPoint = a.observations.find(o => o.observation.metric.id === 'linux.block.read_bytes_total')!.observation;
    const secondPoint = b.observations.find(o => o.observation.metric.id === firstPoint.metric.id && o.observation.dimensions.device === firstPoint.dimensions.device)!.observation;
    const definition = registry.catalog(selection.package).find(d => d.id === firstPoint.metric.id)!;
    const query = new SemanticQueryService({ queryWindow: async () => [firstPoint, secondPoint], inventory: async () => null }, async () => true);
    const buckets = await query.query({ definition, series: [firstPoint], from: firstPoint.observed_at, to: secondPoint.observed_at,
      now: new Date().toISOString(), interval_ms: 60000, stale_after_ms: 120000, max_gap_ms: 300000, mode: 'rate', space: 'none' });
    expect(buckets.some(b => b.value !== null && b.quality.status === 'good')).toBe(true);
  }, 20000);
});
