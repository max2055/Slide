import type { ActorContext } from '../../auth/actor-context.js';
import { freezeInvestigationCaller } from '../../investigations/authorization.js';
import { OperationsError, operationsContentHash } from '../contracts.js';
import { checkedActionReceipt } from './executor.js';
import {
  ActionEvidenceAdapter,
  evaluateActionEffect,
  healthy,
  type SampleSlot,
} from './evidence-adapter.js';
import {
  ActionVerificationStore,
  type VerificationReport,
  type ReportContent,
} from './verification-store.js';

export interface VerificationClock {
  now(): number;
  until(at: number): Promise<void>;
}
const clock: VerificationClock = {
  now: () => Date.now(),
  until: async (at) => {
    while (Date.now() < at)
      await new Promise((resolve) => setTimeout(resolve, Math.min(10_000, at - Date.now())));
  },
};
const content = (r: VerificationReport): ReportContent => {
  const { contentHash: _hash, ...value } = r;
  return value;
};
/** This service only reads the target. It has no executor, shell or restart port. */
export class ActionVerificationService {
  constructor(
    readonly store: ActionVerificationStore,
    private readonly evidence: ActionEvidenceAdapter,
    private readonly time: VerificationClock = clock,
  ) {}
  async prepare(caller: ActorContext, executionId: string): Promise<VerificationReport> {
    const actor = freezeInvestigationCaller(caller);
    // Read history outside SQL locks, then recheck all binding/authority under lock.
    const at = await this.store.plans.transaction(async (c) => {
      const b = await this.store.binding(c, actor, executionId, true);
      this.evidence.assertPlan(b.plan);
      const prior = await this.store.latest(c, executionId);
      if (prior) {
        this.store.assertChain(prior, b);
        return { prior };
      }
      if (b.execution.sentAt || !['queued', 'prechecking'].includes(b.execution.state))
        throw new OperationsError('OPERATIONS_PRECONDITION_FAILED');
      return { at: (await this.store.plans.now(c)).toISOString() };
    });
    if (at.prior) return at.prior;
    const before = await this.evidence.before(at.at!);
    return this.store.plans.transaction(async (c) => {
      const b = await this.store.binding(c, actor, executionId, true),
        now = await this.store.plans.now(c);
      this.evidence.assertPlan(b.plan);
      const prior = await this.store.latest(c, executionId);
      if (prior) return prior;
      if (
        b.execution.sentAt ||
        !['queued', 'prechecking'].includes(b.execution.state) ||
        Number(b.result?.version) !== b.plan.content.resultVersion ||
        ['closed', 'archived'].includes(b.investigation.lifecycle)
      )
        throw new OperationsError('OPERATIONS_PRECONDITION_FAILED');
      const validity = Math.min(...b.plan.content.evidence.map((e) => Date.parse(e.validUntil)));
      return this.store.append(c, {
        id: executionId,
        version: 1,
        schemaVersion: 1,
        executionId,
        planId: b.plan.id,
        planVersion: b.plan.version,
        investigationId: b.plan.content.investigationId,
        resultVersion: b.plan.content.resultVersion,
        state: 'pending',
        verifierHash: operationsContentHash(b.plan.content.verifier),
        definitionHash: this.evidence.definitionHash,
        planHash: b.plan.contentHash,
        evidence: [],
        missingSamples: before.filter((s) => !s.sample).length,
        reason: null,
        before,
        readiness: [],
        observation: [],
        registeredAt: at.at!,
        createdAt: now.toISOString(),
        investigationVersion: Number(b.investigation.version),
        requestId: b.requestId,
        executionSentAt: null,
        observedFrom: null,
        observedUntil: null,
        validUntil: new Date(validity).toISOString(),
        correlationOnly: true,
      });
    });
  }
  async run(caller: ActorContext, executionId: string): Promise<VerificationReport> {
    const actor = freezeInvestigationCaller(caller);
    for (;;) {
      const step = await this.store.plans.transaction(async (c) => {
        const b = await this.store.binding(c, actor, executionId),
          report = await this.store.latest(c, executionId);
        if (!report) throw new OperationsError('OPERATIONS_PRECONDITION_FAILED');
        this.store.assertChain(report, b);
        this.evidence.assertPlan(b.plan);
        if (['passed', 'failed', 'inconclusive'].includes(report.state)) return { done: report };
        if (
          ['queued', 'prechecking', 'dispatching'].includes(b.execution.state) &&
          !b.execution.cancelRequestedAt
        )
          throw new OperationsError('OPERATIONS_PRECONDITION_FAILED'); // queue must redeliver after terminal receipt; never execute
        const now = await this.store.plans.now(c);
        const save = (patch: Partial<ReportContent>) =>
          this.store.append(c, {
            ...content(report),
            ...patch,
            version: report.version + 1,
            createdAt: now.toISOString(),
          });
        if (
          b.execution.state !== 'succeeded' ||
          b.execution.cancelRequestedAt ||
          !b.execution.sentAt
        )
          return {
            done: await save({
              state: 'inconclusive',
              reason: 'EXECUTION_NOT_CONFIRMED',
              missingSamples: Math.max(1, report.missingSamples),
            }),
          };
        const receipt = checkedActionReceipt(b.execution.receipt, b.execution, b.plan);
        const sent = Date.parse(b.execution.sentAt),
          baselineEnd = Date.parse(report.before.at(-1)!.at);
        if (
          Date.parse(report.registeredAt) > sent ||
          baselineEnd > sent ||
          sent - baselineEnd > 10_000
        )
          return {
            done: await save({
              state: 'inconclusive',
              reason: 'BEFORE_WINDOW_NOT_ADJACENT',
              missingSamples: Math.max(1, report.missingSamples),
            }),
          };
        const ready = report.readiness.find(
          (s) => s.sample && healthy(s.sample) && s.sample.invocationId === receipt.after,
        );
        if (!ready && report.readiness.length >= 6)
          return {
            done: await save({
              state: report.missingSamples ? 'inconclusive' : 'failed',
              reason: report.missingSamples ? 'MISSING_SAMPLES' : 'READINESS_TIMEOUT',
            }),
          };
        if (ready && report.observation.length === 30) {
          const verdict = evaluateActionEffect(
            report.before,
            report.readiness,
            report.observation,
            { before: receipt.before, after: receipt.after! },
          );
          return {
            done: await save({
              ...verdict,
              observedFrom: ready.at,
              observedUntil: report.observation.at(-1)!.at,
              executionSentAt: b.execution.sentAt,
            }),
          };
        }
        const kind = ready ? ('observation' as const) : ('readiness' as const);
        const nextAt = (ready ? Date.parse(ready.at) : sent) + (report[kind].length + 1) * 10_000;
        return { report, kind, nextAt };
      });
      if (step.done) return step.done;
      await this.time.until(step.nextAt!);
      const at = new Date(step.nextAt!).toISOString();
      // Waiting for the next slot grants no retained authority to read the target.
      await this.store.plans.transaction(async (c) => {
        const b = await this.store.binding(c, actor, executionId);
        this.store.assertChain(step.report!, b);
      });
      const slot: SampleSlot =
        this.time.now() - step.nextAt! > 1000
          ? { at, sample: null }
          : await this.evidence.sample(at);
      await this.store.plans.transaction(async (c) => {
        const b = await this.store.binding(c, actor, executionId),
          latest = await this.store.latest(c, executionId);
        if (!latest || latest.version !== step.report!.version) return; // another read-only worker committed first
        this.store.assertChain(latest, b);
        const kind = step.kind!,
          missingSamples = latest.missingSamples + (slot.sample ? 0 : 1);
        await this.store.append(c, {
          ...content(latest),
          state: 'observing',
          version: latest.version + 1,
          [kind]: [...latest[kind], slot],
          missingSamples,
          executionSentAt: b.execution.sentAt,
          createdAt: (await this.store.plans.now(c)).toISOString(),
        });
      });
    }
  }
}
