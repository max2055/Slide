/**
 * 索引管理服务 — 从 managed database 采集索引信息，检测冗余和未使用索引
 */
import { databaseService } from './database-service.js';
import { instanceDatabaseService } from './instance-database-service.js';
import { dbConnection } from './db-connection.js';
import {
  indexDatabaseService,
  type IndexEntry,
  type RedundantIndexReport,
} from './index-database-service.js';

export interface RedundantIndex {
  redundant: {
    tableName: string;
    indexName: string;
    columns: string[];
    nonUnique: boolean;
  };
  coveredBy: {
    tableName: string;
    indexName: string;
    columns: string[];
    nonUnique: boolean;
  };
  reason: string;
}

class IndexService {
  /**
   * 采集指定实例的索引信息
   * PostgreSQL: 自动发现所有用户数据库，逐个库采集
   */
  async collectIndexes(
    instanceId: number
  ): Promise<{ collected: number; indexes: number; tables: number } | { error: string }> {
    try {
      const conn = databaseService.getConnection(instanceId);
      if (!conn) {
        return { error: '实例连接不存在，请先连接数据库实例' };
      }

      const instance = await instanceDatabaseService.getInstanceById(instanceId);
      if (!instance) {
        return { error: '实例不存在' };
      }

      let indexEntries: IndexEntry[];

      if (conn.db_type === 'mysql') {
        const dbName = instance.database_name;
        if (!dbName) return { error: '实例未配置 database_name' };
        if (!conn.pool) return { error: '实例连接池未初始化' };
        indexEntries = await this.collectMySQLIndexes(conn.pool, dbName);
      } else if (conn.db_type === 'postgresql') {
        indexEntries = await this.collectAllPGIndexes(instance);
      } else if (conn.db_type === 'dameng') {
        if (!conn.dmConnection) return { error: '达梦连接未初始化' };
        indexEntries = await this.collectDamengIndexes(conn.dmConnection, instance.username);
      } else if (conn.db_type === 'oracle') {
        if (!conn.oracleConnection) return { error: 'Oracle 连接未初始化' };
        indexEntries = await this.collectOracleIndexes(conn.oracleConnection, instance.username);
      } else {
        return { error: `不支持的数据库类型: ${conn.db_type}` };
      }

      if (!indexEntries || indexEntries.length === 0) {
        return { error: '未找到任何索引数据' };
      }

      // 保存到数据库
      const result = await indexDatabaseService.saveIndexData(instanceId, indexEntries);
      if (!result.success) {
        return { error: result.error || '保存索引数据失败' };
      }

      const distinctIndexes = new Set<string>();
      const distinctTables = new Set<string>();
      for (const entry of indexEntries) {
        distinctIndexes.add(`${entry.table_name}.${entry.index_name}`);
        distinctTables.add(entry.table_name);
      }

      return {
        collected: indexEntries.length,
        indexes: distinctIndexes.size,
        tables: distinctTables.size,
      };
    } catch (error: any) {
      console.error('采集索引失败:', error);
      return { error: error.message || '采集索引时发生未知错误' };
    }
  }

  /**
   * MySQL 索引采集
   */
  private async collectMySQLIndexes(pool: any, dbName: string): Promise<IndexEntry[]> {
    const [rows] = await pool.execute(
      `SELECT TABLE_NAME, INDEX_NAME, NON_UNIQUE, SEQ_IN_INDEX, COLUMN_NAME,
              CARDINALITY, SUB_PART, NULLABLE, INDEX_TYPE, COMMENT
       FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA = ?
       ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`,
      [dbName]
    ) as any;

    if (!Array.isArray(rows) || rows.length === 0) {
      return [];
    }

    return rows.map((row: any) => ({
      table_name: row.TABLE_NAME,
      index_name: row.INDEX_NAME,
      column_name: row.COLUMN_NAME,
      seq_in_index: Number(row.SEQ_IN_INDEX) || 0,
      non_unique: Number(row.NON_UNIQUE) ?? 1,
      cardinality: Number(row.CARDINALITY) || 0,
      sub_part: row.SUB_PART ? Number(row.SUB_PART) : null,
      nullable: row.NULLABLE || 'YES',
      index_type: row.INDEX_TYPE || 'BTREE',
      comment: row.COMMENT || null,
    }));
  }

  /**
   * PostgreSQL 多库索引采集
   */
  private async collectAllPGIndexes(instance: any): Promise<IndexEntry[]> {
    const PgClient = (await import('pg')).Client;
    const allIndexes: IndexEntry[] = [];

    // 发现所有用户数据库
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

        const indexes = await this.collectPGDatabaseIndexes(client, dbName);
        allIndexes.push(...indexes);
        await client.end();

        if (indexes.length > 0) {
          const tableCount = new Set(indexes.map(i => i.table_name)).size;
          const idxCount = new Set(indexes.map(i => i.index_name)).size;
          console.log(`📇 [PG/${dbName}] 采集 ${tableCount} 张表，${idxCount} 个索引`);
        }
      } catch (e: any) {
        console.error(`[PG/${dbName}] 索引采集失败:`, e.message);
      }
    }

    return allIndexes;
  }

  /**
   * 采集单个 PG 数据库的索引
   */
  private async collectPGDatabaseIndexes(client: any, dbName: string): Promise<IndexEntry[]> {
    const idxRows = await client.query(`
      SELECT
        n.nspname as schema_name,
        t.relname as table_name,
        i.relname as index_name,
        ix.indisunique as non_unique,
        a.attname as column_name,
        ix.indisvalid as is_valid,
        am.amname as index_type,
        a.attnum as ordinal_position,
        array_position(ix.indkey, a.attnum) as seq
      FROM pg_index ix
      JOIN pg_class t ON t.oid = ix.indrelid
      JOIN pg_class i ON i.oid = ix.indexrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(ix.indkey)
      JOIN pg_am am ON am.oid = i.relam
      WHERE n.nspname NOT IN ('pg_catalog', 'pg_toast', 'information_schema')
      ORDER BY n.nspname, t.relname, i.relname, array_position(ix.indkey, a.attnum)
    `);

    if (!idxRows.rows || idxRows.rows.length === 0) {
      return [];
    }

    return idxRows.rows.map((row: any) => ({
      table_name: dbName + '.' + row.schema_name + '.' + row.table_name,
      index_name: row.index_name,
      column_name: row.column_name,
      seq_in_index: row.seq || 1,
      non_unique: row.non_unique ? 0 : 1,
      cardinality: 0,
      sub_part: null,
      nullable: 'YES',
      index_type: row.index_type || 'btree',
      comment: row.is_valid ? null : 'invalid',
    }));
  }

  /**
   * 解密密码
   */
  private async decryptPassword(encrypted: string): Promise<string> {
    if (!encrypted) return '';
    try {
      const crypto = await import('crypto');
      const keyStr = process.env.ENCRYPTION_KEY || 'change-this-to-a-random-32-char-key';
      const key = Buffer.from(keyStr.padEnd(32, '0').substring(0, 32));
      const parts = encrypted.split(':');
      if (parts.length === 2) {
        const iv = Buffer.from(parts[0], 'hex');
        const encryptedText = Buffer.from(parts[1], 'hex');
        const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
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
   * 冗余索引检测 — 识别前缀包含关系
   */
  async detectRedundantIndexes(
    instanceId: number
  ): Promise<RedundantIndex[] | { error: string }> {
    try {
      const indexRows = await indexDatabaseService.getIndexesByInstance(instanceId);
      if (indexRows.length === 0) {
        return { error: '暂无索引数据，请先采集' };
      }

      // 按 table_name 分组
      const tableMap = new Map<string, Map<string, { columns: string[]; nonUnique: number; subParts: (number | null)[] }>>();

      for (const row of indexRows) {
        if (!tableMap.has(row.table_name)) {
          tableMap.set(row.table_name, new Map());
        }
        const indexMap = tableMap.get(row.table_name)!;
        if (!indexMap.has(row.index_name)) {
          indexMap.set(row.index_name, { columns: [], nonUnique: row.non_unique, subParts: [] });
        }
        const idx = indexMap.get(row.index_name)!;
        idx.columns[row.seq_in_index - 1] = row.column_name;
        idx.subParts[row.seq_in_index - 1] = row.sub_part;
      }

      const redundantList: RedundantIndex[] = [];

      for (const [tableName, indexMap] of tableMap) {
        const indexes = Array.from(indexMap.entries()).map(([name, data]) => ({
          indexName: name,
          tableName,
          columns: data.columns.filter(Boolean),
          nonUnique: data.nonUnique,
          subParts: data.subParts,
        }));

        // 对每个索引对做前缀匹配检测
        for (let i = 0; i < indexes.length; i++) {
          for (let j = 0; j < indexes.length; j++) {
            if (i === j) continue;

            const a = indexes[i];
            const b = indexes[j];

            // 排除 PRIMARY KEY 和 UNIQUE 索引作为被冗余的目标
            if (a.indexName === 'PRIMARY' || a.nonUnique === 0) continue;

            // 跳过 UNIQUE 索引作为覆盖者（不认为 UNIQUE 覆盖普通索引是冗余）
            if (b.nonUnique === 0) continue;

            // a 的列数必须少于 b 的列数
            if (a.columns.length >= b.columns.length) continue;

            // 检查前缀匹配 + SUB_PART 匹配
            if (
              this.isPrefixWithSubPart(a.columns, b.columns, a.subParts, b.subParts)
            ) {
              // 检查是否已经记录过这个冗余对
              const alreadyExists = redundantList.some(
                (r) =>
                  r.redundant.tableName === tableName &&
                  r.redundant.indexName === a.indexName &&
                  r.coveredBy.indexName === b.indexName
              );

              if (!alreadyExists) {
                const aCols = a.columns.join(', ');
                const bCols = b.columns.join(', ');
                redundantList.push({
                  redundant: {
                    tableName,
                    indexName: a.indexName,
                    columns: a.columns,
                    nonUnique: a.nonUnique === 1,
                  },
                  coveredBy: {
                    tableName,
                    indexName: b.indexName,
                    columns: b.columns,
                    nonUnique: b.nonUnique === 1,
                  },
                  reason: `索引 \`${a.indexName}\` (${aCols}) 的列是 \`${b.indexName}\` (${bCols}) 的前缀，可以被覆盖`,
                });
              }
            }
          }
        }
      }

      // 保存结果到 index_redundancy_report 表
      if (redundantList.length > 0) {
        const reports: RedundantIndexReport[] = redundantList.map((r) => ({
          instance_id: instanceId,
          table_name: r.redundant.tableName,
          redundant_index: r.redundant.indexName,
          covered_by_index: r.coveredBy.indexName,
          reason: r.reason,
        }));

        await indexDatabaseService.saveRedundancyReport(reports);
      }

      return redundantList;
    } catch (error: any) {
      console.error('冗余检测失败:', error);
      return { error: error.message || '冗余检测时发生未知错误' };
    }
  }

  /**
   * 检查较短列数组是否是较长列数组的前缀，同时考虑 SUB_PART
   */
  private isPrefixWithSubPart(
    shorter: string[],
    longer: string[],
    shorterSubParts: (number | null)[],
    longerSubParts: (number | null)[]
  ): boolean {
    if (shorter.length >= longer.length) return false;

    for (let i = 0; i < shorter.length; i++) {
      if (shorter[i] !== longer[i]) return false;

      // 检查 SUB_PART：只有前缀长度匹配或都是完整列索引才算冗余
      const sSub = shorterSubParts[i];
      const lSub = longerSubParts[i];
      if (sSub !== null || lSub !== null) {
        // 如果任一有前缀索引长度，必须相等才算冗余
        if (sSub !== lSub) return false;
      }
    }

    return true;
  }

  /**
   * 未使用索引检测 — 基于 performance_schema
   */
  async detectUnusedIndexes(
    instanceId: number
  ): Promise<{ table_name: string; index_name: string }[] | { error: string }> {
    try {
      const conn = databaseService.getConnection(instanceId);
      if (!conn) {
        return { error: '实例连接不存在，请先连接数据库实例' };
      }

      const instance = await instanceDatabaseService.getInstanceById(instanceId);
      if (!instance) {
        return { error: '实例不存在' };
      }

      const dbName = instance.database_name;
      if (!dbName) {
        return { error: '实例未配置 database_name' };
      }

      let unusedIndexes: { table_name: string; index_name: string }[];

      if (conn.db_type === 'mysql') {
        if (!conn.pool) return { error: '实例连接池未初始化' };

        const [rows] = await conn.pool.execute(
          `SELECT object_schema, object_name, index_name
           FROM performance_schema.table_io_waits_summary_by_index_usage
           WHERE object_schema = ?
             AND index_name IS NOT NULL
             AND index_name != 'PRIMARY'
             AND count_star = 0`,
          [dbName]
        ) as any;

        if (!Array.isArray(rows) || rows.length === 0) {
          await this.markUnusedIndexes(instanceId, []);
          return [];
        }

        unusedIndexes = rows.map((row: any) => ({
          table_name: row.object_name,
          index_name: row.index_name,
        }));
      } else if (conn.db_type === 'postgresql') {
        if (!conn.pgClient) return { error: 'PostgreSQL 客户端未初始化' };

        // PostgreSQL: 使用 pg_stat_user_indexes 查找 idx_scan = 0 的索引
        const rows = await conn.pgClient.query(`
          SELECT relname as table_name, indexrelname as index_name
          FROM pg_stat_user_indexes
          WHERE idx_scan = 0
            AND indexrelname NOT LIKE '%_pkey'
          ORDER BY relname, indexrelname
        `);

        if (!rows.rows || rows.rows.length === 0) {
          await this.markUnusedIndexes(instanceId, []);
          return [];
        }

        unusedIndexes = rows.rows.map((row: any) => ({
          table_name: row.table_name,
          index_name: row.index_name,
        }));
      } else if (conn.db_type === 'oracle' || conn.db_type === 'dameng') {
        // Oracle/Dameng: 未使用索引检测需先启用 MONITORING，暂返回空
        unusedIndexes = [];
      } else {
        return { error: `不支持的数据库类型: ${conn.db_type}` };
      }

      await this.markUnusedIndexes(instanceId, unusedIndexes);

      return unusedIndexes;
    } catch (error: any) {
      console.error('未使用索引检测失败:', error);
      return { error: error.message || '未使用索引检测时发生未知错误' };
    }
  }

  /**
   * 标记未使用索引
   */
  private async markUnusedIndexes(
    instanceId: number,
    unusedIndexes: { table_name: string; index_name: string }[]
  ): Promise<void> {
    const pool = dbConnection.getPool();
    if (!pool) return;

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      // 先将该实例的所有索引标记为未未使用
      await conn.execute(
        'UPDATE index_info SET is_unused = FALSE WHERE instance_id = ?',
        [instanceId]
      );

      // 再将未使用的索引标记为 TRUE
      if (unusedIndexes.length > 0) {
        for (const idx of unusedIndexes) {
          await conn.execute(
            `UPDATE index_info SET is_unused = TRUE
             WHERE instance_id = ? AND table_name = ? AND index_name = ?`,
            [instanceId, idx.table_name, idx.index_name]
          );
        }
      }
      await conn.commit();
    } catch (error) {
      await conn.rollback();
      console.error('标记未使用索引失败:', error);
    } finally {
      conn.release();
    }
  }

  /**
   * 达梦索引采集 — 使用 ALL_INDEXES / ALL_IND_COLUMNS
   */
  private async collectDamengIndexes(dmConnection: any, username: string): Promise<IndexEntry[]> {
    const owner = username.toUpperCase();
    const entries: IndexEntry[] = [];

    const result = await dmConnection.execute(`
      SELECT
        i.TABLE_NAME, i.INDEX_NAME, i.INDEX_TYPE, i.UNIQUENESS,
        c.COLUMN_NAME, c.COLUMN_POSITION,
        NVL(i.NUM_ROWS, 0) as num_rows,
        NVL(s.BYTES, 0) as index_size
      FROM ALL_INDEXES i
      JOIN ALL_IND_COLUMNS c ON c.INDEX_OWNER = i.OWNER AND c.INDEX_NAME = i.INDEX_NAME AND c.TABLE_NAME = i.TABLE_NAME
      LEFT JOIN DBA_SEGMENTS s ON s.OWNER = i.OWNER AND s.SEGMENT_NAME = i.INDEX_NAME AND s.SEGMENT_TYPE = 'INDEX'
      WHERE i.OWNER = :owner
      ORDER BY i.TABLE_NAME, i.INDEX_NAME, c.COLUMN_POSITION
    `, [owner]);

    for (const row of result.rows) {
      const isUnique = row[3] === 'UNIQUE' ? 0 : 1;
      entries.push({
        table_name: `${owner}.${row[0]}`,
        index_name: row[1] as string,
        column_name: row[4] as string,
        seq_in_index: Number(row[5]) || 1,
        non_unique: isUnique,
        cardinality: Number(row[6]) || 0,
        sub_part: null,
        nullable: 'YES',
        index_type: row[2] as string,
        comment: isUnique === 0 ? 'UNIQUE' : null,
      });
    }

    return entries;
  }

  /**
   * Oracle 索引采集 — 使用 ALL_INDEXES + ALL_IND_COLUMNS
   */
  private async collectOracleIndexes(oracleConnection: any, username: string): Promise<IndexEntry[]> {
    const owner = username.toUpperCase();
    const entries: IndexEntry[] = [];

    // DBA_SEGMENTS 可能无权限，降级查询
    let indexSizeSql: string;
    try {
      await oracleConnection.execute('SELECT 1 FROM DBA_SEGMENTS WHERE ROWNUM = 1');
      indexSizeSql = `LEFT JOIN DBA_SEGMENTS s ON s.OWNER = i.OWNER AND s.SEGMENT_NAME = i.INDEX_NAME AND s.SEGMENT_TYPE = 'INDEX'`;
    } catch {
      indexSizeSql = '';  // 无 DBA 权限时不查询索引大小
    }

    const result = await oracleConnection.execute(`
      SELECT
        i.TABLE_NAME, i.INDEX_NAME, i.INDEX_TYPE, i.UNIQUENESS,
        c.COLUMN_NAME, c.COLUMN_POSITION,
        0 as num_rows
      FROM ALL_INDEXES i
      JOIN ALL_IND_COLUMNS c ON c.INDEX_OWNER = i.OWNER AND c.INDEX_NAME = i.INDEX_NAME AND c.TABLE_NAME = i.TABLE_NAME
      WHERE i.OWNER = :owner
      ORDER BY i.TABLE_NAME, i.INDEX_NAME, c.COLUMN_POSITION
    `, [owner]);

    for (const row of result.rows) {
      const isUnique = row[3] === 'UNIQUE' ? 0 : 1;
      entries.push({
        table_name: `${owner}.${row[0]}`,
        index_name: row[1] as string,
        column_name: row[4] as string,
        seq_in_index: Number(row[5]) || 1,
        non_unique: isUnique,
        cardinality: 0,
        sub_part: null,
        nullable: 'YES',
        index_type: row[2] as string,
        comment: isUnique === 0 ? 'UNIQUE' : null,
      });
    }

    return entries;
  }
}

// 单例
export const indexService = new IndexService();
