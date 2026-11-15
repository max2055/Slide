import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('./database-service.js', () => ({ databaseService: { getConnection: vi.fn() } }));
vi.mock('./instance-database-service.js', () => ({ instanceDatabaseService: { getInstanceById: vi.fn() } }));
vi.mock('./schema-database-service.js', () => ({ schemaDatabaseService: { saveSnapshot: vi.fn() } }));
import { databaseService } from './database-service.js';
import { instanceDatabaseService } from './instance-database-service.js';
import { schemaDatabaseService } from './schema-database-service.js';
import { schemaService } from './schema-service.js';

let columns: any[][];
let size: number | null;
let denied: number | null;
let execute: ReturnType<typeof vi.fn>;
beforeEach(() => {
  columns = [['APP', 'ITEMS', 'PRICE', 'NUMBER', 22, 'Y', null, 1, null, 10, 2, null, null]];
  size = 196608;
  denied = null;
  execute = vi.fn(async (sql: string, _binds?: any[]) => {
    if (sql.includes('FROM DBA_SEGMENTS')) {
      if (denied) throw Object.assign(new Error('ORA-00942'), { errorNum: denied });
      return { rows: [['APP', 'ITEMS', size]] };
    }
    if (sql.includes('FROM ALL_TABLES')) return { rows: [['APP', 'ITEMS', 1, 0, 'items']] };
    if (sql.includes('FROM ALL_CONS_COLUMNS')) return { rows: [] };
    if (sql.includes('FROM ALL_TAB_COLUMNS')) return { rows: columns };
    throw new Error(`Unexpected query: ${sql}`);
  });
  vi.mocked(databaseService.getConnection).mockReturnValue({ db_type: 'oracle', oracleConnection: { execute } } as any);
  vi.mocked(instanceDatabaseService.getInstanceById).mockResolvedValue({ username: 'app' } as any);
  vi.mocked(schemaDatabaseService.saveSnapshot).mockResolvedValue({ success: true, count: 1 });
});
afterEach(() => vi.restoreAllMocks());
const saved = () => vi.mocked(schemaDatabaseService.saveSnapshot).mock.lastCall![1];

describe('#557 Oracle dictionary type semantics', () => {
  it.each([
    ['NUMBER', 22, 10, 2, null, null, 'NUMBER(10,2)'],
    ['NUMBER', 22, null, null, null, null, 'NUMBER'],
    ['NUMBER', 22, null, 0, null, null, 'NUMBER(*,0)'],
    ['NUMBER', 22, 10, -2, null, null, 'NUMBER(10,-2)'],
    ['FLOAT', 22, 63, null, null, null, 'FLOAT(63)'],
    ['VARCHAR2', 40, null, null, 10, 'C', 'VARCHAR2(10 CHAR)'],
    ['CHAR', 10, null, null, 10, 'B', 'CHAR(10 BYTE)'],
    ['NVARCHAR2', 20, null, null, 10, 'C', 'NVARCHAR2(10)'],
    ['RAW', 32, null, null, null, null, 'RAW(32)'],
    ['DATE', 7, null, null, null, null, 'DATE'],
    ['CLOB', 4000, null, null, null, null, 'CLOB'],
    ['TIMESTAMP(6)', 11, null, 6, null, null, 'TIMESTAMP(6)'],
  ])('%s preserves dictionary parameters (storage bytes %s)', async (type, bytes, precision, scale, chars, semantics, expected) => {
    columns = [['APP', 'ITEMS', 'C', type, bytes, 'Y', null, 1, null, precision, scale, chars, semantics]];
    expect(await schemaService.collectSchema(1)).toMatchObject({ tables: 1 });
    expect(saved()[0].column_type).toBe(expected);
    expect(execute.mock.calls.find(([sql]) => sql.includes('FROM ALL_TAB_COLUMNS'))![0]).toContain('c.DATA_PRECISION');
  });
  it('captures changed precision and scale on the next collection', async () => {
    await schemaService.collectSchema(1);
    expect(saved()[0].column_type).toBe('NUMBER(10,2)');
    columns[0][9] = 12;
    columns[0][10] = 3;
    await schemaService.collectSchema(1);
    expect(saved()[0].column_type).toBe('NUMBER(12,3)');
  });
});
describe('#558 Oracle allocated table segments', () => {
  it('saves actual bytes from an owner-filtered aggregate including partitions', async () => {
    await schemaService.collectSchema(1);
    expect(saved()[0].data_length).toBe(size);
    const query = execute.mock.calls.find(([sql]) => sql.includes('FROM DBA_SEGMENTS'))!;
    expect(query[0]).toContain('SUM(BYTES)');
    expect(query[0]).toContain("'TABLE PARTITION'");
    expect(query[1]).toEqual(['APP']);
  });
  it('preserves measured zero for a table without allocated segments', async () => {
    execute.mockImplementationOnce(async () => ({ rows: [] }));
    await schemaService.collectSchema(1);
    expect(saved()[0].data_length).toBe(0);
  });
  it.each([942, 1031])('persists null when dictionary access fails with ORA-%s', async (code) => {
    denied = code;
    await schemaService.collectSchema(1);
    expect(saved()[0].data_length).toBeNull();
  });
  it('fails without saving a snapshot on a connection error, then recovers explicitly', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    execute.mockRejectedValueOnce(Object.assign(new Error('ORA-03113'), { errorNum: 3113 }));
    vi.mocked(schemaDatabaseService.saveSnapshot).mockClear();
    expect(await schemaService.collectSchema(1)).toEqual({ error: 'ORA-03113' });
    expect(schemaDatabaseService.saveSnapshot).not.toHaveBeenCalled();
    expect(await schemaService.collectSchema(1)).toMatchObject({ tables: 1 });
  });
});
