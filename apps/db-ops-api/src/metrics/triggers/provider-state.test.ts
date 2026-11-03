import { expect, it } from 'vitest';
import { continuesAfterPinRemoval, triggerProviderState } from './provider-state.js';
const metric = { id: 'mysql.processlist.count', semantic_version: '1.0.0' };
const fixture = (enabled = true, dimensions = {}) =>
  ({
    binding: { revision: 2 },
    application: { status: 'applied', applied_revision: 2 },
    pending: {
      plan: {
        settings: { enabled },
        releases: [{ steps: [{ items: [{ canonical_metric: metric, dimensions }] }] }],
      },
    },
  }) as any;
it('requires the stable semantic identity and matching fixed dimensions', () => {
  expect(triggerProviderState(fixture(), metric, {}).state).toBe('active');
  expect(triggerProviderState(fixture(true, { db: 'a' }), metric, { db: 'b' }).state).toBe('stopped');
  expect(triggerProviderState(fixture(), { ...metric, semantic_version: '2.0.0' }, {}).state).toBe('stopped');
});
it('disabled and missing providers stop evaluation without creating recovery evidence', () => {
  const binding = fixture(false);
  const before = JSON.stringify(binding);
  expect(triggerProviderState(binding, metric, {})).toEqual({
    state: 'stopped',
    reason: 'no_enabled_provider',
  });
  expect(JSON.stringify(binding)).toBe(before);
  expect(triggerProviderState(null, metric, {}).state).toBe('unknown');
  binding.pending.plan.settings.enabled = true;
  binding.application.status = 'pending';
  expect(triggerProviderState(binding, metric, {}).state).toBe('pending');
});

it('MAX238: only unchanged rules across a strict contiguous pin removal keep their head', () => {
  const rule = { rule_id: 'same', snapshot_hash: 'same' };
  const first = { config_revision: 1, templates: [{ id: 'a' }, { id: 'b' }], rules: [rule] } as any;
  const partial = { config_revision: 2, templates: [{ id: 'a' }], rules: [rule] } as any;
  expect(continuesAfterPinRemoval(first, partial, rule as any)).toBe(true);
  expect(continuesAfterPinRemoval(null, partial, rule as any)).toBe(false);
  expect(continuesAfterPinRemoval(first, { ...partial, config_revision: 3 }, rule as any)).toBe(false);
  expect(continuesAfterPinRemoval(first, partial, { ...rule, snapshot_hash: 'changed' } as any)).toBe(false);
  expect(continuesAfterPinRemoval(first, { ...partial, templates: [{ id: 'new' }] }, rule as any)).toBe(
    false,
  );
});
