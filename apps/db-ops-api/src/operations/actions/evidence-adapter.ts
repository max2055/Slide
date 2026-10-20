/** Independent action observation provenance; never masquerades as run tool evidence. */
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { OperationsError, operationsContentHash, type ActionPlanVersion } from '../contracts.js';
import { actionConfigHash } from './executor.js';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const healthSampleSchema = z.strictObject({
  at: z.iso.datetime({ precision: 3 }),
  serverId: z.number().int().positive(),
  configHash: hash,
  helperHash: hash,
  unitHash: hash,
  hostFingerprint: z.string().min(1),
  invocationId: z.string().regex(/^[a-f0-9]{32}$/),
  active: z.boolean(),
  running: z.boolean(),
  mainPid: z.number().int().nonnegative(),
  httpStatus: z.number().int(),
  restarts: z.number().int().nonnegative(),
});
export type HealthSample = z.infer<typeof healthSampleSchema>;
export interface VerificationDefinition {
  id: string;
  version: string;
  serverId: number;
  configHash: string;
  helperHash: string;
  unitHash: string;
  hostFingerprint: string;
  beforeSeconds: 120;
  readinessSeconds: 60;
  observationSeconds: 300;
  intervalSeconds: 10;
  maxExtraRestarts: 0;
  requireAllHealthy: true;
}
export interface ActionHealthSource {
  /** Fixed trusted target only. History is collected independently before dispatch. */
  history(from: string, until: string): Promise<readonly unknown[]>;
  sample(): Promise<unknown>;
}
export interface SampleSlot {
  at: string;
  sample: HealthSample | null;
}
export interface ActionReportReference {
  id: string;
  version: number;
  hash: string;
}
export class ActionEvidenceAdapter {
  readonly definition: Readonly<VerificationDefinition>;
  readonly definitionHash: string;
  constructor(
    definition: VerificationDefinition,
    private readonly source: ActionHealthSource,
    definitionBytes?: Uint8Array,
  ) {
    this.definition = Object.freeze(structuredClone(definition));
    this.definitionHash = operationsContentHash(this.definition);
    // Existing P10 packages pin the exact verifier file bytes. Preserve that identity.
    if (definitionBytes) {
      let registered: Record<string, unknown>;
      try {
        registered = JSON.parse(Buffer.from(definitionBytes).toString('utf8'));
      } catch {
        throw new OperationsError('OPERATIONS_PRECONDITION_FAILED');
      }
      if (
        !registered ||
        [
          'id',
          'version',
          'beforeSeconds',
          'readinessSeconds',
          'observationSeconds',
          'intervalSeconds',
          'maxExtraRestarts',
          'requireAllHealthy',
        ].some(
          (key) => registered[key] !== (definition as unknown as Record<string, unknown>)[key],
        ) ||
        registered.target !== `server:${definition.serverId}/slide-action-demo.service`
      )
        throw new OperationsError('OPERATIONS_PRECONDITION_FAILED');
      this.definitionHash = createHash('sha256').update(definitionBytes).digest('hex');
    }
  }
  assertPlan(plan: ActionPlanVersion): void {
    const v = plan.content.verifier,
      d = this.definition;
    if (
      v.id !== d.id ||
      v.version !== d.version ||
      v.definitionHash !== this.definitionHash ||
      plan.content.target.id !== d.serverId ||
      actionConfigHash(plan) !== d.configHash ||
      plan.content.tool.hash !== d.helperHash ||
      v.beforeSeconds !== 120 ||
      v.readinessSeconds !== 60 ||
      v.observationSeconds !== 300 ||
      v.intervalSeconds !== 10 ||
      v.maxExtraRestarts !== 0 ||
      v.requireAllHealthy !== true ||
      d.beforeSeconds !== 120 ||
      d.readinessSeconds !== 60 ||
      d.observationSeconds !== 300 ||
      d.intervalSeconds !== 10 ||
      d.maxExtraRestarts !== 0 ||
      d.requireAllHealthy !== true
    )
      throw new OperationsError('OPERATIONS_PRECONDITION_FAILED');
  }
  checked(value: unknown, at: string): HealthSample | null {
    const p = healthSampleSchema.safeParse(value),
      d = this.definition;
    if (!p.success) return null;
    const s = p.data;
    // Slots never accept stale/future observations or another target/configuration.
    if (
      Math.abs(Date.parse(s.at) - Date.parse(at)) > 1000 ||
      s.serverId !== d.serverId ||
      s.configHash !== d.configHash ||
      s.helperHash !== d.helperHash ||
      s.unitHash !== d.unitHash ||
      s.hostFingerprint !== d.hostFingerprint
    )
      return null;
    return s;
  }
  async before(until: string): Promise<SampleSlot[]> {
    const end = Date.parse(until),
      start = end - 120_000;
    const history = await this.source.history(new Date(start).toISOString(), until);
    return Array.from({ length: 13 }, (_, i) => {
      const at = new Date(start + i * 10_000).toISOString();
      const found = history.map((s) => this.checked(s, at)).filter((s) => s !== null);
      return { at, sample: found.length === 1 ? found[0] : null };
    });
  }
  async sample(at: string): Promise<SampleSlot> {
    // A failed read is missing evidence, never permission to execute/retry an action.
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const started = performance.now();
    try {
      const value = await Promise.race([
        this.source.sample(),
        new Promise<null>((resolve) => {
          timeout = setTimeout(() => resolve(null), 1000);
        }),
      ]);
      return { at, sample: performance.now() - started > 1000 ? null : this.checked(value, at) };
    } catch {
      return { at, sample: null };
    } finally {
      clearTimeout(timeout);
    }
  }
}
export function healthy(s: HealthSample): boolean {
  return s.active && s.running && s.mainPid > 0 && s.httpStatus === 200;
}
/** Deterministic B13 conclusion, independent of an exit code. Missing data wins. */
export function evaluateActionEffect(
  before: readonly SampleSlot[],
  readiness: readonly SampleSlot[],
  observation: readonly SampleSlot[],
  receipt: { before: string; after: string },
) {
  const all = [...before, ...readiness, ...observation];
  const missingSamples =
    all.filter((slot) => slot.sample === null).length +
    Math.max(0, 13 - before.length) +
    Math.max(0, 30 - observation.length);
  if (missingSamples)
    return { state: 'inconclusive' as const, reason: 'MISSING_SAMPLES', missingSamples };
  const last = before.at(-1)?.sample;
  if (
    !last ||
    before.some((s) => s.sample!.invocationId !== receipt.before) ||
    receipt.before === receipt.after
  )
    return { state: 'failed' as const, reason: 'INVOCATION_MISMATCH', missingSamples: 0 };
  if (!readiness.some((s) => healthy(s.sample!) && s.sample!.invocationId === receipt.after))
    return { state: 'failed' as const, reason: 'READINESS_TIMEOUT', missingSamples: 0 };
  if (
    readiness.some(
      (s) =>
        s.sample!.restarts !== last.restarts ||
        ![receipt.before, receipt.after].includes(s.sample!.invocationId),
    ) ||
    observation.some(
      (s) =>
        !healthy(s.sample!) ||
        s.sample!.invocationId !== receipt.after ||
        s.sample!.restarts !== last.restarts,
    )
  )
    return { state: 'failed' as const, reason: 'UNHEALTHY_OR_EXTRA_RESTART', missingSamples: 0 };
  return { state: 'passed' as const, reason: null, missingSamples: 0 };
}
