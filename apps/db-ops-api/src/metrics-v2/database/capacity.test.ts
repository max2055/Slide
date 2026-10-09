import { describe, expect, it, vi } from 'vitest';
import { capacityDefinition, capacityReads, capacityReleases, createDatabaseRegistry, databaseReleases, implementationId } from './catalog.js';
import { bindDatabaseDriver, collectDatabase } from './collector.js';
import { builtinReleases } from '../packages/builtins.js';
import { PackageRegistry } from '../packages/model.js';
describe('database capacity contracts', () => {
  it('adds releases without replacing old pins and keeps scope-specific identities', () => {
    const registry = createDatabaseRegistry();
    for (const r of [...builtinReleases(), ...databaseReleases(), ...capacityReleases()]) {
      expect(registry.get(r.package).package.digest).toBe(r.package.digest);
    }
    expect(capacityReleases().map(r => [r.package.id, r.package.version])).toEqual([
      ['mysql-basic', '1.1.0'], ['oracle-representative', '1.1.0'], ['dameng-representative', '1.1.0'],
    ]);
    expect(new Set(capacityReads.map(r => r.fields[0].definition.id)).size).toBe(4);
    expect(capacityDefinition('redis')).toBeUndefined();
    expect(capacityReads.every(r => r.fields[0].definition.unit === 'By')).toBe(true);
    expect(registry).toBeInstanceOf(PackageRegistry);
  });
  it.each(capacityReads)('reads exact unrounded $engine bytes in one fixed SQL', async read => {
    const execute = vi.fn(async () => ({ rows: read.shape === 'array' ? [['9007199254740993']] : [{ bytes: '9007199254740993', database: 'orders' }] }));
    const rows = await collectDatabase(implementationId(read), bindDatabaseDriver(execute), {}, 5000);
    expect(rows[0].fields.bytes).toEqual({ encoding: 'uint64', value: '9007199254740993' });
    expect(execute).toHaveBeenCalledExactlyOnceWith(read.sql, 5000);
    expect(rows[0].dimensions).toEqual(read.database ? { database: 'orders' } : {});
    expect(rows[0].accuracy?.bytes).toBe(read.engine === 'mysql' ? 'estimated' : undefined);
    expect(read.sql).not.toMatch(/ROUND|1024/);
  });
  it.each(capacityReads)('preserves $engine NULL and permission failures', async read => {
    const rows = await collectDatabase(implementationId(read), bindDatabaseDriver(async () => ({ rows: read.shape === 'array' ? [[null]] : [{ bytes: null, database: 'orders' }] })), {}, 5000);
    expect(rows[0].fields.bytes).toBeNull();
    await expect(collectDatabase(implementationId(read), bindDatabaseDriver(async () => { throw Object.assign(new Error('private'), { code: 'EACCES' }); }), {}, 5000)).rejects.toMatchObject({ code: 'permission_denied' });
  });
});
