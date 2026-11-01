import { describe, expect, it } from 'vitest';
import { historicalTemplatePayload as payload } from './configuration-history.fixture.js';
import { configurationHistoryRecord, readConfigurationHistory, templateHistoryPayload } from './configuration-history.js';
import { decodeBindingPayload } from '../bindings/persistence-codec.js';
const at = '2026-11-01T00:00:00.000Z';
const ref = { type: 'instance' as const, id: 1 };
const reader = (records: unknown[]) => ({ execute: async () => [records.map(payload => ({ payload })), []] }) as never;
describe('immutable historical configuration decoding', () => {
  it('revalidates the stored envelope instead of reconstructing a valid snapshot from decoded fields', () => {
    const decoded = decodeBindingPayload(payload());
    if (decoded.kind !== 'template_pending') throw new Error('fixture');
    const snapshot = templateHistoryPayload(decoded);
    expect(snapshot).toEqual(decoded.payload);
    expect(snapshot).not.toBe(decoded.payload);
    decoded.payload.envelope = 'unrecognized';
    expect(() => templateHistoryPayload(decoded)).toThrow();
  });
  it('does not promote publication and reports missing as unknown', async () => {
    const result = await readConfigurationHistory(reader([configurationHistoryRecord(payload(), 'publication', at)]), ref, 1);
    expect(result).toMatchObject({ state: 'published', settings: { interval_ms: 60000 }, evidence: [] });
    expect(await readConfigurationHistory(reader([]), ref, 1)).toMatchObject({ state: 'unknown' });
  });
  it('formal proof carries the exact sample identities without claiming a binding applied', async () => {
    const result = await readConfigurationHistory(reader([configurationHistoryRecord(payload(), 'formal_observation_commit', at, ['sample-1'])]), ref, 1);
    expect(result).toMatchObject({ state: 'effective', settings: { interval_ms: 60000 }, evidence: [{ sample_ids: ['sample-1'] }] });
  });
  it('rejects corruption, wrong scope, revision, empty formal proof and divergent settings', async () => {
    const record = configurationHistoryRecord(payload(), 'publication', at);
    for (const change of [ { target: 'instance:2' }, { revision: 2 },
      { configuration_history: { ...record.configuration_history, digest: `sha256:${'0'.repeat(64)}` } },
      { configuration_history: { ...record.configuration_history, basis: 'formal_observation_commit' } } ]) {
      await expect(readConfigurationHistory(reader([{ ...record, ...change }]), ref, 1)).rejects.toMatchObject({ code: 'CONFIGURATION_HISTORY_INVALID' });
    }
    await expect(readConfigurationHistory(reader([record, configurationHistoryRecord(payload(120000), 'publication', at)]), ref, 1))
      .rejects.toMatchObject({ code: 'CONFIGURATION_HISTORY_INVALID' });
  });
});
