/**
 * 数据库实例配置服务
 */
import mysql from 'mysql2/promise';
import { dbConnection, encryptData, decryptData } from './db-connection';

export interface DatabaseInstance {
  id: number;
  name: string;
  environment: 'development' | 'staging' | 'production' | 'testing';
  db_type: 'mysql' | 'postgresql' | 'oracle' | 'dameng' | 'mongodb' | 'redis' | 'elasticsearch';
  host: string;
  port: number;
  username: string;
  password_encrypted: string;
  database_name: string | null;
  connection_string: string | null;
  max_connections: number;
  connection_timeout_ms: number;
  status: 'active' | 'inactive' | 'error';
  health_score: number;
  health_status: 'healthy' | 'warning' | 'critical' | 'unknown';
  last_health_check_at: Date | null;
  tags: any;
  description: string | null;
  created_by: number | null;
  created_at: Date;
  updated_at: Date;
}

export interface DecryptedInstance extends Omit<DatabaseInstance, 'password_encrypted'> {
  password: string;
}

class InstanceDatabaseService {
  /**
   * 获取数据库连接池
   */
  private getPool(): mysql.Pool | null {
    return dbConnection.getPool();
  }

  /**
   * 检查数据库是否已连接
   */
  private isConnected(): boolean {
    return dbConnection.isConnected();
  }

  /**
   * 获取所有实例
   */
  async getAllInstances(): Promise<DatabaseInstance[]> {
    const pool = this.getPool();
    if (!pool) {
      return [];
    }

    try {
      const [rows] = await pool.execute(
        `SELECT id, name, environment, db_type, host, port, username,
                password_encrypted, database_name, connection_string,
                max_connections, connection_timeout_ms, status,
                health_score, health_status, last_health_check_at,
                db_version, data_size_gb,
                tags, description, created_by, created_at, updated_at
         FROM database_instances
         WHERE status = 'active'
         ORDER BY name`
      ) as any;

      return rows as DatabaseInstance[];
    } catch (error) {
      console.error('获取实例列表失败:', error);
      return [];
    }
  }

  /**
   * 根据 ID 获取实例
   */
  async getInstanceById(id: number): Promise<DatabaseInstance | null> {
    const pool = this.getPool();
    if (!pool) {
      return null;
    }

    try {
      const [rows] = await pool.execute(
        `SELECT id, name, environment, db_type, host, port, username,
                password_encrypted, database_name, connection_string,
                max_connections, connection_timeout_ms, status,
                health_score, health_status, last_health_check_at,
                db_version, data_size_gb,
                tags, description, created_by, created_at, updated_at
         FROM database_instances
         WHERE id = ?`,
        [id]
      ) as any;

      if (Array.isArray(rows) && rows.length > 0) {
        return rows[0] as DatabaseInstance;
      }
      return null;
    } catch (error) {
      console.error('获取实例失败:', error);
      return null;
    }
  }

  /**
   * 获取实例密码（解密后）
   */
  async getInstancePassword(id: number): Promise<string | null> {
    const instance = await this.getInstanceById(id);
    if (!instance) {
      return null;
    }
    try {
      return decryptData(instance.password_encrypted);
    } catch (error) {
      console.error('解密密码失败:', error);
      return null;
    }
  }

  /**
   * 获取实例（带解密密码）
   */
  async getInstanceWithDecryptedPassword(id: number): Promise<DecryptedInstance | null> {
    const instance = await this.getInstanceById(id);
    if (!instance) {
      return null;
    }

    try {
      const password = decryptData(instance.password_encrypted);
      const { password_encrypted, ...rest } = instance;
      return { ...rest, password } as DecryptedInstance;
    } catch (error) {
      console.error('解密密码失败:', error);
      return null;
    }
  }

  /**
   * 创建实例
   */
  async createInstance(data: {
    name: string;
    environment: string;
    db_type: string;
    host: string;
    port: number;
    username: string;
    password: string;
    database_name?: string;
    max_connections?: number;
    connection_timeout_ms?: number;
    description?: string;
    tags?: any;
    created_by?: number;
  }): Promise<{ success: boolean; instanceId?: number; error?: string }> {
    const pool = this.getPool();
    if (!pool) {
      return { success: false, error: '数据库未连接' };
    }

    try {
      // 检查名称是否已存在
      const [existing] = await pool.execute(
        'SELECT id FROM database_instances WHERE name = ? AND environment = ?',
        [data.name, data.environment]
      ) as any;

      if (existing && existing.length > 0) {
        return { success: false, error: '该环境下实例名称已存在' };
      }

      const encryptedPassword = encryptData(data.password);

      const [result] = await pool.execute(
        `INSERT INTO database_instances
         (name, environment, db_type, host, port, username, password_encrypted,
          database_name, max_connections, connection_timeout_ms, tags, description, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          data.name,
          data.environment,
          data.db_type,
          data.host,
          data.port,
          data.username,
          encryptedPassword,
          data.database_name || null,
          data.max_connections || 100,
          data.connection_timeout_ms || 30000,
          data.tags ? JSON.stringify(data.tags) : null,
          data.description || null,
          data.created_by || null,
        ]
      ) as any;

      return { success: true, instanceId: result.insertId };
    } catch (error: any) {
      console.error('创建实例失败:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * 更新实例
   */
  async updateInstance(
    id: number,
    data: {
      name?: string;
      host?: string;
      port?: number;
      username?: string;
      password?: string;
      database_name?: string;
      max_connections?: number;
      connection_timeout_ms?: number;
      description?: string;
      tags?: any;
      environment?: string;
      db_type?: string;
    }
  ): Promise<{ success: boolean; error?: string }> {
    const pool = this.getPool();
    if (!pool) {
      return { success: false, error: '数据库未连接' };
    }

    try {
      const updates: string[] = [];
      const values: any[] = [];

      if (data.name !== undefined) {
        updates.push('name = ?');
        values.push(data.name);
      }
      if (data.host !== undefined) {
        updates.push('host = ?');
        values.push(data.host);
      }
      if (data.port !== undefined) {
        updates.push('port = ?');
        values.push(data.port);
      }
      if (data.username !== undefined) {
        updates.push('username = ?');
        values.push(data.username);
      }
      // 只在密码非空时更新密码
      if (data.password !== undefined && data.password !== '') {
        updates.push('password_encrypted = ?');
        values.push(encryptData(data.password));
      }
      if (data.database_name !== undefined) {
        updates.push('database_name = ?');
        values.push(data.database_name);
      }
      if (data.max_connections !== undefined) {
        updates.push('max_connections = ?');
        values.push(data.max_connections);
      }
      if (data.connection_timeout_ms !== undefined) {
        updates.push('connection_timeout_ms = ?');
        values.push(data.connection_timeout_ms);
      }
      if (data.description !== undefined) {
        updates.push('description = ?');
        values.push(data.description);
      }
      if (data.tags !== undefined) {
        updates.push('tags = ?');
        values.push(JSON.stringify(data.tags));
      }
      if (data.environment !== undefined) {
        updates.push('environment = ?');
        values.push(data.environment);
      }
      if (data.db_type !== undefined) {
        updates.push('db_type = ?');
        values.push(data.db_type);
      }

      if (updates.length === 0) {
        return { success: true };
      }

      values.push(id);

      const [result] = await pool.execute(
        `UPDATE database_instances SET ${updates.join(', ')} WHERE id = ?`,
        values
      ) as any;

      if (result.affectedRows === 0) {
        return { success: false, error: '实例不存在' };
      }

      return { success: true };
    } catch (error: any) {
      console.error('更新实例失败:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * 测试数据库连接
   */
  async testConnection(config: {
    db_type: string;
    host: string;
    port: number;
    username: string;
    password: string;
    database?: string;
  }): Promise<{ success: boolean; message: string }> {
    try {
      if (config.db_type === 'mysql') {
        const pool = mysql.createPool({
          host: config.host,
          port: config.port,
          user: config.username,
          password: config.password,
          database: config.database || 'mysql',
          connectionLimit: 1,
          waitForConnections: true,
          connectTimeout: 5000,
        });

        // 测试连接
        const connection = await pool.getConnection();
        await connection.ping();
        connection.release();
        await pool.end();

        return { success: true, message: `连接成功：${config.host}:${config.port}` };
      }

      if (config.db_type === 'postgresql') {
        // 动态导入 pg 以避免未使用时的依赖
        const { Client } = await import('pg');
        const client = new Client({
          host: config.host,
          port: config.port,
          user: config.username,
          password: config.password,
          database: config.database || 'postgres',
          connectionTimeoutMillis: 5000,
        });

        // 测试连接
        await client.connect();
        await client.query('SELECT 1');
        await client.end();

        return { success: true, message: `连接成功：${config.host}:${config.port}` };
      }

      if (config.db_type === 'oracle') {
        // 动态导入 oracledb
        const oracledbMod = await import('oracledb');
        const oracledb = oracledbMod.default;

        // D-13: TCPS 加密连接
        const connectString = `(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=${config.host})(PORT=${config.port}))(CONNECT_DATA=(SERVICE_NAME=${config.database || 'ORCL'})))`;

        const testPool = await oracledb.createPool({
          user: config.username,
          password: config.password,
          connectString,
          poolMin: 0,
          poolMax: 1,
          poolTimeout: 10,
        });

        const connection = await testPool.getConnection();
        await connection.execute('SELECT 1 FROM DUAL');
        await connection.close();
        await testPool.close(0);

        return { success: true, message: `连接成功：${config.host}:${config.port}` };
      }

      if (config.db_type === 'dameng') {
        // 达梦数据库使用官方 dmdb 驱动
        const dmdb = (await import('dmdb')).default;

        const host = config.host === 'localhost' ? '127.0.0.1' : config.host;
        const connection = await dmdb.getConnection({
          user: config.username,
          password: config.password,
          connectString: `${host}:${config.port}`,
          schema: config.database || undefined,
          connectTimeout: 5000,
        });

        await connection.execute('SELECT 1 FROM DUAL');
        await connection.close();

        return { success: true, message: `连接成功：${config.host}:${config.port}` };
      }

      // 其他数据库类型暂不支持
      return { success: false, message: `暂不支持 ${config.db_type} 数据库的测试连接` };
    } catch (error: any) {
      return { success: false, message: `连接失败：${error.message}` };
    }
  }

  /**
   * 删除实例
   */
  async deleteInstance(id: number): Promise<{ success: boolean; error?: string }> {
    const pool = this.getPool();
    if (!pool) {
      return { success: false, error: '数据库未连接' };
    }

    try {
      const [result] = await pool.execute('DELETE FROM database_instances WHERE id = ?', [id]) as any;
      if (result.affectedRows === 0) {
        return { success: false, error: '实例不存在' };
      }
      return { success: true };
    } catch (error: any) {
      console.error('删除实例失败:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * 更新健康状态
   */
  async updateHealthStatus(
    id: number,
    healthScore: number,
    healthStatus: 'healthy' | 'warning' | 'critical' | 'unknown',
    dbVersion?: string | null,
    dataSizeGB?: number | null,
  ): Promise<void> {
    const pool = this.getPool();
    if (!pool) {
      return;
    }

    try {
      const fields: string[] = ['health_score = ?', 'health_status = ?', 'last_health_check_at = NOW()'];
      const values: any[] = [healthScore, healthStatus];
      if (dbVersion !== undefined) { fields.push('db_version = ?'); values.push(dbVersion); }
      if (dataSizeGB !== undefined) { fields.push('data_size_gb = ?'); values.push(dataSizeGB); }
      values.push(id);
      await pool.execute(
        `UPDATE database_instances SET ${fields.join(', ')} WHERE id = ?`,
        values
      );
    } catch (error) {
      console.error('更新健康状态失败:', error);
    }
  }

  /**
   * 记录健康检查历史
   */
  async recordHealthCheck(
    instanceId: number,
    healthScore: number,
    healthStatus: 'healthy' | 'warning' | 'critical',
    checks: any[],
    issues: any[],
    dimensions?: Record<string, number>
  ): Promise<void> {
    const pool = this.getPool();
    if (!pool) {
      return;
    }

    try {
      await pool.execute(
        'INSERT INTO health_check_history (instance_id, health_score, status, dimensions, checks, issues) VALUES (?, ?, ?, ?, ?, ?)',
        [instanceId, healthScore, healthStatus, dimensions ? JSON.stringify(dimensions) : null, JSON.stringify(checks), JSON.stringify(issues)]
      );
    } catch (error) {
      console.error('记录健康检查历史失败:', error);
    }
  }

  /**
   * 获取健康检查历史
   */
  async getHealthCheckHistory(instanceId: number, days: number = 7): Promise<any[]> {
    const pool = this.getPool();
    if (!pool) {
      return [];
    }

    try {
      const [rows] = await pool.execute(
        `SELECT health_score, status, created_at
         FROM health_check_history
         WHERE instance_id = ? AND created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
         ORDER BY created_at DESC`,
        [instanceId, days]
      ) as any;

      return rows;
    } catch (error) {
      console.error('获取健康检查历史失败:', error);
      return [];
    }
  }

  /**
   * 获取健康检查历史（含 checks JSON）
   *
   * 返回 health_score, status, checks, issues, created_at
   * checks JSON 字符串已解析为对象
   *
   * @param instanceId - 实例 ID
   * @param days - 最近天数（默认 7，最大 90）
   */
  async getHealthCheckHistoryWithChecks(instanceId: number, days: number = 7): Promise<any[]> {
    const pool = this.getPool();
    if (!pool) {
      return [];
    }

    const safeDays = Math.min(Math.max(1, days), 90);

    try {
      const [rows] = await pool.execute(
        `SELECT health_score, status, checks, issues, created_at
         FROM health_check_history
         WHERE instance_id = ? AND created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
         ORDER BY created_at DESC`,
        [instanceId, safeDays]
      ) as any;

      return (rows as any[]).map((row: any) => ({
        ...row,
        checks: typeof row.checks === 'string' ? JSON.parse(row.checks) : row.checks,
        issues: row.issues ? (typeof row.issues === 'string' ? JSON.parse(row.issues) : row.issues) : null,
      }));
    } catch (error) {
      console.error('获取健康检查历史（含 checks）失败:', error);
      return [];
    }
  }

  /**
   * 获取最新一次健康检查的 checks
   *
   * @param instanceId - 实例 ID
   * @returns 最近一条 health_check_history 的 checks 数组
   */
  async getLatestHealthChecks(instanceId: number): Promise<any[] | null> {
    const pool = this.getPool();
    if (!pool) {
      return null;
    }

    try {
      const [rows] = await pool.execute(
        `SELECT checks, status, created_at
         FROM health_check_history
         WHERE instance_id = ?
         ORDER BY created_at DESC
         LIMIT 1`,
        [instanceId]
      ) as any;

      if (Array.isArray(rows) && rows.length > 0) {
        const row = rows[0];
        return {
          checks: typeof row.checks === 'string' ? JSON.parse(row.checks) : row.checks,
          status: row.status,
          created_at: row.created_at,
        };
      }
      return null;
    } catch (error) {
      console.error('获取最新健康检查失败:', error);
      return null;
    }
  }

  /**
   * 获取健康评分时间序列数据（趋势图用）
   *
   * 返回按时间 ASC 排列的健康评分历史
   *
   * @param instanceId - 实例 ID
   * @param days - 最近天数（默认 7，最大 90）
   */
  async getHealthScoreHistory(instanceId: number, days: number = 7): Promise<any[]> {
    const pool = this.getPool();
    if (!pool) {
      return [];
    }

    const safeDays = Math.min(Math.max(1, days), 90);

    try {
      const [rows] = await pool.execute(
        `SELECT health_score, status, dimensions, created_at
         FROM health_check_history
         WHERE instance_id = ? AND created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
         ORDER BY created_at ASC`,
        [instanceId, safeDays]
      ) as any;

      return (rows as any[]).map((row: any) => ({
        ...row,
        dimensions: row.dimensions
          ? (typeof row.dimensions === 'string' ? JSON.parse(row.dimensions) : row.dimensions)
          : null,
      }));
    } catch (error) {
      console.error('获取健康评分历史失败:', error);
      return [];
    }
  }
}

// 单例
export const instanceDatabaseService = new InstanceDatabaseService();
