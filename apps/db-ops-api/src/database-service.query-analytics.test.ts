import { afterEach, describe, expect, it, vi } from 'vitest';
import { databaseService } from './database-service.js';
const connections = (databaseService as any).connections as Map<number, any>;
afterEach(() => { connections.delete(99537); vi.restoreAllMocks(); });
function install(query: ReturnType<typeof vi.fn>, db_type = 'mysql') {
  connections.set(99537, { id: 99537, connected: true, db_type, pool: { query }, pgClient: { query } });
}
describe('MAX-537 / #669 QAN executable samples', () => {
  it('returns a sample separately from the digest and requires complete SQL in the selected schema', async () => {
    const query = vi.fn().mockResolvedValue([[{ fingerprint: 'SELECT ?', sql_text: 'SELECT 42', calls: 1 }]]); install(query);
    expect(await databaseService.getQueryAnalytics(99537, 5)).toEqual([{ fingerprint: 'SELECT ?', sql_text: 'SELECT 42', calls: 1 }]);
    expect(query.mock.calls[0][0]).toContain('QUERY_SAMPLE_TEXT'); expect(query.mock.calls[0][0]).toContain('OCTET_LENGTH');
    expect(query.mock.calls[0][0]).toContain('SCHEMA_NAME <=> DATABASE()'); expect(query.mock.calls[0][1]).toEqual([5]);
  });
  it.each([null, '', 'SELECT ?', 'SELECT * FROM t WHERE id = ?', 'DELETE FROM t', 'SELECT 1; DROP TABLE t'])('does not expose an unavailable or unsafe sample: %s', async sql_text => {
    install(vi.fn().mockResolvedValue([[{ fingerprint: 'digest', sql_text }]]));
    expect((await databaseService.getQueryAnalytics(99537))![0].sql_text).toBeNull();
  });
  it('preserves a literal question mark without treating it as an unbound parameter', async () => {
    install(vi.fn().mockResolvedValue([[{ fingerprint: 'SELECT ?', sql_text: "SELECT '?'" }]]));
    expect((await databaseService.getQueryAnalytics(99537))![0].sql_text).toBe("SELECT '?'");
  });
  it.each(['ER_BAD_FIELD_ERROR', 'ER_UNKNOWN_SYSTEM_VARIABLE'])('preserves statistics on older MySQL (%s) without using the digest', async code => {
    const query = vi.fn().mockRejectedValueOnce({ code }).mockResolvedValueOnce([[{ fingerprint: 'SELECT ?', sql_text: null, calls: 2 }]]); install(query);
    expect(await databaseService.getQueryAnalytics(99537)).toEqual([{ fingerprint: 'SELECT ?', sql_text: null, calls: 2 }]);
    expect(query.mock.calls[1][0]).toContain('NULL as sql_text');
  });
  it('does not retry privilege failures as version compatibility', async () => {
    const query = vi.fn().mockRejectedValue({ code: 'ER_TABLEACCESS_DENIED_ERROR' }); install(query); vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await databaseService.getQueryAnalytics(99537)).toBeNull(); expect(query).toHaveBeenCalledTimes(1);
  });
  it('does not treat normalized PostgreSQL statements as executable SQL', async () => {
    install(vi.fn().mockResolvedValue({ rows: [{ fingerprint: 'SELECT $1', calls: 1 }] }), 'postgresql');
    expect((await databaseService.getQueryAnalytics(99537))![0].sql_text).toBeNull();
  });
});
