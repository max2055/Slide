import type { BindingSqlConnection } from '../bindings/mysql-host.js';
import type { TriggerRuleCatalogPort } from './resolve.js';
import { TriggerRuleVersionSchema, type TriggerResourceSnapshot } from '../../contracts/metrics/triggers.js';
import { triggerRuleContentHash } from './model.js';
import { verifyTriggerSnapshot } from './compile.js';

const decode = (value: unknown) => typeof value === 'string' ? JSON.parse(value) : value;

/** Fixed versions only. Publication never updates the body of an existing version. */
export function mysqlTriggerCatalog(connection: Pick<BindingSqlConnection, 'execute'>): TriggerRuleCatalogPort {
  return { async getVersion(ruleId, version) {
    const [result] = await connection.execute(
      'SELECT payload FROM metric_trigger_rule_versions WHERE rule_id = ? AND version = ?', [ruleId, version]);
    const rows = result as Array<{ payload: unknown }>;
    if (!rows.length) return null;
    const parsed = TriggerRuleVersionSchema.parse(decode(rows[0].payload));
    const { content_hash, ...body } = parsed;
    if (content_hash !== triggerRuleContentHash(body)) throw new Error('TRIGGER_RULE_HASH_MISMATCH');
    return parsed;
  } };
}

/** The binding host owns the transaction, authorization and commit. */
export async function stageTriggerSnapshot(connection: Pick<BindingSqlConnection, 'execute'>,
  input: TriggerResourceSnapshot): Promise<void> {
  const snapshot = verifyTriggerSnapshot(input);
  await connection.execute(`INSERT INTO metric_trigger_snapshots
    (resource_key, config_revision, snapshot_hash, payload) VALUES (?, ?, ?, ?)`,
  [`${snapshot.resource.type}:${snapshot.resource.id}`, snapshot.config_revision,
    snapshot.snapshot_hash, JSON.stringify(snapshot)]);
}
