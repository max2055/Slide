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
import { assertCredentialUsable, CredentialRotationRequiredError } from './credential-rotation.js';
import { Client } from 'ssh2';
import { authorizeServerTarget, ServerTargetPolicyError } from './security/server-target-policy.js';
import { createCredentialSshHostVerifier, normalizeOptionalSshHostKeyFingerprint } from './security/ssh-host-key.js';
import { normalizeServerOs } from './server-os-profile.js';

/** Stable refusal when deleting a server would drop historical reports. */
export const SERVER_HAS_HISTORICAL_REPORTS = 'SERVER_HAS_HISTORICAL_REPORTS';
/** Shown by the delete route. The service itself returns the stable code. */
export const SERVER_HISTORICAL_REPORT_DELETE_ERROR =
  '该服务器仍有历史报表，删除已阻止。报表和原目标身份保持不变，访问权限不变，也不会重新采集。';
/** Shared by create and update when MySQL rejects a duplicate host/port. */
export const SERVER_ADDRESS_ALREADY_MANAGED = '该主机地址和端口已被纳管，请勿重复添加';
/** Client text for an unexpected update failure. Driver details stay in the server log. */
export const SERVER_UPDATE_FAILED = '更新服务器失败';

const UPDATE_BUSINESS_ERRORS = new Set([
  'SSH_CREDENTIAL_TYPE_INVALID',
  'SSH_TRUST_MODE_INVALID',
  'SSH_HOST_KEY_FINGERPRINT_REQUIRED',
  'SSH_TRUST_CONFIRMATION_REQUIRED',
  'HOST_OS_UNSUPPORTED',
  '服务器不存在',
  '更换认证方式时必须提供新的凭据值',
  '重新录入凭据时必须提供 SSH 用户名',
  '数据库未连接',
  'SERVER_CREDENTIALS_INVALID',
]);

function serverHostIdentity(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const hostname = value.trim().toLowerCase();
  return hostname.length > 0 ? hostname : null;
}

function serverPortIdentity(value: unknown): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const port = Number(value);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  return port;
}

function serverTargetUnchanged(
  existingHost: unknown,
  existingPort: unknown,
  patch: { host?: unknown; port?: unknown },
): boolean {
  const storedHost = serverHostIdentity(existingHost);
  const storedPort = serverPortIdentity(existingPort);
  if (storedHost === null || storedPort === null) return false;
  const nextHost = patch.host === undefined ? storedHost : serverHostIdentity(patch.host);
  const nextPort = patch.port === undefined ? storedPort : serverPortIdentity(patch.port);
  return nextHost === storedHost && nextPort === storedPort;
}

function duplicateServerAddress(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { code?: unknown; errno?: unknown };
  return candidate.code === 'ER_DUP_ENTRY' || candidate.errno === 1062;
}

function isMysqlDriverError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { code?: unknown; errno?: unknown; sqlMessage?: unknown; sql?: unknown };
  if (typeof candidate.sqlMessage === 'string' || typeof candidate.sql === 'string' || typeof candidate.errno === 'number') {
    return true;
  }
  return typeof candidate.code === 'string' && candidate.code.startsWith('ER_');
}

function updateClientError(error: unknown): string {
  if (duplicateServerAddress(error)) return SERVER_ADDRESS_ALREADY_MANAGED;
  if (error instanceof ServerTargetPolicyError) return error.reasonCode;
  if (isMysqlDriverError(error)) {
    console.error('更新服务器失败:', error);
    return SERVER_UPDATE_FAILED;
  }
  if (error instanceof Error && (UPDATE_BUSINESS_ERRORS.has(error.message) || (error as { code?: unknown }).code === 'CREDENTIAL_ROTATION_REQUIRED')) {
    return error.message;
  }
  console.error('更新服务器失败:', error);
  return SERVER_UPDATE_FAILED;
}

export interface ServerRow {
  id: number;
  host: string;
  port: number;
  label: string | null;
  os_type: string;
  credential_type: 'password' | 'key';
  credential_encrypted: string;
  host_key_fingerprint: string | null;
  ssh_trust_mode?: string | null;
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
  async getAllServers(options: { strict?: boolean } = {}): Promise<ServerRow[]> {
    const pool = this.getPool();
    if (!pool) {
      if (options.strict) throw new Error('SERVER_ENUMERATION_UNAVAILABLE');
      return [];
    }

    try {
      const [rows] = await pool.execute(
        `SELECT id, host, port, label, os_type, credential_type,
                credential_encrypted, host_key_fingerprint, ssh_trust_mode, status,
                last_check_at, collection_enabled, created_at, updated_at
         FROM servers
         ORDER BY host`
      ) as any;

      return rows as ServerRow[];
    } catch (error) {
      if (options.strict) throw new Error('SERVER_ENUMERATION_UNAVAILABLE', { cause: error });
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
                credential_encrypted, host_key_fingerprint, ssh_trust_mode, status,
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
                credential_encrypted, host_key_fingerprint, ssh_trust_mode, status,
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
    ssh_trust_mode?: string | null;
    host_key_fingerprint?: string | null;
    created_by?: number;
  }): Promise<{ success: boolean; serverId?: number; error?: string }> {
    const pool = this.getPool();
    if (!pool) {
      return { success: false, error: '数据库未连接' };
    }

    try {
      const canonicalOs = normalizeServerOs(data.os_type);
      if (!canonicalOs) return { success: false, error: 'HOST_OS_UNSUPPORTED' };
      const target = await authorizeServerTarget({ host: data.host, port: data.port || 22 });
      createCredentialSshHostVerifier(data.credential_type, data.host_key_fingerprint, data.ssh_trust_mode);
      const hostKeyFingerprint = normalizeOptionalSshHostKeyFingerprint(data.host_key_fingerprint) ?? null;
      // Check for duplicate host+port
      const [existing] = await pool.execute(
        'SELECT id, host, label FROM servers WHERE host = ? AND port = ?',
        [target.hostname, target.port]
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
         (host, port, label, os_type, credential_type, credential_encrypted, host_key_fingerprint, ssh_trust_mode, collection_enabled)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        [
          target.hostname,
          target.port,
          data.label || null,
          canonicalOs,
          data.credential_type,
          encrypted,
          hostKeyFingerprint,
          data.credential_type === 'key' ? data.ssh_trust_mode ?? null : null,
        ]
      ) as any;

      return { success: true, serverId: result.insertId };
    } catch (error: any) {
      // Handle duplicate entry from UNIQUE INDEX uq_host_port (TOCTOU race fallback)
      if (duplicateServerAddress(error)) {
        return { success: false, error: SERVER_ADDRESS_ALREADY_MANAGED };
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
      ssh_trust_mode?: string | null;
      host_key_fingerprint?: string | null;
    }
  ): Promise<{ success: boolean; error?: string }> {
    const pool = this.getPool();
    if (!pool) {
      return { success: false, error: '数据库未连接' };
    }

    const apply = async (sql: { execute(statement: string, values?: any[]): Promise<any> }) => {
      const [rows] = await sql.execute(
        `SELECT id, host, port, label, os_type, credential_type,
                credential_encrypted, host_key_fingerprint, ssh_trust_mode, status,
                last_check_at, collection_enabled, created_at, updated_at
         FROM servers WHERE id = ? FOR UPDATE`,
        [id],
      ) as [ServerRow[], unknown];
      const existingServer = Array.isArray(rows) ? rows[0] : undefined;
      if (!existingServer) return { success: false, error: '服务器不存在' };
      const canonicalOs = data.os_type === undefined ? undefined : normalizeServerOs(data.os_type);
      if (data.os_type !== undefined && !canonicalOs) {
        return { success: false, error: 'HOST_OS_UNSUPPORTED' };
      }
      const targetUnchanged = serverTargetUnchanged(existingServer.host, existingServer.port, data);
      const target = targetUnchanged ? null : await authorizeServerTarget({
        host: data.host !== undefined ? data.host : existingServer.host,
        port: data.port !== undefined ? Number(data.port) : existingServer.port,
      });
      const updates: string[] = [];
      const values: any[] = [];
      if (target) {
        updates.push('host = ?', 'port = ?');
        values.push(target.hostname, target.port);
      } else if (data.host !== undefined) {
        const canonicalHost = serverHostIdentity(data.host);
        if (canonicalHost && canonicalHost !== existingServer.host) {
          updates.push('host = ?');
          values.push(canonicalHost);
        }
      }

      if (data.label !== undefined) {
        updates.push('label = ?');
        values.push(data.label);
      }
      if (data.os_type !== undefined) {
        updates.push('os_type = ?');
        values.push(canonicalOs);
      }
      if (data.credential_type !== undefined) {
        // When credential_type changes, require new credential_value to avoid payload/type mismatch
        if (data.credential_value === undefined || data.credential_value === '') {
          if (existingServer.credential_type !== data.credential_type) {
            return { success: false, error: '更换认证方式时必须提供新的凭据值' };
          }
        }
        updates.push('credential_type = ?');
        values.push(data.credential_type);
      }
      // Re-encrypt if credential username or value provided (non-empty)
      if ((data.credential_username !== undefined && data.credential_username !== '')
          || (data.credential_value !== undefined && data.credential_value !== '')) {
        // A new credential is a complete replacement. Do not decrypt the
        // old blob first: this is the recovery path for records encrypted
        // with a rotated/lost application key (for example server 3).
        if (data.credential_value !== undefined && data.credential_value !== '') {
          const actualType = data.credential_type || existingServer.credential_type;
          const username = data.credential_username || (() => {
            try { return this.decryptCredentials(existingServer.credential_encrypted).username; } catch { return ''; }
          })();
          if (!username) return { success: false, error: '重新录入凭据时必须提供 SSH 用户名' };
          const credPayload: Record<string, string> = { username };
          credPayload[actualType === 'password' ? 'password' : 'privateKey'] = data.credential_value;
          updates.push('credential_encrypted = ?');
          values.push(encryptData(JSON.stringify(credPayload)));
        } else {
          const decrypted = this.decryptCredentials(existingServer.credential_encrypted);
          const credPayload: Record<string, string> = {
            username: data.credential_username || decrypted.username,
          };
          if (decrypted.password) credPayload.password = decrypted.password;
          if (decrypted.privateKey) credPayload.privateKey = decrypted.privateKey;
          updates.push('credential_encrypted = ?');
          values.push(encryptData(JSON.stringify(credPayload)));
        }
      }
      if (data.collection_enabled !== undefined) {
        updates.push('collection_enabled = ?');
        values.push(data.collection_enabled);
      }
      const effectiveType = data.credential_type ?? existingServer.credential_type;
      const changesTarget = target !== null
        && (target.hostname !== existingServer.host || target.port !== existingServer.port);
      const changesToKey = effectiveType === 'key' && existingServer.credential_type !== 'key';
      if ((changesTarget || changesToKey) && effectiveType === 'key' && data.ssh_trust_mode === undefined) {
        updates.push('ssh_trust_mode = ?');
        values.push('pending');
      }
      if (data.ssh_trust_mode !== undefined || data.host_key_fingerprint !== undefined || data.credential_type !== undefined) {
        createCredentialSshHostVerifier(data.credential_type ?? existingServer.credential_type,
          data.host_key_fingerprint === undefined ? existingServer.host_key_fingerprint : data.host_key_fingerprint,
          data.ssh_trust_mode === undefined ? (changesToKey || changesTarget ? 'pending' : existingServer.ssh_trust_mode) : data.ssh_trust_mode);
      }
      if (data.ssh_trust_mode !== undefined) {
        updates.push('ssh_trust_mode = ?');
        values.push(data.ssh_trust_mode);
      }
      if (data.host_key_fingerprint !== undefined) {
        updates.push('host_key_fingerprint = ?');
        values.push(normalizeOptionalSshHostKeyFingerprint(data.host_key_fingerprint) ?? null);
      }

      if (updates.length === 0) {
        return { success: true };
      }

      values.push(id);
      const [result] = await sql.execute(
        `UPDATE servers SET ${updates.join(', ')} WHERE id = ?`,
        values,
      ) as [{ affectedRows?: number }, unknown];
      if (!result || result.affectedRows === 0) {
        return { success: false, error: '服务器不存在' };
      }
      return { success: true };
    };

    try {
      if (typeof pool.getConnection !== 'function') return await apply(pool);
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        const result = await apply(connection);
        if (result.success) await connection.commit();
        else await connection.rollback();
        return result;
      } catch (error) {
        await connection.rollback().catch(() => undefined);
        throw error;
      } finally {
        connection.release();
      }
    } catch (error) {
      return { success: false, error: updateClientError(error) };
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
           AND relation_type = 'runs_on' AND (valid_until IS NULL OR valid_until > NOW(6))
         LIMIT 1`,
        [id],
      ) as any;
      if (Array.isArray(relations) && relations.length > 0) {
        await connection.rollback();
        return { success: false, error: 'SERVER_HAS_INSTANCE_RELATIONS' };
      }
      // The server row lock is already held. A normal report insert needs a
      // shared lock on that parent, so it cannot commit until this transaction
      // ends. Lock matching report rows too, then refuse before DELETE.
      // fk_report_server_restrict is ON DELETE RESTRICT, so a report that still
      // appears at DELETE time fails the statement instead of being cascaded.
      const [reports] = await connection.execute(
        'SELECT id FROM reports WHERE server_id = ? LIMIT 1 FOR UPDATE',
        [id],
      ) as any;
      if (Array.isArray(reports) && reports.length > 0) {
        await connection.rollback();
        return { success: false, error: SERVER_HAS_HISTORICAL_REPORTS };
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
      if (error?.errno === 1451 || error?.code === 'ER_ROW_IS_REFERENCED_2') {
        return { success: false, error: SERVER_HAS_HISTORICAL_REPORTS };
      }
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
    username: string,
    hostKeyFingerprint?: string | null,
    sshTrustMode?: string | null,
  ): Promise<{ success: boolean; error?: string; message?: string }> {
    try {
      assertCredentialUsable(credentialValue);
      assertCredentialUsable(username);
      const target = await authorizeServerTarget({ host, port });
      const hostVerifier = createCredentialSshHostVerifier(credentialType, hostKeyFingerprint, sshTrustMode);
      return new Promise((resolve) => {
        const client = new Client();
        let settled = false;
        const finish = (result: { success: boolean; error?: string; message?: string }) => {
          if (settled) return;
          // Mark completion before cleanup: end/destroy may emit more events.
          settled = true;
          if (result.success) client.end();
          else client.destroy();
          resolve(result);
        };

        client.on('ready', () => {
          finish({ success: true, message: `连接成功：${host}:${port}` });
        });

        client.on('error', (err: Error) => {
          finish({ success: false, error: translateSshError(err.message, host, port) });
        });
        const disconnected = () => finish({
          success: false,
          error: translateSshError('Connection lost before handshake', host, port),
        });
        client.on('end', disconnected);
        client.on('close', disconnected);

        const connectConfig: any = {
          host: target.address,
          port: target.port,
          username,
          readyTimeout: 10000,
          ...(hostVerifier ? { hostVerifier } : {}),
        };

        if (credentialType === 'password') {
          connectConfig.password = credentialValue;
        } else {
          connectConfig.privateKey = credentialValue;
        }

        try {
          client.connect(connectConfig);
        } catch (error: any) {
          finish({ success: false, error: translateSshError(error.message, host, port) });
        }
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

      // Credential rotation must not change the independently trusted host key.
      await pool.execute(
        `UPDATE servers SET credential_encrypted = ?, credential_type = ? WHERE id = ?`,
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
    try {
      const decrypted = decryptData(encryptedData);
      assertCredentialUsable(decrypted);
      const credentials = JSON.parse(decrypted) as DecryptedCredentials;
      assertCredentialUsable(credentials.username);
      assertCredentialUsable(credentials.password);
      assertCredentialUsable(credentials.privateKey);
      return credentials;
    } catch (error) {
      if (error instanceof CredentialRotationRequiredError) throw error;
      // Parser/crypto errors can contain credential fragments. Do not retain
      // their message or cause: callers may return or log this error.
      throw new Error('SERVER_CREDENTIALS_INVALID');
    }
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
        try {
          await this.getPool()?.execute(
            'UPDATE servers SET credential_encrypted = ? WHERE id = ? AND credential_encrypted = ?',
            [encryptData(JSON.stringify(credentials)), serverId, server.credential_encrypted],
          );
        } catch {
          // Migration is best-effort; driver errors may contain credentials or SQL.
          console.error('服务器凭据迁移失败', { serverId, code: 'SERVER_CREDENTIAL_MIGRATION_FAILED' });
        }
      }
      return credentials;
    } catch (error) {
      if (error instanceof CredentialRotationRequiredError) throw error;
      console.error('解密凭据失败:', error);
      return null;
    }
  }
}

// Singleton
export const serverDatabaseService = new ServerDatabaseService();
