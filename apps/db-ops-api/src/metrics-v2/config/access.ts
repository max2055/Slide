import { createHash } from 'node:crypto';
import { databaseService } from '../../database-service.js';
import { instanceDatabaseService } from '../../instance-database-service.js';
import { serverDatabaseService } from '../../server-database-service.js';
import sshSessionPool from '../../ssh-session-pool.js';
import { MysqlNetworkDeviceCollectionStore, toSnmpConfig } from '../../network-devices/network-device-collector.js';
import { SnmpClient } from '../../network-devices/snmp-client.js';
import { authorizeNetworkDeviceTarget } from '../../security/network-device-target-policy.js';
import { dbConnection } from '../../db-connection.js';
import { configurationInventory } from './inventory.js';
import { bindSnmp, AdapterError } from '../packages/adapters.js';
import type { CollectorAccess } from '../scheduler/service.js';
import { RefSchema, rule } from '../policy/model.js';
import { trialDatabaseTransport } from './database-transport.js';
import { SnmpDiscovery } from '../snmp/collector.js';
import { MysqlResourceRelationStore } from '../../resources/resource-service.js';
import { SnmpDiscoveryCache } from './discovery-cache.js';

/** Called only after resource management authorization. No client-supplied target or credential. */
export function createAssetCollectorAccess(preserveDiscovery = false): CollectorAccess {
 const discovery = new SnmpDiscoveryCache();
 const assets = new MysqlResourceRelationStore();
 return {
  async resolve(ref) {
    ref = RefSchema.parse(ref);
    const pool = dbConnection.getPool(); rule(pool, 'POLICY_STORE_UNAVAILABLE', 503);
    if (!await assets.exists(ref)) {
      discovery.forget(ref.id);
      throw new AdapterError('permission_denied');
    }
    const identity = async () => {
      let value: unknown;
      if (ref.type === 'instance') {
        const asset = await instanceDatabaseService.getInstanceById(ref.id);
        const secret = await instanceDatabaseService.getInstancePassword(ref.id);
        if (!asset || secret === null) throw new AdapterError('permission_denied');
        value = [asset.host, asset.port, asset.username, asset.db_type, asset.database_name, secret];
      } else if (ref.type === 'server') {
        const asset = await serverDatabaseService.getServerById(ref.id);
        const secret = await serverDatabaseService.getDecryptedCredentials(ref.id);
        if (!asset || !secret) throw new AdapterError('permission_denied');
        value = [asset.host, asset.port, asset.credential_type, asset.host_key_fingerprint, secret];
      } else {
        const store = new MysqlNetworkDeviceCollectionStore();
        const asset = await store.getDevice(ref.id), secret = await store.getCredentials(ref.id);
        if (!asset || !secret) throw new AdapterError('permission_denied');
        value = [asset.host, asset.snmpPort, secret];
      }
      return createHash('sha256').update(JSON.stringify(value)).digest('hex');
    };
    const initialIdentity = await identity();
    const assertCurrent = async () => {
      if (!await assets.exists(ref) || await identity() !== initialIdentity) throw new AdapterError('permission_denied');
    };
    const resource = await configurationInventory(ref);
    let snmp: SnmpDiscovery | undefined;
    if (ref.type === 'network_device') {
      const store = new MysqlNetworkDeviceCollectionStore();
      const credentials = await store.getCredentials(ref.id), device = await store.getDevice(ref.id);
      if (!credentials || !device) { discovery.forget(ref.id); throw new AdapterError('permission_denied'); }
      resource.attributes['snmp.version'] = { value: credentials.protocol === 'snmpv2c' ? 2 : 3, source: 'resource_configuration', observed_at: new Date().toISOString() };
      snmp = preserveDiscovery ? discovery.get(ref.id, [device.host, device.snmpPort, credentials]) : new SnmpDiscovery();
    }
    const reference = `credential:asset-${ref.type}-${ref.id}`;
    const evidence = snmp ? { snmp } : {};
    return { resource, credential_ref: reference, evidence, assertCurrent,
      resolve: async (credential, target, method) => {
        rule(credential === reference && target.type === ref.type && target.id === String(ref.id), 'COLLECTOR_IDENTITY');
        await assertCurrent();
        if (!await assets.exists(ref)) { discovery.forget(ref.id); throw new AdapterError('permission_denied'); }
        if (ref.type === 'instance' && method === 'sql') {
          const instance = await instanceDatabaseService.getInstanceById(ref.id);
          const connection = databaseService.getConnection(ref.id);
          if (!connection?.connected) throw new AdapterError('connection_error');
          // A stale shared connection cannot redirect collection after asset edits or credential rotation.
          const password = await instanceDatabaseService.getInstancePassword(ref.id);
          if (!instance || connection.config.host !== instance.host || connection.config.port !== instance.port
            || connection.config.user !== instance.username || connection.db_type !== instance.db_type
            || (connection.config.database || undefined) !== (instance.database_name || (instance.db_type === 'postgresql' ? 'postgres' : instance.db_type === 'mysql' ? 'mysql' : undefined))
            || connection.config.password !== password) throw new AdapterError('permission_denied');
          return trialDatabaseTransport(connection);
        }
        if (ref.type === 'server' && method === 'ssh') {
          const server = await serverDatabaseService.getServerById(ref.id);
          const credentials = await serverDatabaseService.getDecryptedCredentials(ref.id);
          if (!server || !credentials) throw new AdapterError('permission_denied');
          const value = server.credential_type === 'password' ? credentials.password : credentials.privateKey;
          if (!value) throw new AdapterError('permission_denied');
          // Acquire and release per fixed command batch so cancellation cannot leak pooled clients.
          return { method: 'ssh', client: undefined as never, pool: { execCommands: async (_client, commands, options) => {
            const client = await sshSessionPool.getConnection(server.host, server.port, credentials.username,
              server.credential_type, value, server.host_key_fingerprint);
            let onClose!: () => void;
            const closed = new Promise<void>(resolve => { onClose = resolve; client.once('close', onClose); });
            try { return await sshSessionPool.execCommands(client, commands, options); }
            catch (error) {
              sshSessionPool.closeConnection(client); client.destroy(); await closed;
              throw error;
            } finally { client.removeListener('close', onClose); sshSessionPool.releaseConnection(client); }
          } } };
        }
        if (ref.type === 'network_device' && method === 'snmp') {
          const store = new MysqlNetworkDeviceCollectionStore();
          const device = await store.getDevice(ref.id), credentials = await store.getCredentials(ref.id);
          if (!device || !credentials) throw new AdapterError('permission_denied');
          if (preserveDiscovery && evidence.snmp !== discovery.get(ref.id, [device.host, device.snmpPort, credentials])) {
            throw new AdapterError('permission_denied');
          }
          const target = await authorizeNetworkDeviceTarget({ host: device.host, port: device.snmpPort });
          return bindSnmp(new SnmpClient(), toSnmpConfig(device, credentials, target.address));
        }
        throw new AdapterError('connection_error');
      },
    };
  },
 };
}

export const trialAccess = createAssetCollectorAccess();
export const productionAccess = createAssetCollectorAccess(true);
