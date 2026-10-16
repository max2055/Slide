import type { ActorContext } from '../../auth/actor-context.js';
import {
  ACTION_PLAN_VALIDITY,
  actionPlanContentSchema,
  operationsContentHash,
  OperationsError,
  type ActionPlanContent,
  type ActionPlanVersion,
} from '../contracts.js';

export const ACTION_APPROVAL_TOOL = 'operations_action_plan';
export const ACTION_APPROVAL_KIND = 'operations-action-plan-v1';
export function parsePlanContent(input: unknown): ActionPlanContent {
  const parsed = actionPlanContentSchema.safeParse(input);
  if (!parsed.success) throw new OperationsError('OPERATIONS_INPUT_INVALID');
  return parsed.data;
}
/** Server-only identity and time defaults. Client supplied identities/timestamps
 * are rejected by the route; direct domain callers must pass content only. */
export function proposedContent(
  input: unknown,
  actor: ActorContext,
  now: Date,
  lifetimeMs = ACTION_PLAN_VALIDITY.defaultMs,
): ActionPlanContent {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    !Number.isSafeInteger(lifetimeMs) ||
    lifetimeMs <= 0 ||
    lifetimeMs > ACTION_PLAN_VALIDITY.maximumMs
  )
    throw new OperationsError('OPERATIONS_INPUT_INVALID');
  if (['author', 'requester', 'validFrom', 'validUntil'].some((key) => Object.hasOwn(input, key)))
    throw new OperationsError('OPERATIONS_INPUT_INVALID');
  const principal = { kind: actor.principalKind ?? 'user', id: actor.userId };
  return parsePlanContent({
    ...input,
    author: principal,
    requester: principal,
    validFrom: now.toISOString(),
    validUntil: new Date(now.getTime() + lifetimeMs).toISOString(),
  });
}
export function approvalAuthority(actor: ActorContext) {
  return {
    principalKind: actor.principalKind ?? 'user',
    userId: actor.userId,
    sessionVersion: actor.sessionVersion,
    permissions: [...actor.permissions].sort(),
    instanceScopes: { ...actor.instanceScopes },
    resourceBoundary: actor.resourceBoundary
      ? {
          instanceIds: [...actor.resourceBoundary.instanceIds].sort((a, b) => a - b),
          serverIds: [...actor.resourceBoundary.serverIds].sort((a, b) => a - b),
          networkDeviceIds: [...actor.resourceBoundary.networkDeviceIds].sort((a, b) => a - b),
        }
      : null,
  };
}
export type ApprovalAuthority = ReturnType<typeof approvalAuthority>;
export function authorityCaller(snapshot: ApprovalAuthority): ActorContext {
  return {
    ...snapshot,
    username: 'action-approval',
    roles: [],
    requestId: 'action-approval-revalidation',
    resourceBoundary: snapshot.resourceBoundary ?? undefined,
  };
}
export function actionApprovalHash(
  plan: ActionPlanVersion,
  proposer: ApprovalAuthority,
  liveAuthorityHash = operationsContentHash(proposer),
): string {
  if (operationsContentHash(parsePlanContent(plan.content)) !== plan.contentHash)
    throw new OperationsError('OPERATIONS_PRECONDITION_FAILED');
  return operationsContentHash({
    kind: ACTION_APPROVAL_KIND,
    planId: plan.id,
    version: plan.version,
    contentHash: plan.contentHash,
    parametersHash: operationsContentHash(plan.content.parameters),
    content: plan.content,
    proposer,
    liveAuthorityHash,
  });
}
export function assertPlanFresh(plan: ActionPlanVersion, now: Date): void {
  const from = Date.parse(plan.content.validFrom),
    until = Date.parse(plan.content.validUntil);
  if (now.getTime() >= until) throw new OperationsError('OPERATIONS_EXPIRED');
  if (
    now.getTime() < from ||
    until - from > ACTION_PLAN_VALIDITY.maximumMs ||
    operationsContentHash(plan.content) !== plan.contentHash
  )
    throw new OperationsError('OPERATIONS_PRECONDITION_FAILED');
  for (const ref of [...plan.content.evidence, ...plan.content.relations, ...plan.content.baselines]) {
    if (Date.parse(ref.validUntil) <= now.getTime()) throw new OperationsError('OPERATIONS_EXPIRED');
  }
}
