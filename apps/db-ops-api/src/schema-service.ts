/**
 * 表结构管理服务 — 从 managed database 采集 information_schema 元数据
 */
import { databaseService } from './database-service.js';
import { instanceDatabaseService } from './instance-database-service.js';
import { schemaDatabaseService, type SchemaChange } from './schema-database-service.js';

class SchemaService {
  /**
   * 采集指定实例的表结构快照
   * PostgreSQL: 自动发现所有用户数据库，逐个库采集
   */
  async collectSchema(instanceId: number): Promise<{ collected: number; tables: number; columns: number } | { error: string }> {
    try {
      const conn = databaseService.getConnection(instanceId);
      if (!conn) {
        return { error: '实例连接不存在，请先连接数据库实例' };
      }

      const instance = await instanceDatabaseService.getInstanceById(instanceId);
      if (!instance) {
        return { error: '实例不存在' };
      }

      let tableSchema: any[];

      if (conn.db_type === 'mysql') {
        const dbName = instance.database_name;
        if (!dbName) return { error: '实例未配置 database_name' };
        if (!conn.pool) return { error: '实例连接池未初始化' };
        tableSchema = await this.collectMySQLSchema(conn.pool, dbName);
      } else if (conn.db_type === 'postgresql') {
        if (!conn.pgClient) return { error: 'PostgreSQL 客户端未初始化' };
        tableSchema = await this.collectAllPGSchemas(instance);
      } else if (conn.db_type === 'dameng') {
        if (!conn.dmConnection) return { error: '达梦连接未初始化' };
        tableSchema = await this.collectDamengSchema(conn.dmConnection, instance.username);
      } else if (conn.db_type === 'oracle') {
        if (!conn.oracleConnection) return { error: 'Oracle 连接未初始化' };
        tableSchema = await this.collectOracleSchema(conn.oracleConnection, instance.username);
      } else {
        return { error: `不支持的数据库类型: ${conn.db_type}` };
      }

      if (!tableSchema || tableSchema.length === 0) {
        return { error: '未找到任何表结构数据' };
      }

      // 保存到快照
      const result = await schemaDatabaseService.saveSnapshot(instanceId, tableSchema);
      if (!result.success) {
        return { error: result.error || '保存快照失败' };
      }

      const distinctTables = new Set(tableSchema.map((r: any) => r.table_name));

      return {
        collected: tableSchema.length,
        tables: distinctTables.size,
        columns: tableSchema.length,
      };
    } catch (error: any) {
      console.error('采集表结构失败:', error);
      return { error: error.message || '采集表结构时发生未知错误' };
    }
  }

  /**
   * MySQL 表结构采集
   */
  private async collectMySQLSchema(pool: any, dbName: string): Promise<any[]> {
    const [tableRows] = await pool.execute(
      `SELECT TABLE_NAME, TABLE_COMMENT, TABLE_ROWS, DATA_LENGTH, INDEX_LENGTH,
              CREATE_TIME, UPDATE_TIME
       FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = ?
       ORDER BY TABLE_NAME`,
      [dbName]
    ) as any;

    if (!Array.isArray(tableRows) || tableRows.length === 0) {
      return [];
    }

    const tableMeta = new Map<string, { table_comment: string; table_rows: number; data_length: number }>();
    for (const row of tableRows) {
      tableMeta.set(row.TABLE_NAME, {
        table_comment: row.TABLE_COMMENT || '',
        table_rows: Number(row.TABLE_ROWS) || 0,
        data_length: Number(row.DATA_LENGTH) || 0,
      });
    }

    const [columnRows] = await pool.execute(
      `SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT,
              COLUMN_KEY, EXTRA, COLUMN_COMMENT, ORDINAL_POSITION
       FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = ?
       ORDER BY TABLE_NAME, ORDINAL_POSITION`,
      [dbName]
    ) as any;

    if (!Array.isArray(columnRows)) {
      return [];
    }

    return columnRows.map((col: any) => {
      const meta = tableMeta.get(col.TABLE_NAME);
      return {
        table_name: col.TABLE_NAME,
        column_name: col.COLUMN_NAME,
        column_type: col.COLUMN_TYPE,
        is_nullable: col.IS_NULLABLE || 'YES',
        column_default: col.COLUMN_DEFAULT,
        column_key: col.COLUMN_KEY || '',
        extra: col.EXTRA || '',
        column_comment: col.COLUMN_COMMENT || null,
        table_comment: meta?.table_comment || null,
        table_rows: meta?.table_rows || 0,
        data_length: meta?.data_length || 0,
      };
    });
  }

  /**
   * PostgreSQL 多库采集
   */
  private async collectAllPGSchemas(instance: any): Promise<any[]> {
    const PgClient = (await import('pg')).Client;
    const allTables: any[] = [];
    const errors: string[] = [];

    // 1. 先连接任意一个可用库发现所有用户数据库
    const discoverClient = new PgClient({
      host: instance.host,
      port: instance.port,
      user: instance.username,
      password: await this.decryptPassword(instance.password_encrypted),
      database: instance.database_name || 'postgres',
      connectionTimeoutMillis: 5000,
    });
    await discoverClient.connect();
    const dbResult = await discoverClient.query(`
      SELECT datname FROM pg_database
      WHERE datistemplate = false
        AND datname NOT IN ('postgres')
      ORDER BY datname
    `);
    await discoverClient.end();

    // 2. 逐个库采集（包含配置的默认库）
    const databases = new Set([instance.database_name || 'postgres', ...dbResult.rows.map((r: any) => r.datname)]);

    for (const dbName of databases) {
      try {
        const client = new PgClient({
          host: instance.host,
          port: instance.port,
          user: instance.username,
          password: await this.decryptPassword(instance.password_encrypted),
          database: dbName,
          connectionTimeoutMillis: 5000,
        });
        await client.connect();

        const tables = await this.collectPGDatabaseSchema(client, dbName);
        allTables.push(...tables);
        await client.end();

        if (tables.length > 0) {
          const tableCount = new Set(tables.map(t => t.table_name)).size;
          console.log(`📋 [PG/${dbName}] 采集 ${tableCount} 张表，${tables.length} 列`);
        }
      } catch (e: any) {
        errors.push(`${dbName}: ${e.message}`);
      }
    }

    if (allTables.length === 0 && errors.length > 0) {
      throw new Error('所有数据库采集失败: ' + errors.join('; '));
    }

    return allTables;
  }

  /**
   * 采集单个 PG 数据库的表结构
   */
  private async collectPGDatabaseSchema(client: any, dbName: string): Promise<any[]> {
    const tableRows = await client.query(`
      SELECT n.nspname as schema_name,
             c.relname as table_name,
             obj_description(c.oid) as table_comment,
             c.reltuples as table_rows,
             pg_total_relation_size(c.oid) as data_length
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname NOT IN ('pg_catalog', 'pg_toast', 'information_schema')
        AND c.relkind = 'r'
      ORDER BY n.nspname, c.relname
    `);

    if (!tableRows.rows || tableRows.rows.length === 0) {
      return [];
    }

    const tableMeta = new Map<string, any>();
    for (const row of tableRows.rows) {
      const key = dbName + '.' + row.schema_name + '.' + row.table_name;
      tableMeta.set(key, {
        schema_name: row.schema_name,
        table_comment: row.table_comment || '',
        table_rows: Number(row.table_rows) || 0,
        data_length: Number(row.data_length) || 0,
      });
    }

    const columnRows = await client.query(`
      SELECT n.nspname as schema_name,
             c.relname as table_name,
             a.attname as column_name,
             format_type(a.atttypid, a.atttypmod) as column_type,
             CASE WHEN a.attnotnull THEN 'NO' ELSE 'YES' END as is_nullable,
             pg_get_expr(d.adbin, d.adrelid) as column_default,
             CASE WHEN pk.contype = 'p' THEN 'PRI'
                  WHEN uk.contype = 'u' THEN 'UNI'
                  ELSE '' END as column_key,
             '' as extra,
             col_description(a.attrelid, a.attnum) as column_comment,
             a.attnum as ordinal_position
      FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      LEFT JOIN LATERAL (
        SELECT con.contype FROM pg_constraint con
        WHERE con.conrelid = c.oid AND con.conkey[1] = a.attnum AND con.contype IN ('p', 'u')
        LIMIT 1
      ) pk ON true
      LEFT JOIN LATERAL (
        SELECT con.contype FROM pg_constraint con
        WHERE con.conrelid = c.oid AND con.conkey[1] = a.attnum AND con.contype = 'u'
        LIMIT 1
      ) uk ON true
      WHERE n.nspname NOT IN ('pg_catalog', 'pg_toast', 'information_schema')
        AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY n.nspname, c.relname, a.attnum
    `);

    if (!columnRows.rows) return [];

    return columnRows.rows.map((col: any) => {
      const key = dbName + '.' + col.schema_name + '.' + col.table_name;
      const meta = tableMeta.get(key);
      return {
        table_name: key,
        column_name: col.column_name,
        column_type: col.column_type,
        is_nullable: col.is_nullable || 'YES',
        column_default: col.column_default,
        column_key: col.column_key || '',
        extra: col.extra || '',
        column_comment: col.column_comment || null,
        table_comment: meta?.table_comment || null,
        table_rows: meta?.table_rows || 0,
        data_length: meta?.data_length || 0,
      };
    });
  }

  /**
   * 达梦表结构采集 — 使用 ALL_TABLES / ALL_TAB_COLUMNS
   */
  private async collectDamengSchema(dmConnection: any, username: string): Promise<any[]> {
    const owner = username.toUpperCase();
    const allColumns: any[] = [];

    // 获取表元数据（行数、大小）
    const tableRows = await dmConnection.execute(`
      SELECT
        t.OWNER, t.TABLE_NAME, t.NUM_ROWS as table_rows,
        NVL(s.bytes, 0) as data_length,
        c.COMMENTS as table_comment
      FROM ALL_TABLES t
      LEFT JOIN DBA_SEGMENTS s ON s.OWNER = t.OWNER AND s.SEGMENT_NAME = t.TABLE_NAME AND s.SEGMENT_TYPE = 'TABLE'
      LEFT JOIN ALL_TAB_COMMENTS c ON c.OWNER = t.OWNER AND c.TABLE_NAME = t.TABLE_NAME
      WHERE t.OWNER = :owner
      ORDER BY t.TABLE_NAME
    `, [owner]);

    if (!tableRows.rows || tableRows.rows.length === 0) {
      return [];
    }

    const tableMeta = new Map<string, { table_comment: string; table_rows: number; data_length: number }>();
    for (const row of tableRows.rows) {
      tableMeta.set(`${row[0]}.${row[1]}`, {
        table_comment: row[4] || '',
        table_rows: Number(row[2]) || 0,
        data_length: Number(row[3]) || 0,
      });
    }

    // 获取主键/唯一约束
    const pkMap = new Map<string, string>();
    try {
      const pkRows = await dmConnection.execute(`
        SELECT a.OWNER, a.TABLE_NAME, a.COLUMN_NAME, c.CONSTRAINT_TYPE
        FROM ALL_CONS_COLUMNS a
        JOIN ALL_CONSTRAINTS c ON c.OWNER = a.OWNER AND c.CONSTRAINT_NAME = a.CONSTRAINT_NAME AND c.TABLE_NAME = a.TABLE_NAME
        WHERE a.OWNER = :owner AND c.CONSTRAINT_TYPE IN ('P', 'U')
        ORDER BY a.POSITION
      `, [owner]);
      for (const row of pkRows.rows) {
        const key = `${row[0]}.${row[1]}.${row[2]}`;
        pkMap.set(key, row[3] === 'P' ? 'PRI' : 'UNI');
      }
    } catch { /* 部分版本可能没有这些视图 */ }

    // 获取列信息
    const colRows = await dmConnection.execute(`
      SELECT
        c.OWNER, c.TABLE_NAME, c.COLUMN_NAME, c.DATA_TYPE,
        c.DATA_LENGTH, c.NULLABLE, c.DATA_DEFAULT, c.COLUMN_ID,
        m.COMMENTS as column_comment
      FROM ALL_TAB_COLUMNS c
      LEFT JOIN ALL_COL_COMMENTS m ON m.OWNER = c.OWNER AND m.TABLE_NAME = c.TABLE_NAME AND m.COLUMN_NAME = c.COLUMN_NAME
      WHERE c.OWNER = :owner
      ORDER BY c.TABLE_NAME, c.COLUMN_ID
    `, [owner]);

    for (const row of colRows.rows) {
      const tableKey = `${row[0]}.${row[1]}`;
      const meta = tableMeta.get(tableKey);
      const colKey = `${row[0]}.${row[1]}.${row[2]}`;
      allColumns.push({
        table_name: tableKey,
        column_name: row[2],
        column_type: row[3] + (row[4] ? `(${row[4]})` : ''),
        is_nullable: row[5] === 'Y' ? 'YES' : 'NO',
        column_default: row[6] || null,
        column_key: pkMap.get(colKey) || '',
        extra: '',
        column_comment: row[8] || null,
        table_comment: meta?.table_comment || null,
        table_rows: meta?.table_rows || 0,
        data_length: meta?.data_length || 0,
      });
    }

    return allColumns;
  }

  /**
   * Oracle 表结构采集 — 使用 ALL_TABLES + ALL_TAB_COLUMNS + 约束视图
   */
  private async collectOracleSchema(oracleConnection: any, username: string): Promise<any[]> {
    const owner = username.toUpperCase();
    const allColumns: any[] = [];

    // DBA_SEGMENTS 可能无权限，降级
    let segJoin = '';
    try {
      await oracleConnection.execute('SELECT 1 FROM DBA_SEGMENTS WHERE ROWNUM = 1');
      segJoin = `LEFT JOIN DBA_SEGMENTS s ON s.OWNER = t.OWNER AND s.SEGMENT_NAME = t.TABLE_NAME AND s.SEGMENT_TYPE = 'TABLE'`;
    } catch { /* 无 DBA 权限时不查询表大小 */ }

    const tableRows = await oracleConnection.execute(`
      SELECT
        t.OWNER, t.TABLE_NAME, t.NUM_ROWS as table_rows,
        0 as data_length,
        c.COMMENTS as table_comment
      FROM ALL_TABLES t
      LEFT JOIN ALL_TAB_COMMENTS c ON c.OWNER = t.OWNER AND c.TABLE_NAME = t.TABLE_NAME
      WHERE t.OWNER = :owner
      ORDER BY t.TABLE_NAME
    `, [owner]);

    if (!tableRows.rows || tableRows.rows.length === 0) {
      return [];
    }

    const tableMeta = new Map<string, { table_comment: string; table_rows: number }>();
    for (const row of tableRows.rows) {
      tableMeta.set(`${row[0]}.${row[1]}`, {
        table_comment: row[4] || '',
        table_rows: Number(row[2]) || 0,
      });
    }

    // 获取主键/唯一约束
    const pkMap = new Map<string, string>();
    try {
      const pkRows = await oracleConnection.execute(`
        SELECT a.OWNER, a.TABLE_NAME, a.COLUMN_NAME, c.CONSTRAINT_TYPE
        FROM ALL_CONS_COLUMNS a
        JOIN ALL_CONSTRAINTS c ON c.OWNER = a.OWNER AND c.CONSTRAINT_NAME = a.CONSTRAINT_NAME AND c.TABLE_NAME = a.TABLE_NAME
        WHERE a.OWNER = :owner AND c.CONSTRAINT_TYPE IN ('P', 'U')
        ORDER BY a.POSITION
      `, [owner]);
      for (const row of pkRows.rows) {
        const key = `${row[0]}.${row[1]}.${row[2]}`;
        pkMap.set(key, row[3] === 'P' ? 'PRI' : 'UNI');
      }
    } catch { /* 约束视图可能无权限 */ }

    // 获取列信息
    const colRows = await oracleConnection.execute(`
      SELECT
        c.OWNER, c.TABLE_NAME, c.COLUMN_NAME, c.DATA_TYPE,
        c.DATA_LENGTH, c.NULLABLE, c.DATA_DEFAULT, c.COLUMN_ID,
        m.COMMENTS as column_comment
      FROM ALL_TAB_COLUMNS c
      LEFT JOIN ALL_COL_COMMENTS m ON m.OWNER = c.OWNER AND m.TABLE_NAME = c.TABLE_NAME AND m.COLUMN_NAME = c.COLUMN_NAME
      WHERE c.OWNER = :owner
      ORDER BY c.TABLE_NAME, c.COLUMN_ID
    `, [owner]);

    for (const row of colRows.rows) {
      const tableKey = `${row[0]}.${row[1]}`;
      const meta = tableMeta.get(tableKey);
      const colKey = `${row[0]}.${row[1]}.${row[2]}`;
      allColumns.push({
        table_name: tableKey,
        column_name: row[2],
        column_type: row[3] + (row[4] ? `(${row[4]})` : ''),
        is_nullable: row[5] === 'Y' ? 'YES' : 'NO',
        column_default: row[6] || null,
        column_key: pkMap.get(colKey) || '',
        extra: '',
        column_comment: row[8] || null,
        table_comment: meta?.table_comment || null,
        table_rows: meta?.table_rows || 0,
        data_length: 0,
      });
    }

    return allColumns;
  }

  /**
   * 解密密码（AES 加密）
   */
  private async decryptPassword(encrypted: string): Promise<string> {
    if (!encrypted) return '';
    try {
      const { createCipheriv, createDecipheriv } = await import('crypto');
      const crypto = await import('crypto');
      // 使用 ENCRYPTION_KEY
      const keyStr = process.env.ENCRYPTION_KEY || 'change-this-to-a-random-32-char-key';
      const key = Buffer.from(keyStr.padEnd(32, '0').substring(0, 32));
      const parts = encrypted.split(':');
      if (parts.length === 2) {
        const iv = Buffer.from(parts[0], 'hex');
        const encryptedText = Buffer.from(parts[1], 'hex');
        const decipher = createDecipheriv('aes-256-cbc', key, iv);
        let decrypted = decipher.update(encryptedText);
        decrypted = Buffer.concat([decrypted, decipher.final()]);
        return decrypted.toString();
      }
    } catch (e) {
      console.error('密码解密失败:', e);
    }
    return '';
  }

  /**
   * 变更检测：对比最近两次快照
   */
  async detectChanges(instanceId: number): Promise<SchemaChange[] | { error: string }> {
    try {
      // 获取快照时间列表
      const snapshotTimes = await schemaDatabaseService.getSnapshotTimes(instanceId, 2);
      if (snapshotTimes.length < 2) {
        return { hint: '需要至少两次快照才能进行变更检测' } as any;
      }

      const [latest, previous] = snapshotTimes;

      // 对比两次快照
      const changes = await schemaDatabaseService.compareWithSnapshot(
        instanceId,
        previous.snapshot_time
      );

      return changes;
    } catch (error: any) {
      console.error('变更检测失败:', error);
      return { error: error.message || '变更检测时发生未知错误' };
    }
  }

  /**
   * 获取当前表的列表
   */
  async getTableList(instanceId: number): Promise<{ table_name: string; table_comment: string | null; table_rows: number; data_length: number; column_count: number }[] | { error: string }> {
    try {
      const tableList = await schemaDatabaseService.getTableList(instanceId);
      if (tableList.length === 0) {
        return { error: '暂无快照数据，请先采集' };
      }
      return tableList;
    } catch (error: any) {
      console.error('获取表列表失败:', error);
      return { error: error.message || '获取表列表时发生未知错误' };
    }
  }

  /**
   * 获取指定表的完整列信息
   */
  async getTableDetail(instanceId: number, tableName: string): Promise<any[] | { error: string }> {
    try {
      const detail = await schemaDatabaseService.getTableDetail(instanceId, tableName);
      if (detail.length === 0) {
        return { error: '表不存在或暂无快照数据' };
      }
      return detail;
    } catch (error: any) {
      console.error('获取表详情失败:', error);
      return { error: error.message || '获取表详情时发生未知错误' };
    }
  }
}

// 单例
export const schemaService = new SchemaService();
