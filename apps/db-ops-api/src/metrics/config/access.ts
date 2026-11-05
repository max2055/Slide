import { instanceAccessLifecycle } from '../../resources/instance-access-lifecycle.js';
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
import { HostBlockDiscoveryCache } from './host-counter.js';
import { HostInterfaceDiscoveryCache } from './host-interface-counter.js';
import { MysqlCounterDiscoveryCache } from './mysql-counter.js';
import { assertAssetCollectionEnabled } from './effective-state.js';

type ServerCredentialSnapshot = {
  host: string; port: number; username: string; credentialType: string;
  sshTrustMode?: string | null;
  hostKeyFingerprint: string | null; credentialValue: string;
  secret: { username: string; password?: string; privateKey?: string };
};

function serverIdentityPayload(snapshot: ServerCredentialSnapshot): unknown[] {
  return [snapshot.host, snapshot.port, snapshot.credentialType, snapshot.hostKeyFingerprint, snapshot.sshTrustMode, snapshot.secret];
}

function sameServerSnapshot(left: ServerCredentialSnapshot, right: ServerCredentialSnapshot): boolean {
  return left.host === right.host && left.port === right.port && left.username === right.username
    && left.sshTrustMode === right.sshTrustMode && left.credentialType === right.credentialType && left.hostKeyFingerprint === right.hostKeyFingerprint
    && left.credentialValue === right.credentialValue && JSON.stringify(left.secret) === JSON.stringify(right.secret);
}

/** One server row plus the credential decrypted from that row. A changing row is not a snapshot. */
async function readServerSnapshot(id: number): Promise<ServerCredentialSnapshot> {
  const asset = await serverDatabaseService.getServerById(id);
  const fetched = await serverDatabaseService.getDecryptedCredentials(id);
  const confirmed = asset && fetched ? await serverDatabaseService.getServerById(id) : null;
  if (!asset || !fetched || !confirmed || asset.host !== confirmed.host || asset.port !== confirmed.port
    || asset.ssh_trust_mode !== confirmed.ssh_trust_mode || asset.credential_type !== confirmed.credential_type || asset.host_key_fingerprint !== confirmed.host_key_fingerprint) {
    throw new AdapterError('permission_denied');
  }
  let secret = fetched;
  const encrypted = confirmed.credential_encrypted;
  const canDecrypt = typeof encrypted === 'string' && encrypted.length > 0 && typeof serverDatabaseService.decryptCredentials === 'function';
  if (asset.credential_encrypted !== encrypted || canDecrypt) {
    if (!canDecrypt) throw new AdapterError('permission_denied');
    try { secret = serverDatabaseService.decryptCredentials(encrypted); }
    catch { throw new AdapterError('permission_denied'); }
    // Rewrapping the same plaintext is not a new credential. Any other ciphertext change is.
    if (asset.credential_encrypted !== encrypted && JSON.stringify(secret) !== JSON.stringify(fetched)) throw new AdapterError('permission_denied');
  }
  const credentialValue = confirmed.credential_type === 'password' ? secret.password : secret.privateKey;
  if (!secret.username || !credentialValue) throw new AdapterError('permission_denied');
  return {
    host: confirmed.host, port: confirmed.port, username: secret.username, credentialType: confirmed.credential_type,
    sshTrustMode: confirmed.ssh_trust_mode, hostKeyFingerprint: confirmed.host_key_fingerprint ?? null, credentialValue, secret,
  };
}

/** Called only after resource management authorization. No client-supplied target or credential. */
export function createAssetCollectorAccess(preserveDiscovery = false): CollectorAccess {
 const discovery = new SnmpDiscoveryCache();
 const hostBlocks = new HostBlockDiscoveryCache();
 const hostInterfaces = new HostInterfaceDiscoveryCache();
 const mysqlCounters = new MysqlCounterDiscoveryCache();
 const assets = new MysqlResourceRelationStore();
 return {
  async resolve(ref) {
    ref = RefSchema.parse(ref);
    if (ref.type === 'instance') await instanceAccessLifecycle.assertAvailable(ref.id);
    const pool = dbConnection.getPool(); rule(pool, 'POLICY_STORE_UNAVAILABLE', 503);
    if (preserveDiscovery) await assertAssetCollectionEnabled(pool, ref);
    if (!await assets.exists(ref)) {
      discovery.forget(ref.id); hostBlocks.forget(ref.id); hostInterfaces.forget(ref.id); mysqlCounters.forget(ref.id);
      throw new AdapterError('permission_denied');
    }
    let approvedServer: ServerCredentialSnapshot | undefined;
    const identity = async () => {
      let value: unknown;
      if (ref.type === 'instance') {
        const asset = await instanceDatabaseService.getInstanceById(ref.id);
        const secret = await instanceDatabaseService.getInstancePassword(ref.id);
        if (!asset || secret === null) throw new AdapterError('permission_denied');
        value = [asset.host, asset.port, asset.username, asset.db_type, asset.database_name, secret];
      } else if (ref.type === 'server') {
        const snapshot = await readServerSnapshot(ref.id);
        if (approvedServer && !sameServerSnapshot(approvedServer, snapshot)) throw new AdapterError('permission_denied');
        approvedServer ??= snapshot;
        value = serverIdentityPayload(snapshot);
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
      if (ref.type === 'instance') await instanceAccessLifecycle.assertAvailable(ref.id);
      if (preserveDiscovery) await assertAssetCollectionEnabled(pool, ref);
      if (!await assets.exists(ref) || await identity() !== initialIdentity) throw new AdapterError('permission_denied');
    };
    const resource = await configurationInventory(ref);
    let snmp: SnmpDiscovery | undefined;
    if (ref.type === 'network_device') {
      const store = new MysqlNetworkDeviceCollectionStore();
      const credentials = await store.getCredentials(ref.id), device = await store.getDevice(ref.id);
      if (!credentials || !device) { discovery.forget(ref.id); throw new AdapterError('permission_denied'); }
      resource.attributes['snmp.version'] = { value: credentials.protocol === 'snmpv2c' ? 2 : 3, source: 'resource_configuration', observed_at: new Date().toISOString() };
      snmp = preserveDiscovery ? discovery.get(ref.id, [device.host, device.snmpPort, credentials]) : new SnmpDiscovery(Date.now, undefined, true);
    }
    const reference = `credential:asset-${ref.type}-${ref.id}`;
    // Trial and production each own separate caches; counter collectors need the lifecycle evidence on both paths.
    const evidence = snmp ? { snmp } : ref.type === 'server'
      ? { host_blocks: hostBlocks.get(ref.id, initialIdentity), host_interfaces: hostInterfaces.get(ref.id, initialIdentity) } : {};
    return { resource, credential_ref: reference, evidence, assertCurrent,
      resolve: async (credential, target, method) => {
        rule(credential === reference && target.type === ref.type && target.id === String(ref.id), 'COLLECTOR_IDENTITY');
        await assertCurrent();
        if (!await assets.exists(ref)) { discovery.forget(ref.id); hostBlocks.forget(ref.id); hostInterfaces.forget(ref.id); mysqlCounters.forget(ref.id); throw new AdapterError('permission_denied'); }
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
          return trialDatabaseTransport(connection, mysqlCounters.get(ref.id, initialIdentity));
        }
        if (ref.type === 'server' && method === 'ssh') {
          if (!approvedServer) throw new AdapterError('permission_denied');
          const approved = approvedServer;
          // Acquire and release per fixed command batch so cancellation cannot leak pooled clients.
          // Re-read immediately before connect. A different target, fingerprint, or credential must not reuse this snapshot.
          return { method: 'ssh', client: undefined as never, pool: { execCommands: async (_client, commands, options) => {
            const current = await readServerSnapshot(ref.id);
            if (!sameServerSnapshot(approved, current)
              || createHash('sha256').update(JSON.stringify(serverIdentityPayload(current))).digest('hex') !== initialIdentity) {
              throw new AdapterError('permission_denied');
            }
            const client = await sshSessionPool.getConnection(approved.host, approved.port, approved.username,
              approved.credentialType, approved.credentialValue, approved.hostKeyFingerprint, approved.sshTrustMode);
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
