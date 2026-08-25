import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import { requirePermission } from '../auth/require-permission.js';
import { strictBody, warnUnknown } from '../utils/strict-body.js';
import { publicNetworkDeviceDto } from '../security/public-dto.js';
import { dbConnection } from '../db-connection.js';
import { networkDeviceDatabaseService } from './network-device-database-service.js';
import { NetworkDeviceCollector, networkDeviceCollector, type NetworkDeviceCollectionStore } from './network-device-collector.js';
import { ConfigBackupError, configBackupService, type ConfigBackupService } from './config-backup-service.js';
import { HuaweiAdapter } from './huawei-adapter.js';
import { SnmpClient, SnmpClientError } from './snmp-client.js';
import { validateNetworkHost, validatePort, validateSnmpV3Credential } from '../resources/network-device-types.js';
import { capabilityService } from '../resources/capability-service.js';
import { resourceService } from '../resources/resource-service.js';
import type { ActorContext } from '../auth/actor-context.js';
import { hasPermission } from '../auth/require-permission.js';
import { authorizeServerTarget } from '../security/server-target-policy.js';
import type { ResourceRelationType } from '../resources/types.js';

export async function registerNetworkDeviceRoutes(
  fastify: FastifyInstance,
  verifyToken: preHandlerHookHandler,
  dependencies: {
    collector?: Pick<NetworkDeviceCollector, 'collectDevice'>;
    backupService?: Pick<ConfigBackupService, 'collect' | 'capture' | 'list' | 'get' | 'diff'>;
    snmpAdapter?: Pick<HuaweiAdapter, 'probe'>;
    authorizeTarget?: typeof authorizeServerTarget;
  } = {},
): Promise<void> {
  const collector = dependencies.collector ?? networkDeviceCollector;
  const backups = dependencies.backupService ?? configBackupService;
  const snmpAdapter = dependencies.snmpAdapter ?? new HuaweiAdapter(new SnmpClient());
  const authorizeTarget = dependencies.authorizeTarget ?? authorizeServerTarget;
  const view = [verifyToken, requirePermission('network_devices:view')];
  const manage = [verifyToken, requirePermission('network_devices:manage')];
  const backupRead = [verifyToken, requirePermission('network_devices:view')];
  const backupWrite = [verifyToken, requirePermission('network_devices:backup')];

  const routeId = (request: any): number | null => {
    const raw = request.params?.id;
    const id = typeof raw === 'string' && /^[1-9]\d*$/.test(raw) ? Number(raw) : Number.NaN;
    return Number.isSafeInteger(id) && id > 0 ? id : null;
  };
  const actor = (request: any): ActorContext => request.user as ActorContext;
  const safeNetworkError = (error: unknown): { status: number; error: string } => {
    const code = error instanceof ConfigBackupError ? error.code : error instanceof SnmpClientError ? error.code : error instanceof Error ? error.message : '';
    if (code === 'NETWORK_DEVICE_NOT_FOUND' || code === 'CONFIG_BACKUP_NOT_FOUND') return { status: 404, error: code };
    if (code === 'RESOURCE_FORBIDDEN') return { status: 403, error: code };
    if (/^(?:SNMP_|SSH_|CONFIG_|NETWORK_DEVICE_|RESOURCE_)[A-Z0-9_]*$/.test(code)) return { status: 400, error: code };
    return { status: 500, error: 'NETWORK_DEVICE_OPERATION_FAILED' };
  };
  const serializeCapabilityRow = (row: any) => ({
    key: row.key ?? row.capabilityKey,
    state: row.state,
    evidence: typeof row.evidence === 'string' ? safeJson(row.evidence) : row.evidence ?? null,
    reason: row.reason ?? null,
    checkedAt: row.checkedAt instanceof Date ? row.checkedAt.toISOString() : row.checkedAt ? new Date(row.checkedAt).toISOString() : null,
    validUntil: row.validUntil instanceof Date ? row.validUntil.toISOString() : row.validUntil ? new Date(row.validUntil).toISOString() : null,
  });
  const serializeCapability = (value: any) => serializeCapabilityRow({ ...value, key: value.key, checkedAt: value.checkedAt, validUntil: value.validUntil });
  const safeJson = (value: string): unknown => { try { return JSON.parse(value); } catch { return null; } };
  const serializeBackup = (value: any, includeContent = false) => {
    if (!value || typeof value !== 'object') return value;
    const { contentEncrypted: _contentEncrypted, content, ...summary } = value;
    return includeContent && typeof content === 'string' ? { ...summary, content } : summary;
  };

  fastify.get('/api/network-devices', { preHandler: view }, async (_request, reply) => {
    try { return reply.send(await networkDeviceDatabaseService.getAllDevices()); }
    catch { return reply.code(500).send({ error: '获取网络设备列表失败' }); }
  });

  // Keep the static probe endpoint before /:id. Secrets are accepted only for
  // the in-memory probe and are never persisted or included in the response.
  fastify.post('/api/network-devices/test-connection', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } }, preHandler: manage }, async (request, reply) => {
    try {
      const check = strictBody(request.body as Record<string, unknown>, ['host', 'version', 'snmpPort', 'snmp_port', 'snmpv3', 'snmp', 'vendor'], 'POST /api/network-devices/test-connection');
      if (check.error) return reply.code(400).send(check.error);
      const body = check.body as Record<string, unknown>;
      if (body.vendor !== undefined && body.vendor !== 'huawei') return reply.code(400).send({ success: false, error: 'NETWORK_DEVICE_VENDOR_UNSUPPORTED' });
      if (body.version !== undefined && body.version !== 3) return reply.code(400).send({ success: false, error: 'SNMP_UNSUPPORTED_SECURITY' });
      const host = validateNetworkHost(body.host);
      const port = validatePort(body.snmpPort ?? body.snmp_port, 'snmp_port', 161);
      const credential = validateSnmpV3Credential(body.snmpv3 ?? body.snmp);
      if (!['SHA', 'MD5', undefined].includes(credential.authProtocol as any) || !['AES', 'DES', undefined].includes(credential.privacyProtocol as any)) {
        return reply.code(400).send({ success: false, error: 'SNMP_UNSUPPORTED_SECURITY' });
      }
      const target = await authorizeTarget({ host, port }, { allowedPorts: [port], allowedCidrs: process.env.NETWORK_DEVICE_ALLOWED_CIDRS });
      const probe = await snmpAdapter.probe({ host: target.address, port, username: credential.username, securityLevel: credential.securityLevel, authProtocol: credential.authProtocol as any, authSecret: credential.authSecret, privacyProtocol: credential.privacyProtocol as any, privacySecret: credential.privacySecret });
      return reply.send({ success: Boolean(probe.reachable), probe: { reachable: Boolean(probe.reachable), quality: probe.quality, reason: probe.reason, observedAt: probe.observedAt.toISOString(), sysName: probe.sysName, uptimeSeconds: probe.uptimeSeconds } });
    } catch (error) {
      const failure = safeNetworkError(error);
      return reply.code(failure.status === 500 ? 502 : failure.status).send({ success: false, error: failure.error });
    }
  });

  fastify.get('/api/network-devices/test-connection', { preHandler: view }, async (_request, reply) => {
    return reply.code(405).send({ error: 'SNMP_TEST_REQUIRES_POST' });
  });

  fastify.get('/api/network-devices/:id', { preHandler: view }, async (request, reply) => {
    const id = routeId(request);
    if (id === null) return reply.code(400).send({ error: '资源 ID 无效' });
    try {
      const device = await networkDeviceDatabaseService.getDeviceById(id);
      return device ? reply.send(publicNetworkDeviceDto(device as any)) : reply.code(404).send({ error: '网络设备不存在' });
    } catch { return reply.code(500).send({ error: '获取网络设备详情失败' }); }
  });

  fastify.post('/api/network-devices/:id/probe', { preHandler: view }, async (request, reply) => {
    const id = routeId(request);
    if (id === null) return reply.code(400).send({ error: '资源 ID 无效' });
    try {
      const result = await collector.collectDevice(id);
      return reply.code(result.success ? 200 : 502).send(result);
    } catch (error) {
      const failure = safeNetworkError(error);
      return reply.code(failure.status).send({ error: failure.error });
    }
  });

  fastify.get('/api/network-devices/:id/capabilities', { preHandler: view }, async (request, reply) => {
    const id = routeId(request);
    if (id === null) return reply.code(400).send({ error: '资源 ID 无效' });
    try {
      const key = typeof (request.query as any)?.key === 'string' ? String((request.query as any).key) : undefined;
      if (key) {
        const value = await capabilityService.get(actor(request), { type: 'network_device', id }, key);
        return reply.send({ deviceId: id, capabilities: value ? [serializeCapability(value)] : [] });
      }
      const pool = dbConnection.getPool();
      if (!pool) return reply.code(500).send({ error: '数据库未连接' });
      const [rows] = await pool.execute<any[]>(
        `SELECT capability_key AS capabilityKey, state, evidence, reason, checked_at AS checkedAt, valid_until AS validUntil
         FROM resource_capabilities WHERE resource_type = 'network_device' AND resource_id = ? ORDER BY capability_key`, [id]);
      return reply.send({ deviceId: id, capabilities: rows.map(serializeCapabilityRow) });
    } catch (error) {
      const failure = safeNetworkError(error);
      return reply.code(failure.status).send({ error: failure.error });
    }
  });

  fastify.post('/api/network-devices', { preHandler: manage }, async (request, reply) => {
    try {
      const check = strictBody(request.body as Record<string, unknown>, ['name', 'label', 'host', 'site', 'vendor', 'model', 'osVersion', 'os_version', 'serialNumber', 'serial_number', 'snmpPort', 'snmp_port', 'sshPort', 'ssh_port', 'collectionEnabled', 'snmpv3', 'snmp', 'ssh'], 'POST /api/network-devices');
      if (check.error) return reply.code(400).send(check.error);
      const result = await networkDeviceDatabaseService.createDevice(check.body);
      if (!result.success) return reply.code(result.error?.includes('已被纳管') ? 409 : 400).send({ error: result.error });
      const created = await networkDeviceDatabaseService.getDeviceById(result.deviceId!);
      return reply.code(201).send(publicNetworkDeviceDto(created as any));
    } catch (error: any) { return reply.code(400).send({ error: error?.message || '网络设备参数无效' }); }
  });

  fastify.put('/api/network-devices/:id', { preHandler: manage }, async (request, reply) => {
    const id = routeId(request);
    if (id === null) return reply.code(400).send({ error: '资源 ID 无效' });
    try {
      const check = strictBody(request.body as Record<string, unknown>, ['name', 'label', 'host', 'site', 'vendor', 'model', 'osVersion', 'os_version', 'serialNumber', 'serial_number', 'snmpPort', 'snmp_port', 'sshPort', 'ssh_port', 'collectionEnabled', 'snmpv3', 'snmp', 'ssh'], 'PUT /api/network-devices/:id');
      if (check.error) return reply.code(400).send(check.error);
      const result = await networkDeviceDatabaseService.updateDevice(id, check.body);
      if (!result.success) return reply.code(result.error === '网络设备不存在' ? 404 : 400).send({ error: result.error });
      const updated = await networkDeviceDatabaseService.getDeviceById(id);
      return reply.send(publicNetworkDeviceDto(updated as any));
    } catch (error: any) { return reply.code(400).send({ error: error?.message || '网络设备参数无效' }); }
  });

  fastify.delete('/api/network-devices/:id', { preHandler: manage }, async (request, reply) => {
    const id = routeId(request);
    if (id === null) return reply.code(400).send({ error: '资源 ID 无效' });
    const result = await networkDeviceDatabaseService.deleteDevice(id);
    if (!result.success) return reply.code(result.error === '网络设备不存在' ? 404 : result.error === 'NETWORK_DEVICE_HAS_RELATIONS' ? 409 : 400).send({ error: result.error });
    return reply.send({ ok: true });
  });

  fastify.get('/api/network-devices/:id/metrics', { preHandler: view }, async (request, reply) => {
    const id = routeId(request);
    if (id === null) return reply.code(400).send({ error: '资源 ID 无效' });
    const pool = dbConnection.getPool();
    if (!pool) return reply.code(500).send({ error: '数据库未连接' });
    const [rows] = await pool.execute<any[]>(
      `SELECT metric_id AS metricId, metric_value AS value, observed_at AS observedAt, quality, source, dimensions
       FROM network_device_observations WHERE device_id = ? ORDER BY observed_at DESC, id DESC LIMIT 1000`, [id]);
    return reply.send({ deviceId: id, metrics: rows.map((row) => ({ ...row, observedAt: row.observedAt ? new Date(row.observedAt).toISOString() : null, dimensions: typeof row.dimensions === 'string' ? JSON.parse(row.dimensions) : row.dimensions })) });
  });

  fastify.get('/api/network-devices/:id/interfaces', { preHandler: view }, async (request, reply) => {
    const id = routeId(request);
    if (id === null) return reply.code(400).send({ error: '资源 ID 无效' });
    const pool = dbConnection.getPool();
    if (!pool) return reply.code(500).send({ error: '数据库未连接' });
    const [rows] = await pool.execute<any[]>(
      `SELECT id, device_id AS deviceId, if_index AS ifIndex, if_name AS ifName, if_alias AS ifAlias, speed_bps AS speedBps, admin_status AS adminStatus, oper_status AS operStatus, last_seen_at AS lastSeenAt
       FROM network_device_interfaces WHERE device_id = ? ORDER BY if_index`, [id]);
    return reply.send({ interfaces: rows.map((row) => ({ ...row, lastSeenAt: row.lastSeenAt ? new Date(row.lastSeenAt).toISOString() : null })) });
  });

  fastify.post('/api/network-devices/:id/config-backups', { preHandler: backupWrite }, async (request, reply) => {
    const id = routeId(request);
    if (id === null) return reply.code(400).send({ error: '资源 ID 无效' });
    try {
      const result = await backups.capture!(id, Number((request as any).user?.userId ?? 0) || null);
      if (!result.success) return reply.code(502).send({ error: result.error ?? 'CONFIG_BACKUP_FAILED' });
      // A successful capture may create a new version (or return an existing
      // hash-deduplicated version), and both are represented as a resource.
      return reply.code(201).send(serializeBackup(result.backup ?? result));
    } catch (error) {
      const failure = safeNetworkError(error);
      return reply.code(failure.status === 500 ? 502 : failure.status).send({ error: failure.error });
    }
  });

  fastify.get('/api/network-devices/:id/config-backups', { preHandler: backupRead }, async (request, reply) => {
    const id = routeId(request);
    if (id === null) return reply.code(400).send({ error: '资源 ID 无效' });
    try {
      return reply.send({ backups: await backups.list!(id, 100) });
    } catch (error) {
      const failure = safeNetworkError(error);
      return reply.code(failure.status).send({ error: failure.error });
    }
  });

  fastify.get('/api/network-devices/:id/config-backups/:backupId', { preHandler: backupRead }, async (request, reply) => {
    const id = routeId(request);
    const backupId = typeof (request.params as any)?.backupId === 'string' && /^[1-9]\d*$/.test((request.params as any).backupId) ? Number((request.params as any).backupId) : Number.NaN;
    if (id === null || !Number.isSafeInteger(backupId) || backupId < 1) return reply.code(400).send({ error: '资源 ID 无效' });
    const raw = String((request.query as any)?.raw ?? '').toLowerCase() === 'true';
    if (raw && !hasPermission(new Set((request as any).user?.permissions ?? []), 'network_devices:backup')) return reply.code(403).send({ error: '权限不足' });
    try {
      const value = await backups.get!(id, backupId, raw, Number((request as any).user?.userId ?? 0) || null);
      return value ? reply.send(serializeBackup(value, raw)) : reply.code(404).send({ error: 'CONFIG_BACKUP_NOT_FOUND' });
    } catch (error) {
      const failure = safeNetworkError(error);
      return reply.code(failure.status).send({ error: failure.error });
    }
  });

  fastify.get('/api/network-devices/:id/config-backups/:backupId/diff', { preHandler: backupRead }, async (request, reply) => {
    const id = routeId(request);
    const backupId = typeof (request.params as any)?.backupId === 'string' && /^[1-9]\d*$/.test((request.params as any).backupId) ? Number((request.params as any).backupId) : Number.NaN;
    const fromId = Number((request.query as any)?.from ?? (request.query as any)?.fromId);
    if (id === null || !Number.isSafeInteger(backupId) || backupId < 1 || !Number.isSafeInteger(fromId) || fromId < 1) return reply.code(400).send({ error: 'CONFIG_BACKUP_DIFF_INVALID' });
    try {
      const value = await backups.diff!(id, fromId, backupId);
      if (value?.success === false) return reply.code(404).send({ error: value.error });
      return reply.send(value);
    } catch (error) {
      const failure = safeNetworkError(error);
      return reply.code(failure.status).send({ error: failure.error });
    }
  });

  fastify.get('/api/network-devices/:id/relations', { preHandler: view }, async (request, reply) => {
    const id = routeId(request);
    if (id === null) return reply.code(400).send({ error: '资源 ID 无效' });
    try {
      const relations = await resourceService.currentRelations(actor(request), { type: 'network_device', id });
      return reply.send({ relations: relations.map(serializeRelation) });
    } catch (error) {
      const failure = safeNetworkError(error);
      return reply.code(failure.status).send({ error: failure.error });
    }
  });

  fastify.put('/api/network-devices/:id/relations', { preHandler: manage }, async (request, reply) => {
    const id = routeId(request);
    if (id === null) return reply.code(400).send({ error: '资源 ID 无效' });
    const body = request.body as any;
    const input = Array.isArray(body) ? body : body?.relations;
    if (!Array.isArray(input) || input.length > 32) return reply.code(400).send({ error: 'RESOURCE_RELATIONS_INVALID' });
    try {
      for (const raw of input) {
        const target = raw?.target;
        const relationType = raw?.relationType as ResourceRelationType;
        if (!target || !['server', 'network_device'].includes(target.type) || !['connected_to', 'serves'].includes(relationType)) throw new Error('RESOURCE_RELATION_TOPOLOGY_INVALID');
        const relation = {
          source: { type: 'network_device' as const, id }, target: { type: target.type, id: Number(target.id) }, relationType,
          provenance: typeof raw.provenance === 'string' ? raw.provenance : 'api', metadata: raw.metadata ?? null,
          validFrom: raw.validFrom ? new Date(raw.validFrom) : new Date(), validUntil: raw.validUntil ? new Date(raw.validUntil) : null,
        } as any;
        await resourceService.createRelation(actor(request), relation);
      }
      const relations = await resourceService.currentRelations(actor(request), { type: 'network_device', id });
      return reply.send({ relations: relations.map(serializeRelation) });
    } catch (error) {
      const failure = safeNetworkError(error);
      return reply.code(failure.status === 500 ? 400 : failure.status).send({ error: failure.error });
    }
  });
}

function serializeRelation(relation: any): any {
  return { ...relation, validFrom: relation.validFrom instanceof Date ? relation.validFrom.toISOString() : relation.validFrom, validUntil: relation.validUntil instanceof Date ? relation.validUntil.toISOString() : relation.validUntil ?? null };
}
