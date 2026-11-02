/** Regression at the exact MAX238 history / MAX239 applied-envelope boundary. */
import { expect, it } from 'vitest';
import { decodeBindingPayload, encodeTemplateAppliedPayload } from '../bindings/persistence-codec.js';
import { historicalTemplatePayload } from '../policy/configuration-history.fixture.js';
import { templateHistoryPayload } from '../policy/configuration-history.js';

it('preserves the strict applied envelope, formal proof and effective revision on a second collection', () => {
  const pending=decodeBindingPayload(historicalTemplatePayload());
  if(pending.kind!=='template_pending') throw Error('fixture');
  const applied=decodeBindingPayload(encodeTemplateAppliedPayload(pending,{
    sample_ids:['sample-first'],attempt_ids:['attempt-first'],at:'2026-11-01T00:00:01.000Z' }));
  if(applied.kind!=='template_pending') throw Error('fixture');
  const payload=templateHistoryPayload(applied);
  expect(payload).toEqual(applied.payload);
  expect(decodeBindingPayload(payload).application.applied_revision).toBe(1);
  expect((payload as any).formal_commit.sample_ids).toEqual(['sample-first']);
});

it('still rejects a malformed applied proof through the unchanged strict decoder', () => {
  const pending=decodeBindingPayload(historicalTemplatePayload());
  if(pending.kind!=='template_pending') throw Error('fixture');
  pending.payload.envelope='templates-applied-v1';
  expect(()=>templateHistoryPayload(pending)).toThrow();
});
