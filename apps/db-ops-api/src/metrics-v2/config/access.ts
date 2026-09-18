import { databaseService } from '../../database-service.js';
import { serverDatabaseService } from '../../server-database-service.js';
import sshSessionPool from '../../ssh-session-pool.js';
import { MysqlNetworkDeviceCollectionStore, toSnmpConfig } from '../../network-devices/network-device-collector.js';
import { SnmpClient } from '../../network-devices/snmp-client.js';
import { authorizeNetworkDeviceTarget } from '../../security/network-device-target-policy.js';
import { dbConnection } from '../../db-connection.js';
import { configurationInventory } from './inventory.js';
import { bindSnmp, AdapterError } from '../packages/adapters.js';
import type { CollectorAccess } from '../scheduler/service.js';
import { rule } from '../policy/model.js';
import { trialDatabaseTransport } from './database-transport.js';
import { SnmpDiscovery } from '../snmp/collector.js';

/** Called only after resource management authorization. No client-supplied target or credential. */
export const trialAccess: CollectorAccess = {
  async resolve(ref) {
    const pool = dbConnection.getPool(); rule(pool, 'POLICY_STORE_UNAVAILABLE', 503);
    const resource = await configurationInventory(ref);
    if (ref.type === 'network_device') {
      const credentials = await new MysqlNetworkDeviceCollectionStore().getCredentials(ref.id);
      if (credentials) resource.attributes['snmp.version'] = { value: credentials.protocol === 'snmpv2c' ? 2 : 3, source: 'resource_configuration', observed_at: new Date().toISOString() };
    }
    const reference = `credential:trial-${ref.type}-${ref.id}`;
    return { resource, credential_ref: reference, evidence: ref.type === 'network_device' ? { snmp: new SnmpDiscovery() } : {},
      resolve: async (credential, target, method) => {
        rule(credential === reference && target.type === ref.type && target.id === String(ref.id), 'TRIAL_IDENTITY');
        if (ref.type === 'instance' && method === 'sql') {
          const connection = databaseService.getConnection(ref.id);
          if (!connection?.connected) throw new AdapterError('connection_error');
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
          const target = await authorizeNetworkDeviceTarget({ host: device.host, port: device.snmpPort });
          return bindSnmp(new SnmpClient(), toSnmpConfig(device, credentials, target.address));
        }
        throw new AdapterError('connection_error');
      },
    };
  },
};
