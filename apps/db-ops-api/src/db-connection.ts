/**
 * MySQL 连接管理 - 用于连接运维系统自己的数据库
 */
import 'dotenv/config';
import mysql from 'mysql2/promise';
import * as crypto from 'crypto';
import { requireEncryptionKey } from './config/security-config.js';

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
        // Persist instants in UTC so Date-backed workflow availability and
        // lease predicates remain comparable with MySQL NOW() across hosts.
        timezone: 'Z',
        decimalNumbers: true,
      });
      // `timezone: 'Z'` controls mysql2 value conversion only. MySQL NOW()
      // still follows the server session timezone unless we set it explicitly.
      // Keep persisted schedule and lease timestamps on the same UTC timeline.
      this.pool.on('connection', (connection) => {
        (connection as any).query("SET time_zone = '+00:00'", (error: unknown) => {
          if (error) console.error('Failed to set MySQL session timezone:', error);
        });
      });

      // 测试连接
      const connection = await this.pool.getConnection();
      await connection.query("SET time_zone = '+00:00'");
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
function _getEncryptionKey(callerKey?: string): string {
  return requireEncryptionKey(callerKey);
}

export function encryptData(data: string, key?: string): string {
  const encryptKey = _getEncryptionKey(key);
  const keyBytes = parseV2EncryptionKey(encryptKey);
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyBytes, nonce);
  const encrypted = Buffer.concat([cipher.update(data, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const keyId = crypto.createHash('sha256').update(keyBytes).digest('hex').slice(0, 12);
  return ['v2', keyId, nonce.toString('hex'), tag.toString('hex'), encrypted.toString('hex')].join(':');
}

/**
 * 解密敏感数据
 */
export function decryptData(encrypted: string, key?: string): string {
  const decryptKey = _getEncryptionKey(key);
  if (encrypted.startsWith('v2:')) {
    const parts = encrypted.split(':');
    if (parts.length !== 5) throw new Error('无效的加密数据');
    const [, keyId, nonceHex, tagHex, ciphertextHex] = parts;
    const keyBytes = parseV2EncryptionKey(decryptKey);
    const expectedKeyId = crypto.createHash('sha256').update(keyBytes).digest('hex').slice(0, 12);
    if (keyId !== expectedKeyId) throw new Error('加密密钥版本不匹配');
    const decipher = crypto.createDecipheriv('aes-256-gcm', keyBytes, Buffer.from(nonceHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    return Buffer.concat([decipher.update(Buffer.from(ciphertextHex, 'hex')), decipher.final()]).toString('utf8');
  }

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

export function needsEncryptionMigration(encrypted: string): boolean {
  return !encrypted.startsWith('v2:');
}

function parseV2EncryptionKey(value: string): Buffer {
  if (/^[0-9a-fA-F]{64}$/.test(value)) return Buffer.from(value, 'hex');
  if (/^[A-Za-z0-9+/]{43}=$/.test(value)) {
    const decoded = Buffer.from(value, 'base64');
    if (decoded.length === 32) return decoded;
  }
  const utf8 = Buffer.from(value, 'utf8');
  if (utf8.length === 32) return utf8;
  throw new Error('ENCRYPTION_KEY 必须是 32 字节 UTF-8、64 位 hex 或 32 字节 base64');
}
