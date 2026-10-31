import { describe, expect, it, vi } from 'vitest';
import { baseline, portOf, thresholdRule } from './test-support.js';
import { resolveTriggerRules } from './resolve.js';
import { compileTriggerSnapshot } from './compile.js';
import { mysqlTriggerCatalog, stageTriggerSnapshot } from './persistence.js';

describe('persistent trigger evidence', () => {
  it('reads only an exact immutable body and rejects corrupted content hashes', async () => {
    const rule = thresholdRule();
    const execute = vi.fn(async () => [[{ payload: JSON.stringify(rule) }], []] as [unknown, unknown]);
    expect(await mysqlTriggerCatalog({ execute }).getVersion(rule.rule_id, 1)).toEqual(rule);
    expect(execute.mock.calls[0]).toEqual([
      'SELECT payload FROM metric_trigger_rule_versions WHERE rule_id = ? AND version = ?', [rule.rule_id, 1],
    ]);
    execute.mockResolvedValueOnce([[{ payload: { ...rule, unit: 'count' } }], []]);
    await expect(mysqlTriggerCatalog({ execute }).getVersion(rule.rule_id, 1)).rejects.toThrow('TRIGGER_RULE_HASH_MISMATCH');
  });

  it('stages the real resolver/compiler snapshot and refuses tampered evidence before SQL', async () => {
    const base = await baseline();
    const candidate = await resolveTriggerRules(base.resolution, base.catalog, portOf([base.version]).port);
    const snapshot = compileTriggerSnapshot({ ...candidate, config_revision: candidate.config_revision + 1 });
    const execute = vi.fn(async () => [{ affectedRows: 1 }, []] as [unknown, unknown]);
    await stageTriggerSnapshot({ execute }, snapshot);
    expect(execute).toHaveBeenCalledTimes(1);
    const payload = JSON.parse((execute.mock.calls[0] as unknown as [string, unknown[]])[1][3] as string);
    expect(payload).toEqual(snapshot);
    expect(payload.applied).toBe(false);
    await expect(stageTriggerSnapshot({ execute }, { ...snapshot, config_revision: 999 })).rejects.toThrow('TRIGGER_SNAPSHOT_HASH_MISMATCH');
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
