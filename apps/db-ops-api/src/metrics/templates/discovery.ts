import type { DiscoveryInstance, DiscoveryRule } from '../../contracts/metrics/discovery.js';
import { hashOf } from '../triggers/model.js';
import { stable } from '../packages/model.js';
import type { TemplateDraftAggregate } from './model.js';

/** These publication fields are derived from the draft's discovery rules. */
export function discoveryPublication(aggregate: TemplateDraftAggregate) {
  const rules = aggregate.discovery_rules ?? [];
  const parameters = structuredClone(aggregate.parameters);
  if (rules.length) {
    const budgets = {
      discovery_timeout_ms: Math.min(...rules.map(rule => rule.timeout_ms)),
      discovery_max_rows: Math.min(...rules.map(rule => rule.max_instances)),
      discovery_series_upper_bound: rules.reduce((sum, rule) => sum + rule.max_instances * rule.item_ids.length, 0),
    };
    for (const [name, value] of Object.entries(budgets)) {
      parameters.schema[name] = { type: 'integer', min: value, max: value };
      parameters.defaults[name] = value;
    }
  }
  return {
    parameters,
    capabilities: { ...aggregate.capabilities, discovery: rules.length
      ? { contract_version: '1.0.0', ref: 'builtin:template-discovery.v1', executable: true } as const
      : { contract_version: '1.0.0', ref: null, executable: false } as const },
  };
}

export interface DiscoveryMember { identity: string; name: string; dimensions: Record<string, string> }

/** Only a successful complete bounded enumeration proves absence. Never remove a member or its history. */
export function reconcileDiscovery(rule: DiscoveryRule, previous: DiscoveryInstance[], rows: DiscoveryMember[], now: number,
  complete: boolean): DiscoveryInstance[] {
  if (!complete) return structuredClone(previous);
  if (rows.length > rule.max_instances) throw new Error('DISCOVERY_BUDGET');
  if (new Set(rows.map(row => row.identity)).size !== rows.length) throw new Error('DISCOVERY_DUPLICATE');
  if (!Number.isFinite(now) || previous.some(v => now < v.last_seen || now < v.transitions.at(-1)!.at)) throw new Error('DISCOVERY_CLOCK');
  const next = new Map(previous.map(v => [v.id, structuredClone(v)]));
  const present = new Set<string>();
  for (const row of rows) {
    const id = hashOf({ rule: rule.rule_id, identity: row.identity });
    present.add(id);
    const member = next.get(id) ?? { ...row, id, first_seen: now, last_seen: now, missing_since: null,
      state: 'active' as const, manual: false, transitions: [{ state: 'active' as const, at: now }], dimension_history: [structuredClone(row.dimensions)] };
    member.name = row.name; member.last_seen = now; member.missing_since = null;
    if (stable(member.dimensions) !== stable(row.dimensions)) {
      member.dimensions = structuredClone(row.dimensions);
      if (!member.dimension_history.some(d => stable(d) === stable(row.dimensions))) member.dimension_history.push(structuredClone(row.dimensions));
    }
    if (!member.manual && member.state !== 'active') { member.state = 'active'; member.transitions.push({ state: 'active', at: now }); }
    next.set(id, member);
  }
  for (const member of next.values()) {
    if (present.has(member.id) || member.manual) continue;
    member.missing_since ??= now;
    const elapsed = now - member.missing_since;
    const state = elapsed >= rule.retire_after_ms ? 'retired' : elapsed >= rule.lost_after_ms ? 'disabled' : 'waiting';
    if (state !== member.state) { member.state = state; member.transitions.push({ state, at: now }); }
  }
  return [...next.values()].sort((a,b) => a.id.localeCompare(b.id));
}
