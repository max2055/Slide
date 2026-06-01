/**
 * 表结构管理数据库服务
 */
import mysql from 'mysql2/promise';
import { dbConnection } from './db-connection';

export interface TableSchemaRow {
  table_name: string;
  column_name: string;
  column_type: string;
  is_nullable: string;
  column_default: string | null;
  column_key: string;
  extra: string;
  column_comment: string | null;
  table_comment: string | null;
  table_rows: number;
  data_length: number;
}

export interface SchemaChange {
  type: 'added' | 'modified' | 'deleted';
  target: 'table' | 'column';
  table_name: string;
  column_name?: string;
  details?: Record<string, { old: any; new: any }>;
  detected_at: Date;
}

class SchemaDatabaseService {
  private getPool(): mysql.Pool | null {
    return dbConnection.getPool();
  }

  private isConnected(): boolean {
    return dbConnection.isConnected();
  }

  /**
   * 保存表结构快照（幂等：先删后插）
   */
  async saveSnapshot(
    instanceId: number,
    tableSchema: TableSchemaRow[]
  ): Promise<{ success: boolean; count: number; error?: string }> {
    const pool = this.getPool();
    if (!pool) {
      return { success: false, count: 0, error: '数据库未连接' };
    }

    if (tableSchema.length === 0) {
      return { success: false, count: 0, error: '快照数据为空' };
    }

    try {
      // 先删除该实例当前的旧记录（同一 snapshot_time 幂等）
      const snapshotTime = new Date();
      await pool.execute(
        'DELETE FROM schema_snapshots WHERE instance_id = ? AND snapshot_time = ?',
        [instanceId, snapshotTime]
      );

      // 批量插入
      const values = tableSchema.map((row) => [
        instanceId,
        snapshotTime,
        row.table_name,
        row.column_name,
        row.column_type,
        row.is_nullable || 'YES',
        row.column_default,
        row.column_key || '',
        row.extra || '',
        row.column_comment,
        row.table_comment,
        row.table_rows || 0,
        row.data_length || 0,
      ]);

      const placeholders = values.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ');
      const flatValues = values.flat();

      await pool.execute(
        `INSERT INTO schema_snapshots
         (instance_id, snapshot_time, table_name, column_name, column_type,
          is_nullable, column_default, column_key, extra, column_comment,
          table_comment, table_rows, data_length)
         VALUES ${placeholders}`,
        flatValues
      );

      return { success: true, count: tableSchema.length };
    } catch (error: any) {
      console.error('保存表结构快照失败:', error);
      return { success: false, count: 0, error: error.message };
    }
  }

  /**
   * 获取最新一次快照的所有记录
   */
  async getLatestSnapshot(instanceId: number): Promise<TableSchemaRow[]> {
    const pool = this.getPool();
    if (!pool) {
      return [];
    }

    try {
      const [rows] = await pool.execute(
        `SELECT table_name, column_name, column_type, is_nullable,
                column_default, column_key, extra, column_comment,
                table_comment, table_rows, data_length
         FROM schema_snapshots
         WHERE instance_id = ?
           AND snapshot_time = (
             SELECT MAX(snapshot_time) FROM schema_snapshots WHERE instance_id = ?
           )
         ORDER BY table_name, column_name`,
        [instanceId, instanceId]
      ) as any;

      return rows as TableSchemaRow[];
    } catch (error) {
      console.error('获取最新快照失败:', error);
      return [];
    }
  }

  /**
   * 获取快照时间列表
   */
  async getSnapshotTimes(instanceId: number, limit: number = 10): Promise<{ snapshot_time: Date; tables: number; columns: number }[]> {
    const pool = this.getPool();
    if (!pool) {
      return [];
    }

    try {
      const [rows] = await pool.execute(
        `SELECT snapshot_time,
                COUNT(DISTINCT table_name) as tables,
                COUNT(*) as columns
         FROM schema_snapshots
         WHERE instance_id = ?
         GROUP BY snapshot_time
         ORDER BY snapshot_time DESC
         LIMIT ${Number(limit)}`,
        [instanceId]
      ) as any;

      return rows.map((row: any) => ({
        snapshot_time: new Date(row.snapshot_time),
        tables: Number(row.tables),
        columns: Number(row.columns),
      }));
    } catch (error) {
      console.error('获取快照时间列表失败:', error);
      return [];
    }
  }

  /**
   * Compare columns in a specific historical snapshot against the latest snapshot.
   * @param sinceTime - EXACT snapshot_time to compare against (must match an existing snapshot)
   */
  async compareWithSnapshot(instanceId: number, sinceTime: Date): Promise<SchemaChange[]> {
    const pool = this.getPool();
    if (!pool) {
      return [];
    }

    try {
      // 获取目标时间的快照
      const [sinceRows] = await pool.execute(
        `SELECT table_name, column_name, column_type, column_key, column_default, is_nullable, extra, column_comment
         FROM schema_snapshots
         WHERE instance_id = ? AND snapshot_time = ?
         ORDER BY table_name, column_name`,
        [instanceId, sinceTime]
      ) as any;

      // 获取最新快照
      const latest = await this.getLatestSnapshot(instanceId);
      if (latest.length === 0) {
        return [];
      }

      const sinceMap = new Map<string, any>();
      for (const row of sinceRows) {
        const key = `${row.table_name}.${row.column_name}`;
        sinceMap.set(key, row);
      }

      const latestMap = new Map<string, any>();
      for (const row of latest) {
        const key = `${row.table_name}.${row.column_name}`;
        latestMap.set(key, row);
      }

      const changes: SchemaChange[] = [];
      const detectedAt = new Date();

      // 检测新增和修改
      for (const [key, latestRow] of latestMap) {
        const sinceRow = sinceMap.get(key);
        if (!sinceRow) {
          // 新增
          changes.push({
            type: 'added',
            target: 'column',
            table_name: latestRow.table_name,
            column_name: latestRow.column_name,
            details: {
              column_type: { new: latestRow.column_type },
              column_key: { new: latestRow.column_key },
            },
            detected_at: detectedAt,
          });
        } else {
          // 检查是否有修改
          const details: Record<string, { old: any; new: any }> = {};
          if (sinceRow.column_type !== latestRow.column_type) {
            details.column_type = { old: sinceRow.column_type, new: latestRow.column_type };
          }
          if (sinceRow.column_key !== latestRow.column_key) {
            details.column_key = { old: sinceRow.column_key, new: latestRow.column_key };
          }
          if (sinceRow.column_default !== latestRow.column_default) {
            details.column_default = { old: sinceRow.column_default, new: latestRow.column_default };
          }
          if (sinceRow.is_nullable !== latestRow.is_nullable) {
            details.is_nullable = { old: sinceRow.is_nullable, new: latestRow.is_nullable };
          }
          if (Object.keys(details).length > 0) {
            changes.push({
              type: 'modified',
              target: 'column',
              table_name: latestRow.table_name,
              column_name: latestRow.column_name,
              details,
              detected_at: detectedAt,
            });
          }
        }
      }

      // 检测删除
      for (const [key, sinceRow] of sinceMap) {
        if (!latestMap.has(key)) {
          changes.push({
            type: 'deleted',
            target: 'column',
            table_name: sinceRow.table_name,
            column_name: sinceRow.column_name,
            detected_at: detectedAt,
          });
        }
      }

      // 按表名+列名排序
      changes.sort((a, b) => {
        const cmp = a.table_name.localeCompare(b.table_name);
        if (cmp !== 0) return cmp;
        return (a.column_name || '').localeCompare(b.column_name || '');
      });

      return changes;
    } catch (error) {
      console.error('获取快照变更失败:', error);
      return [];
    }
  }

  /**
   * 获取指定表的完整列信息
   */
  async getTableDetail(instanceId: number, tableName: string): Promise<TableSchemaRow[]> {
    const pool = this.getPool();
    if (!pool) {
      return [];
    }

    try {
      const [rows] = await pool.execute(
        `SELECT table_name, column_name, column_type, is_nullable,
                column_default, column_key, extra, column_comment,
                table_comment, table_rows, data_length
         FROM schema_snapshots
         WHERE instance_id = ? AND table_name = ?
           AND snapshot_time = (
             SELECT MAX(snapshot_time) FROM schema_snapshots
             WHERE instance_id = ? AND table_name = ?
           )
         ORDER BY column_name`,
        [instanceId, tableName, instanceId, tableName]
      ) as any;

      return rows as TableSchemaRow[];
    } catch (error) {
      console.error('获取表详情失败:', error);
      return [];
    }
  }

  /**
   * 获取当前快照的表列表（去重，含统计）
   */
  async getTableList(instanceId: number): Promise<{ table_name: string; table_comment: string | null; table_rows: number; data_length: number; column_count: number }[]> {
    const pool = this.getPool();
    if (!pool) {
      return [];
    }

    try {
      const [rows] = await pool.execute(
        `SELECT table_name,
                MAX(table_comment) as table_comment,
                MAX(table_rows) as table_rows,
                MAX(data_length) as data_length,
                COUNT(*) as column_count
         FROM schema_snapshots
         WHERE instance_id = ?
           AND snapshot_time = (
             SELECT MAX(snapshot_time) FROM schema_snapshots WHERE instance_id = ?
           )
         GROUP BY table_name
         ORDER BY table_name`,
        [instanceId, instanceId]
      ) as any;

      return rows.map((row: any) => ({
        table_name: row.table_name,
        table_comment: row.table_comment,
        table_rows: Number(row.table_rows),
        data_length: Number(row.data_length),
        column_count: Number(row.column_count),
      }));
    } catch (error) {
      console.error('获取表列表失败:', error);
      return [];
    }
  }
}

// 单例
export const schemaDatabaseService = new SchemaDatabaseService();
