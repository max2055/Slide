/**
 * MySQL 连接管理 - 用于连接运维系统自己的数据库
 */
import 'dotenv/config';
import mysql from 'mysql2/promise';
import * as crypto from 'crypto';

// 数据库配置
interface DbConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

class DbConnectionManager {
  private pool: mysql.Pool | null = null;
  private config: DbConfig | null = null;
  private connected: boolean = false;

  /**
   * 初始化数据库连接
   */
  async initialize(config?: DbConfig): Promise<boolean> {
    if (this.pool) {
      return this.connected;
    }

    const dbConfig = config || {
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT || '3306'),
      user: process.env.DB_USER || 'root',
      password: process.env.DB_PASSWORD || '',
      database: process.env.DB_NAME || 'db_ops_ai',
    };

    this.config = dbConfig;

    try {
      this.pool = mysql.createPool({
        host: dbConfig.host,
        port: dbConfig.port,
        user: dbConfig.user,
        password: dbConfig.password,
        database: dbConfig.database,
        connectionLimit: 10,
        waitForConnections: true,
        charset: 'utf8mb4',
        timezone: '+08:00',
        decimalNumbers: true,
      });

      // 测试连接
      const connection = await this.pool.getConnection();
      await connection.ping();
      connection.release();

      this.connected = true;
      console.log(`✅ 系统数据库连接成功：${dbConfig.host}:${dbConfig.port}/${dbConfig.database}`);
      return true;
    } catch (error) {
      console.error('❌ 系统数据库连接失败:', error);
      this.connected = false;
      return false;
    }
  }

  /**
   * 获取连接池
   */
  getPool(): mysql.Pool | null {
    return this.pool;
  }

  /**
   * 检查是否已连接
   */
  isConnected(): boolean {
    return this.connected && this.pool !== null;
  }

  /**
   * 执行查询
   */
  async query<T = any>(sql: string, values?: any[]): Promise<T> {
    if (!this.pool) {
      throw new Error('数据库未连接');
    }
    const [rows] = await this.pool.execute(sql, values);
    return rows as T;
  }

  /**
   * 关闭连接
   */
  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
      this.connected = false;
    }
  }
}

// 单例
export const dbConnection = new DbConnectionManager();

/**
 * 加密敏感数据
 */
export function encryptData(data: string, key?: string): string {
  const encryptKey = key || process.env.ENCRYPTION_KEY || 'default-encryption-key-change-in-production';
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(encryptKey.padEnd(32, '0').slice(0, 32)), iv);
  let encrypted = cipher.update(data, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return iv.toString('hex') + ':' + encrypted;
}

/**
 * 解密敏感数据
 */
export function decryptData(encrypted: string, key?: string): string {
  const decryptKey = key || process.env.ENCRYPTION_KEY || 'default-encryption-key-change-in-production';
  const parts = encrypted.split(':');
  if (parts.length !== 2) {
    throw new Error('无效的加密数据');
  }
  const iv = Buffer.from(parts[0], 'hex');
  const encryptedData = parts[1];
  const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(decryptKey.padEnd(32, '0').slice(0, 32)), iv);
  let decrypted = decipher.update(encryptedData, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}
