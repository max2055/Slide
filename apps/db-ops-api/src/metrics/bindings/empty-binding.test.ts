import { describe, expect, it } from 'vitest';
import { ResourceBindingCandidateInputSchema, ResourceBindingCandidateSchema } from '../../contracts/metrics/templates.js';
import { resolveTemplateBinding } from './resolve.js';
import { buildTemplateCollectionPlan } from './plan.js';
import { decodeBindingPayload, encodeTemplatePendingPayload, encodeTemplateStoppedPayload } from './persistence-codec.js';
import { PackageRegistry } from '../packages/model.js';

const candidate = { resource: { type: 'instance' as const, id: 1 }, revision: 1, package: null,
  group_id: null, template_pins: [], overrides: { enabled: 'disable' } };
const templates = { getVersion: async () => { throw new Error('empty binding must not read a template'); },
  getItemVersion: async () => { throw new Error('empty binding must not read an item'); } };

describe('MAX238 explicit stopped empty binding', () => {
  it('requires an explicit disable in request and stored candidates', () => {
    for (const schema of [ResourceBindingCandidateInputSchema, ResourceBindingCandidateSchema]) {
      expect(schema.safeParse(candidate).success).toBe(true);
      for (const enabled of [undefined, 'inherit', 'enable', false]) {
        expect(schema.safeParse({ ...candidate, overrides: { enabled } }).success).toBe(false);
      }
    }
  });
  it('resolves to no collectors and round trips through the strict existing envelope', async () => {
    const result = await resolveTemplateBinding(candidate, {
      resource: { type: 'instance', id: '1', attributes: {} }, group: null, capabilities: [], at: '2026-11-03T00:00:00.000Z',
    }, templates as never, new PackageRegistry([], []));
    if (result.kind !== 'template_resolution') throw new Error('unexpected delegate');
    const plan = buildTemplateCollectionPlan(result);
    expect(plan.settings.enabled).toBe(false);
    expect(plan.releases).toEqual([]);
    expect(plan.executable).toBe(false);
    const payload = encodeTemplatePendingPayload({ binding: { ...candidate, revision: 2 },
      base_revision: 1, target_revision: 2, resolution_identity: plan.identity, plan,
      decided_at: '2026-11-03T00:00:00.000Z', operation_key: 'instance:1#2@stop',
      applied_revision: null, previous_resolution_identity: null, previous_effective: null,
      published_at: '2026-11-03T00:00:00.000Z' });
    expect(decodeBindingPayload(payload).kind).toBe('template_pending');
    const stopped = encodeTemplateStoppedPayload(payload);
    const decoded = decodeBindingPayload(stopped);
    expect(decoded.application).toMatchObject({ status: 'applied', applied_revision: 2 });
    if (decoded.kind !== 'template_pending') throw new Error('not template');
    expect(decoded.effective?.revision).toBe(2);
    for (const mutate of [
      (v: any) => { v.stop_commit.operation_key = 'foreign-key'; },
      (v: any) => { v.stop_commit.at = '2026-11-04T00:00:00.000Z'; },
      (v: any) => { v.binding.overrides.enabled = 'enable'; },
      (v: any) => { v.effective.revision = 1; },
    ]) {
      const altered = JSON.parse(stopped); mutate(altered);
      expect(() => decodeBindingPayload(altered)).toThrow();
    }
    const corrupted = JSON.parse(payload);
    corrupted.binding.overrides.enabled = 'enable';
    expect(() => decodeBindingPayload(corrupted)).toThrow();
  });
});
