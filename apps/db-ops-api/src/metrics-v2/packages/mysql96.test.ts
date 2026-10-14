import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { createConfigurationRegistry } from '../config/registry.js';
import { resolvePolicy } from '../policy/resolver.js';
import { resource, binding, at } from '../policy/test-support.js';
import { runPackage } from './runner.js';
import { builtinReleases } from './builtins.js';

it('retains the bytes and digests of every previously distributed builtin', () => {
  const frozen = JSON.parse(readFileSync(new URL('../../../../../docs/slide/metrics-v2/packages/builtins.json', import.meta.url), 'utf8'));
  for (const release of frozen) expect(builtinReleases().find(r => r.package.id === release.package.id && r.package.version === release.package.version)).toEqual(release);
});
it.each(['5.7.44', '8.0.40', '8.4.2'])('keeps old MySQL %s applicability', async version => {
  const target = resource(); target.attributes['db.version'].value = version;
  expect(resolvePolicy(createConfigurationRegistry(), binding(), null, target, [], at).metric_templates.every(t => t.capability.status !== 'unsupported')).toBe(true);
});
it('reports current version and allowed families in preview without changing unsupported into success', () => {
  const target = resource(); target.attributes['db.version'].value = '9.6.0';
  const result = resolvePolicy(createConfigurationRegistry(), binding(), null, target, [], at);
  expect(result).toMatchObject({ applicability: expect.arrayContaining([{ attribute: 'db.version', value: '9.6.0', supported_values: ['5.7', '8.0', '8.4'], status: 'unsupported' }]) });
  expect(result.metric_templates.every(t => t.decision === 'unsupported')).toBe(true);
});
it.each(['9.6.0', '9.7.0', 'unknown'])('new uptime-only package bounds %s without invented counter evidence', async version => {
  const registry = createConfigurationRegistry();
  const release = registry.list().find(r => r.package.id === 'mysql-basic' && r.package.version === '2.0.0');
  expect(release).toBeDefined(); if (!release) return;
  expect(release.package.collectors.flatMap(c => c.mappings.map(m => m.metric.id))).toEqual(['db.uptime_seconds']);
  expect(release.derived).toEqual([]);
  const target = resource(); target.attributes['db.version'].value = version;
  const query = vi.fn(async () => [[{ Variable_name: 'Queries', Value: '9007199254740993' }, { Variable_name: 'Uptime', Value: '1000' }], []] as [unknown, unknown]);
  const result = await runPackage(registry, { package: release.package, credential_ref: 'credential:target', overrides: {} }, {
    resource: target, binding_id: 'instance:1', attempt_id: 'trial:1', config_revision: 1, observed_at: at, clock: () => at, evidence: {},
    resolve: async () => ({ method: 'sql', pool: { query } }),
  });
  expect(result.decision).toBe(version === '9.6.0' ? 'attempted' : 'unsupported');
  if (version === '9.6.0') {
    expect(result.attempts[0].status).toBe('succeeded');
    expect(result.observations.map(o => o.observation.value)).toEqual([{ encoding: 'float64', value: 1000 }]);
    expect(result.observations[0].observation.accuracy).toBe('exact');
  } else expect(query).not.toHaveBeenCalled();
});
