import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';
import type { DiscoveryInstance, DiscoveryRule } from '../../contracts/metrics/discovery.js';
import type { TemplateVersion } from './model.js';
import { MySqlTemplateRepository } from './mysql-repository.js';
import { connectionTemplatePool } from './binding-service.js';
import type { DecodedTemplateBindingPayload } from '../bindings/persistence-codec.js';
import type { PackageResult } from '../packages/runner.js';
import { stable } from '../packages/model.js';
import { reconcileDiscovery } from './discovery.js';
// Publication fixes these parameter bounds to the rule budget; resource overrides cannot widen them.
export function discoveryBudget(templates: Array<{parameters:Array<{name:string;effective:unknown}>}>) {
  const budgets=templates.map(t=>Object.fromEntries(t.parameters.filter(p=>p.name.startsWith('discovery_')).map(p=>[p.name,Number(p.effective)])))
    .filter(v=>Number.isFinite(v.discovery_timeout_ms)&&Number.isFinite(v.discovery_max_rows)&&Number.isFinite(v.discovery_series_upper_bound));
  return budgets.length?{timeout_ms:Math.min(...budgets.map(v=>v.discovery_timeout_ms)),max_rows:Math.min(...budgets.map(v=>v.discovery_max_rows)),
    series_upper_bound:budgets.reduce((sum,v)=>sum+v.discovery_series_upper_bound,0)}:null;
}

export interface DiscoveryState {
  template_version: number; content_hash: string; config_revision: number;
  rule: DiscoveryRule; items: TemplateVersion['items']; triggers: TemplateVersion['aggregate']['triggers'];
  members: DiscoveryInstance[];
}
export const decodeDiscovery = (value: any): DiscoveryState => typeof value === 'string' ? JSON.parse(value) : value;

/** Same transaction/lock as the formal writer. No independent sampler, observations or events. */
export async function updateFormalDiscovery(c: PoolConnection, binding: DecodedTemplateBindingPayload,
  results: Array<{ release: { id: string; version: string; digest: string }; result: PackageResult }>, now: number) {
  const repository = new MySqlTemplateRepository(connectionTemplatePool(c));
  const ref = binding.binding.resource, key = `${ref.type}:${ref.id}`;
  const allowed = new Map<string, Set<string>>();
  for (const pin of binding.binding.template_pins) {
    const version = await repository.getVersion(pin.template_id, pin.version);
    if (!version) throw new Error('DISCOVERY_VERSION_MISSING');
    for (const rule of version.aggregate.discovery_rules ?? []) {
      const items = version.items.filter(item => rule.item_ids.includes(item.item_id));
      // Successful empty enumerations have no raw samples; identify their collector from the pinned package plan.
      const steps = binding.pending.plan.releases.flatMap(r => r.steps).filter(s => s.items.some(i =>
        i.template_id === pin.template_id && rule.item_ids.includes(i.item_id)));
      const selected = results.filter(v => steps.some(s => stable(s.release) === stable(v.release)));
      const ids = new Set(steps.map(s => s.collector_id));
      const attempts = selected.flatMap(v => v.result.attempts).filter(a => ids.has(a.collector_id));
      const complete = attempts.length > 0 && attempts.every(a => a.status === 'succeeded');
      const rows = selected.flatMap(v => v.result.discovery_rows ?? []).filter(r => ids.has(r.collector_id));
      const unique = new Map<string, { identity: string; name: string; dimensions: Record<string,string> }>();
      for (const row of rows) {
        if (rule.identity_dimensions.some(d => !row.dimensions[d])) throw new Error('DISCOVERY_IDENTITY_UNKNOWN');
        const identity = stable(Object.fromEntries(rule.identity_dimensions.map(d => [d,row.dimensions[d]])));
        const old = unique.get(identity);
        if (old && stable(old.dimensions) !== stable(row.dimensions)) throw new Error('DISCOVERY_DUPLICATE');
        unique.set(identity, { identity, name: row.name.slice(0,512), dimensions: row.dimensions });
      }
      const [previous] = await c.execute<RowDataPacket[]>(
        'SELECT revision,payload FROM metric_discovery_states WHERE resource_key=? AND template_id=? AND rule_id=? FOR UPDATE',
        [key,pin.template_id,rule.rule_id]);
      const prior = previous[0] ? decodeDiscovery(previous[0].payload) : null;
      const members = reconcileDiscovery(rule, prior?.members ?? [], [...unique.values()], now, complete);
      const state: DiscoveryState = { template_version: version.version, content_hash: version.content_hash,
        config_revision: binding.binding.revision, rule, items, triggers: version.aggregate.triggers.filter(t => rule.item_ids.some(id => t.scope === `item:${id}`)), members };
      if (!prior || stable(prior) !== stable(state)) {
        const revision = Number(previous[0]?.revision ?? 0)+1;
        await c.execute(`INSERT INTO metric_discovery_states(resource_key,template_id,rule_id,revision,payload) VALUES(?,?,?,?,?)
          ON DUPLICATE KEY UPDATE revision=VALUES(revision),payload=VALUES(payload)`, [key,pin.template_id,rule.rule_id,revision,JSON.stringify(state)]);
        await c.execute('INSERT INTO metric_discovery_audit(resource_key,template_id,rule_id,payload,recorded_at) VALUES(?,?,?,?,?)',
          [key,pin.template_id,rule.rule_id,JSON.stringify({ actor:'formal-writer', revision, state }),new Date(now)]);
      }
      for (const item of items) {
        const metric = `${item.canonical_metric.id}@${item.canonical_metric.semantic_version}`;
        const dimensions = allowed.get(metric) ?? new Set<string>();
        members.filter(m => m.state === 'active').forEach(m => dimensions.add(stable(m.dimensions)));
        allowed.set(metric, dimensions);
      }
    }
  }
  return allowed;
}

export async function discoveryRows(c: Pick<Pool, 'execute'> | PoolConnection, resourceKey: string) {
  const [rows] = await c.execute<RowDataPacket[]>('SELECT template_id,rule_id,revision,payload FROM metric_discovery_states WHERE resource_key=?', [resourceKey]);
  return rows.map(row => ({ template_id: String(row.template_id), rule_id: String(row.rule_id), revision: Number(row.revision), state: decodeDiscovery(row.payload) }));
}
