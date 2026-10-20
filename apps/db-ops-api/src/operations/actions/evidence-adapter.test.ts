import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  ActionEvidenceAdapter,
  evaluateActionEffect,
  type VerificationDefinition,
  type HealthSample,
} from './evidence-adapter.js';
export const definition: VerificationDefinition = {
  id: 'demo-health',
  version: '1',
  serverId: 101,
  configHash: 'c'.repeat(64),
  helperHash: 'a'.repeat(64),
  unitHash: 'e'.repeat(64),
  hostFingerprint: 'synthetic-pinned-host',
  beforeSeconds: 120,
  readinessSeconds: 60,
  observationSeconds: 300,
  intervalSeconds: 10,
  maxExtraRestarts: 0,
  requireAllHealthy: true,
};
export const health = (at: string, invocationId = '2'.repeat(32)): HealthSample => ({
  at,
  serverId: 101,
  configHash: definition.configHash,
  helperHash: definition.helperHash,
  unitHash: definition.unitHash,
  hostFingerprint: definition.hostFingerprint,
  invocationId,
  active: true,
  running: true,
  mainPid: 42,
  httpStatus: 200,
  restarts: 0,
});
describe('B13 deterministic effects (synthetic)', () => {
  const slots = (length: number, inv = '2'.repeat(32)) =>
    Array.from({ length }, (_, i) => {
      const at = new Date(10_000 * i).toISOString();
      return { at, sample: health(at, inv) };
    });
  const receipt = { before: '1'.repeat(32), after: '2'.repeat(32) };
  it('requires baseline, readiness and the entire post window', () => {
    expect(
      evaluateActionEffect(slots(13, receipt.before), slots(1), slots(30), receipt).state,
    ).toBe('passed');
    expect(
      evaluateActionEffect(slots(12, receipt.before), slots(1), slots(30), receipt).state,
    ).toBe('inconclusive');
    expect(
      evaluateActionEffect(slots(13, receipt.before), slots(1), slots(29), receipt).state,
    ).toBe('inconclusive');
  });
  it.each(['health', 'invocation', 'restart'])(
    'rejects %s deterioration even after exit0',
    (mode) => {
      const after = slots(30);
      if (mode === 'health') after[12].sample.httpStatus = 503;
      if (mode === 'invocation') after[12].sample.invocationId = '3'.repeat(32);
      if (mode === 'restart') after[12].sample.restarts = 1;
      expect(evaluateActionEffect(slots(13, receipt.before), slots(1), after, receipt).state).toBe(
        'failed',
      );
    },
  );
  it('never treats missing observations as healthy', () => {
    const after = slots(30) as Array<{ at: string; sample: HealthSample | null }>;
    after[12].sample = null;
    expect(evaluateActionEffect(slots(13, receipt.before), slots(1), after, receipt)).toMatchObject(
      { state: 'inconclusive', missingSamples: 1 },
    );
  });
  it('rejects unchanged identity and readiness failure', () => {
    expect(
      evaluateActionEffect(slots(13, receipt.before), slots(1, receipt.before), slots(30), receipt)
        .state,
    ).toBe('failed');
    expect(
      evaluateActionEffect(slots(13, receipt.before), slots(1), slots(30), {
        ...receipt,
        after: receipt.before,
      }).state,
    ).toBe('failed');
  });
  it('rejects stale, duplicate and wrong-target history rather than fabricating samples', async () => {
    const end = new Date(120_000).toISOString(),
      history = slots(13, receipt.before).map((s) => s.sample);
    history.push(history[0]);
    history[1].serverId = 102;
    history[2].at = new Date(0).toISOString();
    const adapter = new ActionEvidenceAdapter(definition, {
      history: async () => history,
      sample: async () => null,
    });
    const before = await adapter.before(end);
    expect(before.filter((s) => s.sample === null).length).toBeGreaterThanOrEqual(3);
    expect((await adapter.sample(end)).sample).toBeNull();
  });
  it('consumes the existing P10 byte-pinned verifier without rewriting its original definition', () => {
    const bytes = readFileSync(
      new URL('../source-package/definitions/verifier.json', import.meta.url),
    );
    const d = JSON.parse(bytes.toString());
    const registered = { ...definition, id: d.id, version: d.version, serverId: 3 };
    const adapter = new ActionEvidenceAdapter(
      registered,
      { history: async () => [], sample: async () => null },
      bytes,
    );
    expect(adapter.definitionHash).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(
      () =>
        new ActionEvidenceAdapter(
          { ...registered, observationSeconds: 301 } as any,
          { history: async () => [], sample: async () => null },
          bytes,
        ),
    ).toThrow('OPERATIONS_PRECONDITION_FAILED');
  });
  it('a hung health read times out as missing without retrying the source', async () => {
    let reads = 0;
    const adapter = new ActionEvidenceAdapter(definition, {
      history: async () => [],
      sample: () => {
        reads++;
        return new Promise(() => {});
      },
    });
    expect((await adapter.sample(new Date().toISOString())).sample).toBeNull();
    expect(reads).toBe(1);
  });
});
