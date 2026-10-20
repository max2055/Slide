import { OutboxService } from '../../workflows/outbox-service.js';
import type { ActorContext } from '../../auth/actor-context.js';
import { freezeInvestigationCaller } from '../../investigations/authorization.js';
import { OperationsAuthorization } from '../authorization.js';
import {
  OperationsError,
  operationsContentHash,
  type ActionVerificationReport,
  type ActionPlanVersion,
} from '../contracts.js';
import { parsePlanContent } from './approval-binding.js';
import {
  PlanStore,
  PlanSources,
  planRows,
  decodePlanJson,
  type PlanConnection,
} from './plan-store.js';
import { actionConfigHash, checkedActionReceipt } from './executor.js';
import type { ExecutionRecord } from './execution-store.js';
import type { ActionReportReference, SampleSlot } from './evidence-adapter.js';

export interface VerificationReport extends ActionVerificationReport {
  registeredAt: string;
  investigationVersion: number;
  requestId: string | null;
  executionSentAt: string | null;
  planHash: string;
  definitionHash: string;
  before: SampleSlot[];
  readiness: SampleSlot[];
  observation: SampleSlot[];
  observedFrom: string | null;
  observedUntil: string | null;
  validUntil: string;
  createdAt: string;
  correlationOnly: true;
}
export type ReportContent = Omit<VerificationReport, 'contentHash'>;
const fail = () => new OperationsError('OPERATIONS_PRECONDITION_FAILED');
const iso = (v: any) => (v == null ? null : new Date(v).toISOString());
export class ActionVerificationStore {
  constructor(
    readonly plans = new PlanStore(),
    private readonly sources = new PlanSources({
      validate: async () => {
        throw new OperationsError('OPERATIONS_DEPENDENCY_UNAVAILABLE');
      },
    }),
    private readonly authorization = new OperationsAuthorization(),
  ) {}
  async binding(c: PlanConnection, actor: ActorContext, executionId: string, write = false) {
    const [row] = await planRows(c, 'SELECT * FROM action_executions WHERE id=? FOR UPDATE', [
      executionId,
    ]);
    if (!row) throw new OperationsError('OPERATIONS_NOT_FOUND');
    const [p] = await planRows(
      c,
      'SELECT * FROM action_plan_versions WHERE plan_id=? AND version=? FOR SHARE',
      [row.plan_id, row.plan_version],
    );
    if (!p) throw fail();
    const content = parsePlanContent(decodePlanJson(p.content));
    if (
      operationsContentHash(content) !== p.content_hash ||
      Number(p.result_version) !== content.resultVersion
    )
      throw fail();
    const plan: ActionPlanVersion = {
      id: row.plan_id,
      version: Number(row.plan_version),
      schemaVersion: 1,
      contentHash: p.content_hash,
      state: p.state,
      content,
    };
    const refs = await this.sources.scope(c, actor, content);
    await this.authorization.authorize(
      c,
      actor,
      [...refs, content.target],
      write ? 'actions:execute' : 'actions:read',
    );
    const [investigation] = await planRows(c, 'SELECT * FROM investigations WHERE id=? FOR SHARE', [
      content.investigationId,
    ]);
    const [result] = await planRows(
      c,
      'SELECT * FROM investigation_results WHERE investigation_id=? ORDER BY version DESC LIMIT 1 FOR SHARE',
      [content.investigationId],
    );
    const [request] = await planRows(
      c,
      'SELECT id FROM investigation_requests WHERE investigation_id=? ORDER BY created_at DESC,id DESC LIMIT 1 FOR SHARE',
      [content.investigationId],
    );
    if (
      row.state === 'succeeded' &&
      (!row.receipt_hash || operationsContentHash(decodePlanJson(row.receipt)) !== row.receipt_hash)
    )
      throw fail();
    const execution = {
      ...row,
      id: row.id,
      version: Number(row.version),
      planId: row.plan_id,
      planVersion: Number(row.plan_version),
      operationId: row.operation_id,
      sentAt: iso(row.sent_at),
      cancelRequestedAt: iso(row.cancel_requested_at),
      state: row.state,
      receipt: decodePlanJson(row.receipt),
    } as ExecutionRecord;
    return { plan, execution, investigation, result, requestId: request?.id ?? null };
  }
  async latest(c: PlanConnection, executionId: string): Promise<VerificationReport | null> {
    const [row] = await planRows(
      c,
      'SELECT * FROM action_verification_reports WHERE execution_id=? ORDER BY version DESC LIMIT 1 FOR UPDATE',
      [executionId],
    );
    return row ? this.decode(row) : null;
  }
  decode(row: any): VerificationReport {
    const content = decodePlanJson(row.conclusion) as ReportContent;
    if (
      !content ||
      operationsContentHash(content) !== row.content_hash ||
      content.id !== row.id ||
      content.version !== Number(row.version) ||
      content.executionId !== row.execution_id ||
      content.planId !== row.plan_id ||
      content.planVersion !== Number(row.plan_version) ||
      content.investigationId !== row.investigation_id ||
      content.resultVersion !== Number(row.result_version) ||
      content.state !== row.state ||
      content.verifierHash !== row.verifier_hash ||
      content.observedFrom !== iso(row.observed_from) ||
      content.observedUntil !== iso(row.observed_until) ||
      content.missingSamples !== Number(row.missing_samples) ||
      operationsContentHash(content.evidence) !==
        operationsContentHash(decodePlanJson(row.evidence))
    )
      throw fail();
    return { ...content, contentHash: row.content_hash };
  }
  assertChain(
    report: VerificationReport,
    binding: Awaited<ReturnType<ActionVerificationStore['binding']>>,
  ): void {
    const { plan, execution } = binding;
    if (
      report.executionId !== execution.id ||
      report.planId !== plan.id ||
      report.planVersion !== plan.version ||
      report.planHash !== plan.contentHash ||
      report.investigationId !== plan.content.investigationId ||
      report.resultVersion !== plan.content.resultVersion ||
      report.definitionHash !== plan.content.verifier.definitionHash ||
      report.verifierHash !== operationsContentHash(plan.content.verifier)
    )
      throw fail();
  }
  async append(c: PlanConnection, value: ReportContent): Promise<VerificationReport> {
    const previous = await this.latest(c, value.executionId);
    if (
      previous
        ? previous.version + 1 !== value.version ||
          ['passed', 'failed', 'inconclusive'].includes(previous.state)
        : value.version !== 1
    )
      throw new OperationsError('OPERATIONS_VERSION_CONFLICT');
    if (
      previous &&
      [
        'id',
        'executionId',
        'planId',
        'planVersion',
        'investigationId',
        'resultVersion',
        'schemaVersion',
        'planHash',
        'definitionHash',
        'verifierHash',
        'registeredAt',
        'investigationVersion',
        'requestId',
        'validUntil',
      ].some((k) => (previous as any)[k] !== (value as any)[k])
    )
      throw fail();
    if (
      value.before.length !== 13 ||
      value.readiness.length > 6 ||
      value.observation.length > 30 ||
      (previous &&
        (operationsContentHash(previous.before) !== operationsContentHash(value.before) ||
          operationsContentHash(previous.evidence) !== operationsContentHash(value.evidence) ||
          (previous.executionSentAt !== null &&
            previous.executionSentAt !== value.executionSentAt) ||
          (['readiness', 'observation'] as const).some(
            (key) =>
              value[key].length < previous[key].length ||
              value[key].length > previous[key].length + 1 ||
              operationsContentHash(value[key].slice(0, previous[key].length)) !==
                operationsContentHash(previous[key]),
          )))
    )
      throw fail();
    const contentHash = operationsContentHash(value);
    await c.execute(
      `INSERT INTO action_verification_reports
      (id,version,execution_id,investigation_id,result_version,plan_id,plan_version,verifier_hash,content_hash,state,observed_from,observed_until,missing_samples,evidence,conclusion)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        value.id,
        value.version,
        value.executionId,
        value.investigationId,
        value.resultVersion,
        value.planId,
        value.planVersion,
        value.verifierHash,
        contentHash,
        value.state,
        value.observedFrom && new Date(value.observedFrom),
        value.observedUntil && new Date(value.observedUntil),
        value.missingSamples,
        JSON.stringify(value.evidence),
        JSON.stringify(value),
      ],
    );
    await new OutboxService({ getConnection: async () => c }).append(c, {
      schemaVersion: 1,
      aggregateVersion: value.version,
      aggregateType: 'operations.verification',
      aggregateId: value.id,
      eventType: 'operations.verification.changed',
      payload: {
        schemaVersion: 1,
        objectType: 'verification',
        objectId: value.id,
        version: value.version,
        occurredAt: value.createdAt,
      },
      idempotencyKey: `verification:${value.id}:${value.version}`,
    });
    return { ...value, contentHash };
  }
  async get(caller: ActorContext, executionId: string, version?: number) {
    const actor = freezeInvestigationCaller(caller);
    return this.plans.transaction(async (c) => {
      const binding = await this.binding(c, actor, executionId);
      const [row] =
        version === undefined
          ? []
          : await planRows(
              c,
              'SELECT * FROM action_verification_reports WHERE execution_id=? AND version=? FOR SHARE',
              [executionId, version],
            );
      const report =
        version === undefined ? await this.latest(c, executionId) : row ? this.decode(row) : null;
      if (!report) throw new OperationsError('OPERATIONS_NOT_FOUND');
      this.assertChain(report, binding);
      return report;
    });
  }
  /** Authorize retained historical provenance even when it can no longer close a case. */
  async reference(
    c: PlanConnection,
    caller: ActorContext,
    investigationId: string,
    ref: ActionReportReference,
  ) {
    const [row] = await planRows(
      c,
      'SELECT * FROM action_verification_reports WHERE id=? AND version=? FOR SHARE',
      [ref.id, ref.version],
    );
    if (!row || row.investigation_id !== investigationId)
      throw new OperationsError('OPERATIONS_NOT_FOUND');
    const report = this.decode(row),
      binding = await this.binding(c, caller, report.executionId);
    this.assertChain(report, binding);
    if (report.contentHash !== ref.hash) throw fail();
    return { report, binding };
  }
  /** Same feedback transaction, no second connection or untrusted run evidence. */
  async forFeedback(
    c: PlanConnection,
    caller: ActorContext,
    investigationId: string,
    resultId: string,
    resultVersion: number,
    expectedInvestigationVersion: number,
    ref: ActionReportReference,
    from: string,
    to: string,
  ) {
    const { report, binding } = await this.reference(c, caller, investigationId, ref);
    // Human feedback may precede closure; structural revisions (including reopen or a new Run)
    // have no feedback row and therefore cannot reuse an older verification epoch.
    const intervening = await planRows(
      c,
      `SELECT accepted_version,command_json FROM investigation_feedback
      WHERE investigation_id=? AND accepted_version>? AND accepted_version<=? ORDER BY accepted_version FOR SHARE`,
      [investigationId, report.investigationVersion, expectedInvestigationVersion],
    );
    const epochMatches =
      expectedInvestigationVersion >= report.investigationVersion &&
      intervening.length === expectedInvestigationVersion - report.investigationVersion &&
      intervening.every(
        (r, i) =>
          Number(r.accepted_version) === report.investigationVersion + i + 1 &&
          decodePlanJson(r.command_json).kind !== 'close',
      );
    const latest = await this.latest(c, report.executionId),
      now = await this.plans.now(c);
    if (
      report.contentHash !== ref.hash ||
      latest?.version !== report.version ||
      report.state !== 'passed' ||
      binding.execution.state !== 'succeeded' ||
      report.resultVersion !== resultVersion ||
      binding.result?.id !== resultId ||
      Number(binding.result?.version) !== resultVersion ||
      !epochMatches ||
      report.requestId !== binding.requestId ||
      Date.parse(report.validUntil) <= +now ||
      !report.observedFrom ||
      !report.observedUntil ||
      Date.parse(from) < Date.parse(report.observedFrom) ||
      Date.parse(to) > Date.parse(report.observedUntil)
    )
      throw fail();
    checkedActionReceipt(binding.execution.receipt, binding.execution, binding.plan);
    for (const evidence of binding.plan.content.evidence) {
      const [e] = await planRows(
        c,
        'SELECT * FROM investigation_evidence WHERE id=? AND investigation_id=? FOR SHARE',
        [evidence.id, investigationId],
      );
      if (!e || e.expired_at || +new Date(e.expires_at) <= +now || e.content_hash !== evidence.hash)
        throw fail();
    }
    // Config identity is still the one bound to the original approved plan.
    if (
      report.before.some((s) => s.sample && s.sample.configHash !== actionConfigHash(binding.plan))
    )
      throw fail();
    return { report, resource: binding.plan.content.target };
  }
}
