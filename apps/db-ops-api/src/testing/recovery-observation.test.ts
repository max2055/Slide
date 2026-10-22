import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { recoveryObservation, safeSqlLabel } from './recovery-observation.js';
const database = `investigation_test_${process.pid}_${'a'.repeat(32)}`;
let directory: string;
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); if (directory) rmSync(directory, { force: true, recursive: true }); });
function setup() {
  directory = mkdtempSync(join(tmpdir(), 'recovery-observer-'));
  vi.stubEnv('RECOVERY_OBSERVATION_DIR', directory);
  vi.stubEnv('RECOVERY_OBSERVATION_COMMIT', 'b'.repeat(40));
  return recoveryObservation(database);
}
function events() { return readdirSync(directory).filter(f => f.endsWith('.jsonl')).flatMap(f => readFileSync(join(directory, f), 'utf8').trim().split('\n').map(line => JSON.parse(line))); }
describe('qualification SQL observation', () => {
  it('labels operations without leaking SQL, bindings, object names or error messages', async () => {
    const observer = setup();
    const error = Object.assign(new Error('secret-error'), { code: 'ER_BAD_FIELD_ERROR' });
    const raw = { query: vi.fn().mockRejectedValue(error) };
    await expect(observer.wrap(raw).query('SELECT secret_column FROM secret_table WHERE password=?', ['secret-value'])).rejects.toBe(error);
    observer.finish();
    const text = JSON.stringify(events());
    expect(text).not.toContain('secret');
    expect(text).toContain('ER_BAD_FIELD_ERROR');
    expect(safeSqlLabel('/* sensitive */ SELECT GET_LOCK(?, 10)')).toBe('migration-lock-acquire');
    expect(safeSqlLabel('call sensitive_procedure()')).toBe('other');
    expect(safeSqlLabel({ sql: 'INSERT INTO private_table VALUES (?)' })).toBe('insert');
  });
  it('pairs concurrent operations by id and preserves response identity and connection methods', async () => {
    const observer = setup();
    let release!: (value: object) => void;
    const result = {};
    const raw = { query: vi.fn().mockImplementationOnce(() => new Promise(resolve => { release = resolve; })).mockResolvedValueOnce(result), end: vi.fn(), getConnection: vi.fn() };
    raw.getConnection.mockResolvedValue(raw);
    const pool = observer.wrap(raw);
    const first = pool.query('SELECT 1');
    expect(await pool.query('SELECT 2')).toBe(result);
    expect(await pool.getConnection()).toBe(pool);
    release(result); expect(await first).toBe(result);
    pool.end(); expect(raw.end).toHaveBeenCalledOnce();
    observer.finish();
    const sql = events().filter(e => e.kind === 'sql');
    expect(sql.map(e => [e.event, e.id])).toEqual([['begin', 1], ['begin', 2], ['end', 2], ['end', 1]]);
  });
  it('retains unfinished calls and stage failures without modifying their rejection', async () => {
    const observer = setup();
    const raw = { query: (_sql: string) => new Promise(() => {}) };
    void observer.wrap(raw).query('SELECT sensitive');
    const failure = new Error('private');
    await expect(observer.stage('migration-1', async () => { throw failure; })).rejects.toBe(failure);
    observer.finish();
    expect(events().at(-1).pending).toMatchObject([{ id: 1, label: 'select' }]);
  });
  it('fails observation errors without changing a successful SQL result', async () => {
    const observer = setup();
    rmSync(directory, { recursive: true });
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const value = {};
    expect(await observer.wrap({ query: async () => value }).query()).toBe(value);
    expect(() => observer.finish()).toThrow('could not be written');
    expect(stderr).toHaveBeenCalledWith('RECOVERY_OBSERVATION_WRITE_FAILED\n');
  });
  it('waits for a cleanup snapshot acknowledgement before permitting DB deletion', async () => {
    const observer = setup();
    const waiting = observer.beforeCleanup();
    expect(readFileSync(join(directory, `cleanup-${process.pid}`), 'utf8')).toBe(database);
    writeFileSync(join(directory, `cleanup-${process.pid}.ack`), 'captured');
    await waiting;
    observer.finish();
  });
  it('is inert when qualification observation is disabled and rejects unsafe identity when enabled', async () => {
    vi.stubEnv('RECOVERY_OBSERVATION_DIR', '');
    const raw = { query: vi.fn().mockResolvedValue(1) };
    expect(recoveryObservation('anything').wrap(raw)).toBe(raw);
    setup(); expect(() => recoveryObservation('production')).toThrow('identity');
  });
});
