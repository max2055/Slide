/**
 * 索引管理数据库服务 — 存储索引信息、冗余报告、未使用标记
 */
import mysql from 'mysql2/promise';
import { dbConnection } from './db-connection';

export interface IndexEntry {
  table_name: string;
  index_name: string;
  column_name: string;
  seq_in_index: number;
  non_unique: number;
  cardinality: number;
  sub_part: number | null;
  nullable: string;
  index_type: string;
  comment: string | null;
}

export interface RedundantIndexReport {
  instance_id: number;
  table_name: string;
  redundant_index: string;
  covered_by_index: string;
  reason: string;
}

export interface IndexRow {
  id: number;
  table_name: string;
  index_name: string;
  column_name: string;
  seq_in_index: number;
  non_unique: number;
  cardinality: number;
  sub_part: number | null;
  nullable: string;
  index_type: string;
  comment: string | null;
  collected_at: Date;
  is_unused: boolean;
}

export interface RedundancyReportRow {
  id: number;
  table_name: string;
  redundant_index: string;
  covered_by_index: string;
  reason: string;
  created_at: Date;
}

class IndexDatabaseService {
  private getPool(): mysql.Pool | null {
    return dbConnection.getPool();
  }

  private async replaceSnapshot(
    instanceId: number,
    write: (conn: mysql.PoolConnection) => Promise<void>
  ): Promise<void> {
    const pool = this.getPool();
    if (!pool) throw new Error('索引存储暂不可用');
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      // 父行锁也覆盖首次采集和空快照，避免依赖 DELETE 的间隙锁。
      const [rows] = await conn.execute<mysql.RowDataPacket[]>(
        'SELECT id FROM database_instances WHERE id = ? FOR UPDATE', [instanceId]
      );
      if (!rows.length) throw new Error('实例不存在');
      await write(conn);
      await conn.commit();
    } catch {
      try { await conn.rollback(); } catch { /* 保留稳定失败，连接销毁避免复用未知事务 */ conn.destroy(); }
      throw new Error('索引存储更新失败');
    } finally {
      conn.release();
    }
  }

  /**
   * 批量保存索引信息（幂等：先删后插）
   */
  async saveIndexData(
    instanceId: number,
    indexEntries: IndexEntry[]
  ): Promise<{ success: boolean; count: number; error?: string }> {
    const pool = this.getPool();
    if (!pool) {
      return { success: false, count: 0, error: '数据库未连接' };
    }

    try {
      const collectedAt = new Date();

      await this.replaceSnapshot(instanceId, async (conn) => {
        // 先删除该实例当前的旧记录（幂等）
        await conn.execute(
          'DELETE FROM index_info WHERE instance_id = ?',
          [instanceId]
        );

        // 批量插入
        const values = indexEntries.map((entry) => [
          instanceId,
          entry.table_name,
          entry.index_name,
          entry.column_name,
          entry.seq_in_index || 0,
          entry.non_unique ?? 1,
          entry.cardinality || 0,
          entry.sub_part,
          entry.nullable || 'YES',
          entry.index_type || 'BTREE',
          entry.comment,
          collectedAt,
        ]);

        for (let offset = 0; offset < values.length; offset += 1000) {
          const batch = values.slice(offset, offset + 1000);
          const placeholders = batch.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ');
          const flatValues = batch.flat();

          await conn.execute(
            `INSERT INTO index_info
             (instance_id, table_name, index_name, column_name, seq_in_index,
              non_unique, cardinality, sub_part, nullable, index_type, comment, collected_at)
             VALUES ${placeholders}`,
            flatValues
          );

        }
      });
      return { success: true, count: indexEntries.length };
    } catch (error: any) {
      console.error('保存索引数据失败:', error);
      return { success: false, count: 0, error: '索引存储更新失败' };
    }
  }

  /**
   * 获取指定实例的所有索引
   */
  async getIndexesByInstance(instanceId: number): Promise<IndexRow[]> {
    const pool = this.getPool();
    if (!pool) {
      throw new Error('索引存储暂不可用');
    }

    try {
      const [rows] = await pool.execute(
        `SELECT id, table_name, index_name, column_name, seq_in_index,
                non_unique, cardinality, sub_part, nullable, index_type,
                comment, collected_at, is_unused
         FROM index_info
         WHERE instance_id = ?
         ORDER BY table_name, index_name, seq_in_index`,
        [instanceId]
      ) as any;

      return rows as IndexRow[];
    } catch (error) {
      console.error('获取实例索引失败:', error);
      throw new Error('索引存储暂不可用');
    }
  }

  /**
   * 获取指定实例+表的所有索引
   */
  async getIndexesByTable(instanceId: number, tableName: string): Promise<IndexRow[]> {
    const pool = this.getPool();
    if (!pool) {
      throw new Error('索引存储暂不可用');
    }

    try {
      const [rows] = await pool.execute(
        `SELECT id, table_name, index_name, column_name, seq_in_index,
                non_unique, cardinality, sub_part, nullable, index_type,
                comment, collected_at, is_unused
         FROM index_info
         WHERE instance_id = ? AND table_name = ?
         ORDER BY index_name, seq_in_index`,
        [instanceId, tableName]
      ) as any;

      return rows as IndexRow[];
    } catch (error) {
      console.error('获取表索引失败:', error);
      throw new Error('索引存储暂不可用');
    }
  }

  /**
   * 获取冗余报告
   */
  async getRedundancyReport(instanceId: number): Promise<RedundancyReportRow[]> {
    const pool = this.getPool();
    if (!pool) {
      throw new Error('索引存储暂不可用');
    }

    try {
      const [rows] = await pool.execute(
        `SELECT id, table_name, redundant_index, covered_by_index, reason, created_at
         FROM index_redundancy_report
         WHERE instance_id = ?
         ORDER BY table_name, redundant_index`,
        [instanceId]
      ) as any;

      return rows as RedundancyReportRow[];
    } catch (error) {
      console.error('获取冗余报告失败:', error);
      throw new Error('索引存储暂不可用');
    }
  }

  /**
   * 保存冗余检测结果（先清后插）
   */
  async saveRedundancyReport(
    instanceId: number,
    reports: RedundantIndexReport[]
  ): Promise<{ success: boolean; count: number; error?: string }> {
    const pool = this.getPool();
    if (!pool) {
      return { success: false, count: 0, error: '数据库未连接' };
    }

    if (reports.some((report) => report.instance_id !== instanceId)) {
      return { success: false, count: 0, error: '报告实例不匹配' };
    }

    try {
      await this.replaceSnapshot(instanceId, async (conn) => {

        // 先删除该实例当前的旧报告
        await conn.execute(
          'DELETE FROM index_redundancy_report WHERE instance_id = ?',
          [instanceId]
        );

        // 批量插入
        const values = reports.map((r) => [
          r.instance_id,
          r.table_name,
          r.redundant_index,
          r.covered_by_index,
          r.reason,
        ]);

        for (let offset = 0; offset < values.length; offset += 1000) {
          const batch = values.slice(offset, offset + 1000);
          const placeholders = batch.map(() => '(?, ?, ?, ?, ?)').join(', ');
          const flatValues = batch.flat();

          await conn.execute(
            `INSERT INTO index_redundancy_report
             (instance_id, table_name, redundant_index, covered_by_index, reason)
             VALUES ${placeholders}`,
            flatValues
          );

        }
      });
      return { success: true, count: reports.length };
    } catch (error: any) {
      console.error('保存冗余报告失败:', error);
      return { success: false, count: 0, error: '索引存储更新失败' };
    }
  }

  /**
   * 获取未使用索引列表
   */
  async getUnusedIndexes(instanceId: number): Promise<IndexRow[]> {
    const pool = this.getPool();
    if (!pool) {
      throw new Error('索引存储暂不可用');
    }

    try {
      const [rows] = await pool.execute(
        `SELECT id, table_name, index_name, column_name, seq_in_index,
                non_unique, cardinality, sub_part, nullable, index_type,
                comment, collected_at, is_unused
         FROM index_info
         WHERE instance_id = ? AND is_unused = TRUE
         ORDER BY table_name, index_name, seq_in_index`,
        [instanceId]
      ) as any;

      return rows as IndexRow[];
    } catch (error) {
      console.error('获取未使用索引失败:', error);
      throw new Error('索引存储暂不可用');
    }
  }
}

// 单例
export const indexDatabaseService = new IndexDatabaseService();
