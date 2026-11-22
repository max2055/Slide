/**
 * MAX-239 — canonical hashing, budgets and immutability helpers for the
 * internal template-trigger package.
 *
 * Two hashes exist and they answer different questions:
 *
 * - `content_hash` of a rule version is carried by the trusted catalog and
 *   covers the rule body (everything except the hash itself). It pins *what the
 *   rule says*, so a re-published body with the same `(rule_id, version)` is a
 *   detectable conflict rather than a silent update.
 * - `snapshot_hash` of a rule/resource snapshot covers the resolved, frozen
 *   value including its item identity, parameters and policies. It is the
 *   identity a later persistence package can compare before treating a snapshot
 *   as the one it stored.
 *
 * Everything is canonicalised with the existing `stable` serialiser, so key
 * order cannot change a hash and no new canonicaliser is introduced.
 */
import { createHash } from 'node:crypto';
import { stable } from '../packages/model.js';
import type {
  ResolvedTriggerExpression, TriggerExpression, TriggerResourceSnapshot, TriggerRuleCandidate,
  TriggerRuleCandidateSet, TriggerRuleSnapshot, TriggerRuleVersion,
} from '../../contracts/metrics/triggers.js';
import type { HashId } from '../../contracts/metrics/templates.js';

export const hashOf = (value: unknown): HashId =>
  `sha256:${createHash('sha256').update(stable(value)).digest('hex')}`;

/** The hash boundary of a rule version body: every member except `content_hash`. */
export const triggerRuleContentHash = (rule: Omit<TriggerRuleVersion, 'content_hash'>): HashId =>
  hashOf({
    rule_id: rule.rule_id,
    version: rule.version,
    scope: rule.scope,
    metric: rule.metric,
    unit: rule.unit,
    ...(rule.severity ? { severity: rule.severity } : {}),
    parameters: rule.parameters,
    problem: rule.problem,
    ...(rule.recovery_mode ? { recovery_mode: rule.recovery_mode } : {}),
    ...(rule.allow_manual_close !== undefined ? { allow_manual_close: rule.allow_manual_close } : {}),
    ...(rule.recovery ? { recovery: rule.recovery } : {}),
    quality: rule.quality,
    clock: rule.clock,
  });

/** The hash boundary of one resolved rule: everything except its own hash. */
export const triggerRuleSnapshotHash = (rule: Omit<TriggerRuleSnapshot, 'snapshot_hash'>): HashId =>
  hashOf({
    rule_id: rule.rule_id,
    version: rule.version,
    body_hash: rule.body_hash,
    scope: rule.scope,
    item: rule.item,
    metric: rule.metric,
    unit: rule.unit,
    ...(rule.severity ? { severity: rule.severity } : {}),
    dimensions: rule.dimensions,
    ...(rule.inputs ? { inputs: rule.inputs } : {}),
    decision: rule.decision,
    parameters: rule.parameters,
    problem: rule.problem,
    ...(rule.recovery_mode ? { recovery_mode: rule.recovery_mode } : {}),
    ...(rule.allow_manual_close !== undefined ? { allow_manual_close: rule.allow_manual_close } : {}),
    ...(rule.recovery ? { recovery: rule.recovery } : {}),
    quality: rule.quality,
    clock: rule.clock,
  });

/** The hash boundary of one resource snapshot: everything except its own hash. */
export const triggerSnapshotHash = (
  snapshot: Omit<TriggerResourceSnapshot, 'snapshot_hash'> | TriggerRuleCandidateSet,
): HashId => hashOf({
  kind: snapshot.kind,
  internal: snapshot.internal,
  persisted: snapshot.persisted,
  applied: snapshot.applied,
  effective: snapshot.effective,
  status: snapshot.status,
  resource: snapshot.resource,
  config_revision: snapshot.config_revision,
  plan_identity: snapshot.plan_identity,
  templates: snapshot.templates,
  rules: snapshot.rules,
});

export interface ExpressionBudget {
  nodes: number;
  depth: number;
}

/** The absent item ID keeps the original rule scope as the operand. */
export function triggerSelectors(...expressions: (TriggerExpression | ResolvedTriggerExpression | undefined)[]) {
  const selectors = [];
  for (const expression of expressions) {
    if (!expression) continue;
    const stack = [expression];
    while (stack.length) {
      const node = stack.pop()!;
      if (node.node === 'compare') selectors.push(node.select);
      else stack.push(...node.children);
    }
  }
  return selectors;
}

export function referencedTriggerItems(anchor: string, ...expressions: (TriggerExpression | ResolvedTriggerExpression | undefined)[]) {
  return [...new Set(triggerSelectors(...expressions).map(select => select.item_id ?? anchor))]
    .filter(id => id !== anchor).sort();
}

/**
 * Walk the expression once and return its real size. Iterative (explicit stack)
 * so a hostile depth cannot exhaust the call stack, even though the resolver
 * checks this after the schema already bounded the shape.
 */
export function expressionBudget(expression: TriggerExpression | ResolvedTriggerExpression): ExpressionBudget {
  let nodes = 0;
  let depth = 0;
  const stack: Array<{ node: TriggerExpression | ResolvedTriggerExpression; level: number }> = [{ node: expression, level: 1 }];
  while (stack.length > 0) {
    const { node, level } = stack.pop()!;
    nodes += 1;
    if (level > depth) depth = level;
    if (node.node !== 'compare') {
      for (const child of node.children) stack.push({ node: child, level: level + 1 });
    }
  }
  return { nodes, depth };
}

/** Collect every parameter name an expression threshold references, in first-seen order. */
export function referencedParameters(expression: TriggerExpression | ResolvedTriggerExpression | undefined): string[] {
  if (!expression) return [];
  const names: string[] = [];
  const stack: Array<TriggerExpression | ResolvedTriggerExpression> = [expression];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.node === 'compare') {
      if (node.threshold.kind === 'parameter' && !names.includes(node.threshold.name)) names.push(node.threshold.name);
    } else {
      // Reverse so the natural left-to-right order is preserved when popped.
      for (let index = node.children.length - 1; index >= 0; index -= 1) stack.push(node.children[index]);
    }
  }
  return names;
}

const deepFreeze = <T>(value: T): T => {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const entry of Object.values(value as Record<string, unknown>)) deepFreeze(entry);
  }
  return value;
};

/**
 * Detach a value from its caller and freeze it. A snapshot is immutable evidence:
 * a later mutation of the input object must not change what was hashed, and a
 * consumer must not be able to write into it.
 */
export function frozenCopy<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

/** A candidate rule is immutable in the same way; the compiler relies on it. */
export const frozenCandidate = (candidate: TriggerRuleCandidate): TriggerRuleCandidate => frozenCopy(candidate);
