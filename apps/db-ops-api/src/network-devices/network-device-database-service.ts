import { dbConnection, decryptData, encryptData, needsEncryptionMigration } from '../db-connection.js';
import { normalizeSshHostKeyFingerprint } from '../security/ssh-host-key.js';
import {
  parseNetworkDeviceCreateInput,
  parseNetworkDeviceUpdateInput,
  type NetworkDeviceCredentialProtocol,
  type NetworkDevicePublicDto,
  type NetworkDeviceRow,
  type NetworkDeviceUpdateInput,
  type SnmpV2CredentialInput,
  type SnmpV3CredentialInput,
  type SshCredentialInput,
} from '../resources/network-device-types.js';

interface SqlExecutor {
  execute<T = unknown>(sql: string, values?: unknown[]): Promise<[T, any?]>;
}

interface SqlConnection extends SqlExecutor {
  beginTransaction(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  release(): void;
}

interface SqlPool extends SqlExecutor {
  getConnection?(): Promise<SqlConnection>;
}

export interface NetworkDeviceCredentials {
  protocol: NetworkDeviceCredentialProtocol;
  username: string;
  securityLevel?: SnmpV3CredentialInput['securityLevel'];
  authProtocol?: SnmpV3CredentialInput['authProtocol'];
  authSecret?: string;
  privacyProtocol?: SnmpV3CredentialInput['privacyProtocol'];
  privacySecret?: string;
  credentialType?: SshCredentialInput['credentialType'];
  credentialValue?: string;
  hostKeyFingerprint?: string;
  community?: string;
}

const DEVICE_COLUMNS = `d.id, d.name, d.label, d.host, d.site, d.vendor, d.model, d.os_version, d.serial_number,
  d.snmp_port, d.ssh_port, d.status, d.last_check_at, d.collection_enabled, d.created_at, d.updated_at`;

export class NetworkDeviceDatabaseService {
  constructor(private readonly poolProvider: () => SqlPool | null = () => dbConnection.getPool() as unknown as SqlPool | null) {}

  async getAllDevices(): Promise<NetworkDevicePublicDto[]> {
    const pool = this.pool();
    const [rows] = await pool.execute<Array<any>>(
      `SELECT ${DEVICE_COLUMNS},
              EXISTS (SELECT 1 FROM network_device_credentials c WHERE c.device_id = d.id AND c.protocol IN ('snmpv2c','snmpv3')) AS has_snmp_credential,
              EXISTS (SELECT 1 FROM network_device_credentials c WHERE c.device_id = d.id AND c.protocol = 'ssh') AS has_ssh_credential
       FROM network_devices d ORDER BY d.host, d.id`,
    );
    return rows.map((row) => this.publicDto(row));
  }

  async getDeviceById(id: number): Promise<NetworkDevicePublicDto | null> {
    const pool = this.pool();
    const [rows] = await pool.execute<Array<any>>(
      `SELECT ${DEVICE_COLUMNS},
              EXISTS (SELECT 1 FROM network_device_credentials c WHERE c.device_id = d.id AND c.protocol IN ('snmpv2c','snmpv3')) AS has_snmp_credential,
              EXISTS (SELECT 1 FROM network_device_credentials c WHERE c.device_id = d.id AND c.protocol = 'ssh') AS has_ssh_credential
       FROM network_devices d WHERE d.id = ? LIMIT 1`, [id],
    );
    return rows[0] ? this.publicDto(rows[0]) : null;
  }

  /** Internal collector-only credential read. This method is intentionally not used by DTO routes. */
  async getCredentials(id: number, protocol?: NetworkDeviceCredentialProtocol): Promise<NetworkDeviceCredentials | null> {
    const pool = this.pool();
    const values: unknown[] = [id];
    const where = protocol ? ' AND protocol = ?' : '';
    if (protocol) values.push(protocol);
    const [rows] = await pool.execute<Array<any>>(
      `SELECT protocol, username, security_level, auth_protocol, privacy_protocol,
              auth_secret_encrypted, privacy_secret_encrypted, community_encrypted, credential_type,
              credential_encrypted, host_key_fingerprint
       FROM network_device_credentials WHERE device_id = ?${where} ORDER BY protocol`, values,
    );
    const row = rows[0];
    if (!row) return null;
    if (row.protocol === 'snmpv3') {
      return {
        protocol: 'snmpv3', username: row.username, securityLevel: row.security_level,
        authProtocol: row.auth_protocol ?? undefined, privacyProtocol: row.privacy_protocol ?? undefined,
        authSecret: row.auth_secret_encrypted ? this.decryptSecret(row.auth_secret_encrypted) : undefined,
        privacySecret: row.privacy_secret_encrypted ? this.decryptSecret(row.privacy_secret_encrypted) : undefined,
      };
    }
    if (row.protocol === 'snmpv2c') {
      return { protocol: 'snmpv2c', username: '', community: row.community_encrypted ? this.decryptSecret(row.community_encrypted) : undefined };
    }
    const encrypted = row.credential_encrypted;
    const value = encrypted ? this.decryptSecret(encrypted) : undefined;
    return {
      protocol: 'ssh', username: row.username, credentialType: row.credential_type,
      credentialValue: value, hostKeyFingerprint: row.host_key_fingerprint ?? undefined,
    };
  }

  async createDevice(raw: unknown): Promise<{ success: boolean; deviceId?: number; error?: string }> {
    let connection: SqlConnection | null = null;
    try {
      const input = parseNetworkDeviceCreateInput(raw);
      const pool = this.pool();
      const executor: SqlExecutor = pool.getConnection ? (connection = await pool.getConnection()) : pool;
      if (connection) await connection.beginTransaction();
      const [result] = await executor.execute<any>(
        `INSERT INTO network_devices
          (name, label, host, site, vendor, model, os_version, serial_number, snmp_port, ssh_port, collection_enabled)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [input.name, input.label ?? null, input.host, input.site ?? null, input.vendor, input.model ?? null,
          input.osVersion ?? null, input.serialNumber ?? null, input.snmpPort, input.sshPort, input.collectionEnabled === false ? 0 : 1],
      );
      const id = Number(result.insertId);
      if (input.snmpv3) await this.saveSnmpCredentials(executor, id, input.snmpv3);
      if (input.snmpv2c) await this.saveSnmpV2Credentials(executor, id, input.snmpv2c);
      if (input.ssh) await this.saveSshCredentials(executor, id, input.ssh);
      if (connection) await connection.commit();
      return { success: true, deviceId: id };
    } catch (error: any) {
      if (connection) await connection.rollback().catch(() => undefined);
      if (error?.code === 'ER_DUP_ENTRY') return { success: false, error: '该网络设备地址和 SNMP 端口已被纳管' };
      return { success: false, error: this.safeError(error) };
    } finally { connection?.release(); }
  }

  async updateDevice(id: number, raw: unknown): Promise<{ success: boolean; error?: string }> {
    let connection: SqlConnection | null = null;
    try {
      const input = parseNetworkDeviceUpdateInput(raw);
      const pool = this.pool();
      const executor: SqlExecutor = pool.getConnection ? (connection = await pool.getConnection()) : pool;
      if (connection) await connection.beginTransaction();
      const updates: string[] = [];
      const values: unknown[] = [];
      const fields: Array<[keyof NetworkDeviceUpdateInput, string]> = [
        ['name', 'name'], ['label', 'label'], ['host', 'host'], ['site', 'site'], ['vendor', 'vendor'],
        ['model', 'model'], ['osVersion', 'os_version'], ['serialNumber', 'serial_number'], ['snmpPort', 'snmp_port'], ['sshPort', 'ssh_port'],
      ];
      for (const [key, column] of fields) {
        if ((input as any)[key] !== undefined) { updates.push(`${column} = ?`); values.push((input as any)[key] ?? null); }
      }
      if (input.collectionEnabled !== undefined) { updates.push('collection_enabled = ?'); values.push(input.collectionEnabled ? 1 : 0); }
      if (updates.length > 0) {
        values.push(id);
        const [result] = await executor.execute<any>(`UPDATE network_devices SET ${updates.join(', ')} WHERE id = ?`, values);
        if (!Number(result.affectedRows)) {
          if (connection) await connection.rollback();
          return { success: false, error: '网络设备不存在' };
        }
      } else {
        const [rows] = await executor.execute<Array<{ id: number }>>('SELECT id FROM network_devices WHERE id = ? LIMIT 1', [id]);
        if (!rows.length) {
          if (connection) await connection.rollback();
          return { success: false, error: '网络设备不存在' };
        }
      }
      if (input.snmpv3) await this.saveSnmpCredentials(executor, id, input.snmpv3);
      if (input.snmpv2c) await this.saveSnmpV2Credentials(executor, id, input.snmpv2c);
      if (input.ssh) await this.saveSshCredentials(executor, id, input.ssh);
      if (connection) await connection.commit();
      return { success: true };
    } catch (error: any) {
      if (connection) await connection.rollback().catch(() => undefined);
      if (error?.code === 'ER_DUP_ENTRY') return { success: false, error: '该网络设备地址和 SNMP 端口已被纳管' };
      return { success: false, error: this.safeError(error) };
    } finally { connection?.release(); }
  }

  async deleteDevice(id: number): Promise<{ success: boolean; error?: string }> {
    const pool = this.pool();
    if (!pool.getConnection) throw new Error('RESOURCE_STORE_UNAVAILABLE');
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [devices] = await connection.execute<Array<{ id: number }>>('SELECT id FROM network_devices WHERE id = ? FOR UPDATE', [id]);
      if (!devices.length) { await connection.rollback(); return { success: false, error: '网络设备不存在' }; }
      const [relations] = await connection.execute<Array<{ id: number }>>(
        `SELECT id FROM resource_relations
         WHERE ((source_type = 'network_device' AND source_id = ?) OR (target_type = 'network_device' AND target_id = ?))
           AND (valid_until IS NULL OR valid_until > NOW(6)) LIMIT 1`, [id, id],
      );
      if (relations.length) { await connection.rollback(); return { success: false, error: 'NETWORK_DEVICE_HAS_RELATIONS' }; }
      await connection.execute('DELETE FROM network_devices WHERE id = ?', [id]);
      await connection.commit();
      return { success: true };
    } catch (error: any) {
      await connection.rollback().catch(() => undefined);
      return { success: false, error: this.safeError(error) };
    } finally { connection.release(); }
  }

  async updateStatus(id: number, status: NetworkDeviceRow['status']): Promise<void> {
    await this.pool().execute('UPDATE network_devices SET status = ?, last_check_at = NOW() WHERE id = ?', [status, id]);
  }

  private async exists(id: number): Promise<boolean> {
    const [rows] = await this.pool().execute<Array<{ id: number }>>('SELECT id FROM network_devices WHERE id = ? LIMIT 1', [id]);
    return rows.length > 0;
  }

  private async saveSnmpCredentials(pool: SqlExecutor, id: number, input: SnmpV3CredentialInput): Promise<void> {
    await pool.execute(
      `INSERT INTO network_device_credentials
       (device_id, protocol, security_level, username, auth_protocol, privacy_protocol, auth_secret_encrypted, privacy_secret_encrypted)
       VALUES (?, 'snmpv3', ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE security_level = VALUES(security_level), username = VALUES(username), auth_protocol = VALUES(auth_protocol),
         privacy_protocol = VALUES(privacy_protocol), auth_secret_encrypted = VALUES(auth_secret_encrypted), privacy_secret_encrypted = VALUES(privacy_secret_encrypted)`,
      [id, input.securityLevel, input.username, input.authProtocol ?? null, input.privacyProtocol ?? null,
        input.authSecret ? encryptData(input.authSecret) : null, input.privacySecret ? encryptData(input.privacySecret) : null],
    );
  }

  private async saveSnmpV2Credentials(pool: SqlExecutor, id: number, input: SnmpV2CredentialInput): Promise<void> {
    await pool.execute(
      `INSERT INTO network_device_credentials
       (device_id, protocol, username, community_encrypted)
       VALUES (?, 'snmpv2c', '', ?)
       ON DUPLICATE KEY UPDATE username = VALUES(username), community_encrypted = VALUES(community_encrypted),
         security_level = NULL, auth_protocol = NULL, privacy_protocol = NULL, auth_secret_encrypted = NULL, privacy_secret_encrypted = NULL`,
      [id, encryptData(input.community)],
    );
  }

  private async saveSshCredentials(pool: SqlExecutor, id: number, input: SshCredentialInput): Promise<void> {
    const fingerprint = input.hostKeyFingerprint
      ? normalizeSshHostKeyFingerprint(input.hostKeyFingerprint)
      : null;
    await pool.execute(
      `INSERT INTO network_device_credentials
       (device_id, protocol, credential_type, username, credential_encrypted, host_key_fingerprint)
       VALUES (?, 'ssh', ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE credential_type = VALUES(credential_type), username = VALUES(username), credential_encrypted = VALUES(credential_encrypted), host_key_fingerprint = VALUES(host_key_fingerprint)`,
      [id, input.credentialType, input.username, encryptData(input.credentialValue), fingerprint],
    );
  }

  private decryptSecret(value: string): string {
    const decrypted = decryptData(value);
    if (needsEncryptionMigration(value)) {
      // Credential reads are intentionally best-effort; callers still receive the plaintext
      // for the current probe while migration is handled by the next write path.
    }
    return decrypted;
  }

  private publicDto(row: Record<string, any>): NetworkDevicePublicDto {
    return {
      id: Number(row.id), name: row.name, label: row.label ?? null, host: row.host, site: row.site ?? null,
      vendor: row.vendor, model: row.model ?? null, os_version: row.os_version ?? null, serial_number: row.serial_number ?? null,
      snmp_port: Number(row.snmp_port), ssh_port: Number(row.ssh_port), status: row.status,
      last_check_at: row.last_check_at ?? null, collection_enabled: Boolean(row.collection_enabled),
      created_at: row.created_at, updated_at: row.updated_at,
      hasSnmpCredential: Boolean(row.has_snmp_credential), hasSshCredential: Boolean(row.has_ssh_credential),
    };
  }

  private pool(): SqlPool {
    const pool = this.poolProvider();
    if (!pool) throw new Error('RESOURCE_STORE_UNAVAILABLE');
    return pool;
  }

  private safeError(error: unknown): string {
    if (error instanceof Error && /^[A-Z][A-Z0-9_]{2,}$/.test(error.message)) return error.message;
    const code = error && typeof error === 'object' && 'code' in error ? String((error as any).code) : '';
    return code.startsWith('NETWORK_') ? code : 'NETWORK_DEVICE_OPERATION_FAILED';
  }
}

export const networkDeviceDatabaseService = new NetworkDeviceDatabaseService();
