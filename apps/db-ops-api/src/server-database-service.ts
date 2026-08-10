/**
 * Server Database Service
 *
 * CRUD for SSH servers, encrypted credential storage,
 * SSH connection test, and key rotation.
 *
 * Requires: SRV-01, SRV-02, SRV-03, SRV-06
 */
import mysql from 'mysql2/promise';
import { dbConnection, encryptData, decryptData, needsEncryptionMigration } from './db-connection';
import { Client } from 'ssh2';

export interface ServerRow {
  id: number;
  host: string;
  port: number;
  label: string | null;
  os_type: string;
  credential_type: 'password' | 'key';
  credential_encrypted: string;
  host_key_fingerprint: string | null;
  status: 'online' | 'offline' | 'error' | 'unreachable';
  last_check_at: Date | null;
  collection_enabled: number;
  created_at: Date;
  updated_at: Date;
}

export interface DecryptedCredentials {
  username: string;
  password?: string;
  privateKey?: string;
}

function translateSshError(rawMessage: string, host: string, port: number): string {
  const lower = rawMessage.toLowerCase();
  if (lower.includes('econnrefused'))
    return `无法连接到 ${host}:${port}（连接被拒绝，请检查主机地址和 SSH 端口是否正确）`;
  if (lower.includes('timed out') || lower.includes('timeout'))
    return `连接 ${host}:${port} 超时（主机不可达或网络不通）`;
  if (lower.includes('enotfound') || lower.includes('eai_again'))
    return `无法解析主机名 "${host}"（请检查 IP 或域名是否正确）`;
  if (lower.includes('ehostunreach') || lower.includes('enetunreach'))
    return `主机 ${host} 不可达（网络不通或目标网络不存在）`;
  if (lower.includes('authentication failed') || lower.includes('permission denied'))
    return `SSH 认证失败（用户名或凭据错误）`;
  if (lower.includes('connection lost') || lower.includes('handshake'))
    return `与 ${host}:${port} 的 SSH 连接在握手阶段断开`;
  if (lower.includes('key exchange failed'))
    return `与 ${host}:${port} 的 SSH 密钥交换失败`;
  return `连接 ${host}:${port} 失败：${rawMessage}`;
}

class ServerDatabaseService {
  /**
   * Get database connection pool
   */
  private getPool(): mysql.Pool | null {
    return dbConnection.getPool();
  }

  /**
   * Check if database is connected
   */
  private isConnected(): boolean {
    return dbConnection.isConnected();
  }

  /**
   * Get all servers
   */
  async getAllServers(): Promise<ServerRow[]> {
    const pool = this.getPool();
    if (!pool) {
      return [];
    }

    try {
      const [rows] = await pool.execute(
        `SELECT id, host, port, label, os_type, credential_type,
                credential_encrypted, host_key_fingerprint, status,
                last_check_at, collection_enabled, created_at, updated_at
         FROM servers
         ORDER BY host`
      ) as any;

      return rows as ServerRow[];
    } catch (error) {
      console.error('获取服务器列表失败:', error);
      return [];
    }
  }

  /**
   * Get server by ID
   */
  async getServerById(id: number): Promise<ServerRow | null> {
    const pool = this.getPool();
    if (!pool) {
      return null;
    }

    try {
      const [rows] = await pool.execute(
        `SELECT id, host, port, label, os_type, credential_type,
                credential_encrypted, host_key_fingerprint, status,
                last_check_at, collection_enabled, created_at, updated_at
         FROM servers
         WHERE id = ?`,
        [id]
      ) as any;

      if (Array.isArray(rows) && rows.length > 0) {
        return rows[0] as ServerRow;
      }
      return null;
    } catch (error) {
      console.error('获取服务器失败:', error);
      return null;
    }
  }

  /**
   * Get servers with collection enabled
   */
  async getCollectionEnabledServers(): Promise<ServerRow[]> {
    const pool = this.getPool();
    if (!pool) {
      return [];
    }

    try {
      const [rows] = await pool.execute(
        `SELECT id, host, port, label, os_type, credential_type,
                credential_encrypted, host_key_fingerprint, status,
                last_check_at, collection_enabled, created_at, updated_at
         FROM servers
         WHERE collection_enabled = 1
         ORDER BY host`
      ) as any;

      return rows as ServerRow[];
    } catch (error) {
      console.error('获取启用采集的服务器列表失败:', error);
      return [];
    }
  }

  /**
   * Update server status and last_check_at timestamp
   */
  async updateServerStatus(
    id: number,
    status: 'online' | 'offline' | 'error' | 'unreachable'
  ): Promise<{ success: boolean; error?: string }> {
    const pool = this.getPool();
    if (!pool) {
      return { success: false, error: '数据库未连接' };
    }

    try {
      const [result] = await pool.execute(
        `UPDATE servers SET status = ?, last_check_at = NOW() WHERE id = ?`,
        [status, id]
      ) as any;

      if (result.affectedRows === 0) {
        return { success: false, error: '服务器不存在' };
      }

      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Create a server
   */
  async createServer(data: {
    host: string;
    port?: number;
    label?: string;
    os_type: string;
    credential_type: 'password' | 'key';
    credential_username: string;
    credential_value: string;
    created_by?: number;
  }): Promise<{ success: boolean; serverId?: number; error?: string }> {
    const pool = this.getPool();
    if (!pool) {
      return { success: false, error: '数据库未连接' };
    }

    try {
      // Check for duplicate host+port
      const [existing] = await pool.execute(
        'SELECT id, host, label FROM servers WHERE host = ? AND port = ?',
        [data.host, data.port || 22]
      ) as any;

      if (existing && existing.length > 0) {
        const dup = existing[0];
        return { success: false, error: `该地址已被服务器 "${dup.label || dup.host}" (ID: ${dup.id}) 纳管，请勿重复添加` };
      }

      // Validate credential value is non-empty
      if (!data.credential_value || data.credential_value.trim() === '') {
        return { success: false, error: 'SSH密码或私钥不能为空' };
      }

      // Encrypt credentials
      const credentialPayload: Record<string, string> = { username: data.credential_username };
      if (data.credential_type === 'password') {
        credentialPayload.password = data.credential_value;
      } else {
        credentialPayload.privateKey = data.credential_value;
      }
      const encrypted = encryptData(JSON.stringify(credentialPayload));

      const [result] = await pool.execute(
        `INSERT INTO servers
         (host, port, label, os_type, credential_type, credential_encrypted, collection_enabled)
         VALUES (?, ?, ?, ?, ?, ?, 1)`,
        [
          data.host,
          data.port || 22,
          data.label || null,
          data.os_type,
          data.credential_type,
          encrypted,
        ]
      ) as any;

      return { success: true, serverId: result.insertId };
    } catch (error: any) {
      // Handle duplicate entry from UNIQUE INDEX uq_host_port (TOCTOU race fallback)
      if (error.code === 'ER_DUP_ENTRY') {
        return { success: false, error: '该主机地址和端口已被纳管，请勿重复添加' };
      }
      console.error('创建服务器失败:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Update a server
   */
  async updateServer(
    id: number,
    data: {
      host?: string;
      port?: number;
      label?: string;
      os_type?: string;
      credential_type?: 'password' | 'key';
      credential_username?: string;
      credential_value?: string;
      collection_enabled?: number;
    }
  ): Promise<{ success: boolean; error?: string }> {
    const pool = this.getPool();
    if (!pool) {
      return { success: false, error: '数据库未连接' };
    }

    try {
      const updates: string[] = [];
      const values: any[] = [];

      if (data.host !== undefined) {
        updates.push('host = ?');
        values.push(data.host);
      }
      if (data.port !== undefined) {
        updates.push('port = ?');
        values.push(data.port);
      }
      if (data.label !== undefined) {
        updates.push('label = ?');
        values.push(data.label);
      }
      if (data.os_type !== undefined) {
        updates.push('os_type = ?');
        values.push(data.os_type);
      }
      if (data.credential_type !== undefined) {
        // When credential_type changes, require new credential_value to avoid payload/type mismatch
        if (data.credential_value === undefined || data.credential_value === '') {
          const existing = await this.getServerById(id);
          if (existing && existing.credential_type !== data.credential_type) {
            return { success: false, error: '更换认证方式时必须提供新的凭据值' };
          }
        }
        updates.push('credential_type = ?');
        values.push(data.credential_type);
      }
      // Re-encrypt if credential username or value provided (non-empty)
      if ((data.credential_username !== undefined && data.credential_username !== '')
          || (data.credential_value !== undefined && data.credential_value !== '')) {
        // Fetch existing to merge with new values
        const existing = await this.getServerById(id);
        if (existing) {
          const decrypted = this.decryptCredentials(existing.credential_encrypted);
          const credPayload: Record<string, string> = {
            username: data.credential_username !== undefined && data.credential_username !== '' ? data.credential_username : decrypted.username,
          };
          if (data.credential_value !== undefined && data.credential_value !== '') {
            // Determine credential key from the decrypted payload when credential_type
            // is not provided, to avoid stale column value causing type mismatch.
            const actualType = data.credential_type
              || (decrypted.password ? 'password'
                : decrypted.privateKey ? 'key'
                  : existing.credential_type);
            const key = actualType === 'password' ? 'password' : 'privateKey';
            credPayload[key] = data.credential_value;
          } else {
            if (decrypted.password) credPayload.password = decrypted.password;
            if (decrypted.privateKey) credPayload.privateKey = decrypted.privateKey;
          }
          updates.push('credential_encrypted = ?');
          values.push(encryptData(JSON.stringify(credPayload)));
        }
      }
      if (data.collection_enabled !== undefined) {
        updates.push('collection_enabled = ?');
        values.push(data.collection_enabled);
      }

      if (updates.length === 0) {
        return { success: true };
      }

      values.push(id);

      const [result] = await pool.execute(
        `UPDATE servers SET ${updates.join(', ')} WHERE id = ?`,
        values
      ) as any;

      if (result.affectedRows === 0) {
        return { success: false, error: '服务器不存在' };
      }

      return { success: true };
    } catch (error: any) {
      console.error('更新服务器失败:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Delete a server
   */
  async deleteServer(id: number): Promise<{ success: boolean; error?: string }> {
    const pool = this.getPool();
    if (!pool) {
      return { success: false, error: '数据库未连接' };
    }

    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [servers] = await connection.execute('SELECT id FROM servers WHERE id = ? FOR UPDATE', [id]) as any;
      if (!Array.isArray(servers) || servers.length === 0) {
        await connection.rollback();
        return { success: false, error: '服务器不存在' };
      }
      const [relations] = await connection.execute(
        `SELECT id FROM resource_relations
         WHERE source_type = 'instance' AND target_type = 'server' AND target_id = ?
           AND relation_type = 'runs_on' AND (valid_until IS NULL OR valid_until > NOW())
         LIMIT 1`,
        [id],
      ) as any;
      if (Array.isArray(relations) && relations.length > 0) {
        await connection.rollback();
        return { success: false, error: 'SERVER_HAS_INSTANCE_RELATIONS' };
      }
      const [result] = await connection.execute('DELETE FROM servers WHERE id = ?', [id]) as any;
      if (result.affectedRows === 0) {
        await connection.rollback();
        return { success: false, error: '服务器不存在' };
      }
      await connection.commit();
      return { success: true };
    } catch (error: any) {
      await connection.rollback().catch(() => undefined);
      console.error('删除服务器失败:', error);
      return { success: false, error: error.message };
    } finally {
      connection.release();
    }
  }

  /**
   * Test SSH connection to a server
   */
  async testConnection(
    host: string,
    port: number,
    credentialType: string,
    credentialValue: string,
    username: string
  ): Promise<{ success: boolean; error?: string; message?: string }> {
    try {
      return new Promise((resolve) => {
        const client = new Client();

        client.on('ready', () => {
          client.end();
          resolve({ success: true, message: `连接成功：${host}:${port}` });
        });

        client.on('error', (err: Error) => {
          client.end();
          resolve({ success: false, error: translateSshError(err.message, host, port) });
        });

        const connectConfig: any = {
          host,
          port,
          username,
          readyTimeout: 10000,
          // hostVerifier: accept any host key for initial test-connection.
          // Production SSH connections MUST use the stored host_key_fingerprint for verification.
          hostVerifier: () => true,
        };

        if (credentialType === 'password') {
          connectConfig.password = credentialValue;
        } else {
          connectConfig.privateKey = credentialValue;
        }

        client.connect(connectConfig);
      });
    } catch (error: any) {
      return { success: false, error: translateSshError(error.message, host, port) };
    }
  }

  /**
   * Rotate SSH key for a server
   */
  async rotateKey(
    serverId: number,
    newCredentialType: 'password' | 'key',
    newCredentialUsername: string,
    newCredentialValue: string
  ): Promise<{ success: boolean; message: string }> {
    const pool = this.getPool();
    if (!pool) {
      return { success: false, message: '数据库未连接' };
    }

    try {
      // Validate server exists
      const server = await this.getServerById(serverId);
      if (!server) {
        return { success: false, message: '服务器不存在' };
      }

      // Re-encrypt credentials with new key
      const credentialPayload: Record<string, string> = { username: newCredentialUsername };
      if (newCredentialType === 'password') {
        credentialPayload.password = newCredentialValue;
      } else {
        credentialPayload.privateKey = newCredentialValue;
      }
      const encrypted = encryptData(JSON.stringify(credentialPayload));

      // Update credential_encrypted, credential_type, reset host_key_fingerprint
      await pool.execute(
        `UPDATE servers SET credential_encrypted = ?, credential_type = ?, host_key_fingerprint = NULL WHERE id = ?`,
        [encrypted, newCredentialType, serverId]
      );

      return { success: true, message: '密钥轮换成功' };
    } catch (error: any) {
      console.error('密钥轮换失败:', error);
      return { success: false, message: `密钥轮换失败：${error.message}` };
    }
  }

  /**
   * Decrypt stored credentials JSON
   */
  decryptCredentials(encryptedData: string): DecryptedCredentials {
    const decrypted = decryptData(encryptedData);
    return JSON.parse(decrypted) as DecryptedCredentials;
  }

  /**
   * Get decrypted credentials for a server (internal use)
   */
  async getDecryptedCredentials(serverId: number): Promise<DecryptedCredentials | null> {
    const server = await this.getServerById(serverId);
    if (!server) {
      return null;
    }

    try {
      const credentials = this.decryptCredentials(server.credential_encrypted);
      if (needsEncryptionMigration(server.credential_encrypted)) {
        await this.getPool()?.execute(
          'UPDATE servers SET credential_encrypted = ? WHERE id = ? AND credential_encrypted = ?',
          [encryptData(JSON.stringify(credentials)), serverId, server.credential_encrypted],
        );
      }
      return credentials;
    } catch (error) {
      console.error('解密凭据失败:', error);
      return null;
    }
  }
}

// Singleton
export const serverDatabaseService = new ServerDatabaseService();
