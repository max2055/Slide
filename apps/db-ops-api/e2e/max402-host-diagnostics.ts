/** Explicit real SSH acceptance; inventory/database facts are injected, no platform writes. */
import { redactSensitiveText } from '../src/security/log-redaction.js';
import { Value } from '@sinclair/typebox/value';
import { LinuxHostEvidenceSchema } from '../src/contracts/public-api.js';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import Fastify from 'fastify';
import { SshSessionPool } from '../src/ssh-session-pool.js';
import { ServerDiagnosticService, serverDiagnosticService } from '../src/server-diagnostic-service.js';
import { LinuxHostEvidenceService } from '../src/linux-host-evidence-service.js';
import { InstanceDiagnosticContextService, EVIDENCE_PACK_MAX_BYTES } from '../src/instance-diagnostic-context-service.js';
import { registerInstanceHostRoutes } from '../src/instance-host-routes.js';
import { getServerDiagnosticsTool } from '../src/tools/generated/slide-self-mgmt/server_tools.js';
import type { ActorContext } from '../src/auth/actor-context.js';

const host = process.env.SSH_HOST;
const passwordFile = process.env.SSH_PASSWORD_FILE;
const output = process.env.ACCEPTANCE_OUTPUT;
assert(host && passwordFile && output, 'SSH_HOST, SSH_PASSWORD_FILE, ACCEPTANCE_OUTPUT required');
const password = (await readFile(passwordFile, 'utf8')).trimEnd();
const username = process.env.SSH_USER ?? 'root';
const pin = process.env.SSH_HOST_KEY_FINGERPRINT;
const pool = new SshSessionPool();
const app = Fastify();
app.addHook('onError', async (_request, _reply, error) => { console.error(redactSensitiveText(error.message)); });
const originalGet = serverDiagnosticService.getDiagnostics;
let commands = 0;
const transport = {
  getConnection: pool.getConnection.bind(pool), releaseConnection: pool.releaseConnection.bind(pool),
  closeConnection: pool.closeConnection.bind(pool),
  execCommands: async (...args: Parameters<typeof pool.execCommands>) => {
    commands += args[1].length;
    return pool.execCommands(...args);
  },
};
const inventory = {
  getServerById: async () => ({ id: 402, host, port: 22, os_type: 'Kylin V10',
    credential_type: 'password', host_key_fingerprint: pin }),
  getDecryptedCredentials: async () => ({ username, password }),
};
const actor: ActorContext = {
  userId: 402, username: 'acceptance', roles: [], permissions: [
    'instance:view', 'servers:view', 'metric:view', 'log:view', 'alert:view',
  ], instanceScopes: { 402: 'read-only' }, sessionVersion: 1, requestId: 'max402-real-ssh',
};
try {
  const client = await pool.getConnection(host, 22, username, 'password', password, pin);
  const [identity] = await pool.execCommands(client, ['hostname; id -u; uname -m; ip -o -4 addr show']);
  assert.equal(identity.exitCode, 0);
  assert(identity.stdout.includes(host), 'DHCP address must match the connected VM');
  pool.releaseConnection(client);
  const diagnosticService = new ServerDiagnosticService({
    serverDatabaseService: inventory as any, sshSessionPool: transport,
  });
  const evidenceService = new LinuxHostEvidenceService({
    serverDatabaseService: inventory as any, sshSessionPool: transport,
  });
  const contextService = new InstanceDiagnosticContextService({
    getInstance: async () => ({ id: 402, name: 'max402-fixture', db_type: 'mysql' }),
    getRealtimeMetrics: async () => ({ qps: 12 }),
    getMetricHistory: async () => [], getAlerts: async () => [], getLogs: async () => [],
    getSlowQueries: async () => [], discoverStorage: async () => ({ descriptors: [], gaps: [] }),
    listHosts: async () => [{ serverId: 402, role: 'primary', host, port: 22,
      label: null, osType: 'Kylin V10', status: 'online', collectionEnabled: true, validFrom: new Date() }],
    collectHostEvidence: (id, request) => evidenceService.collectHostEvidence(id, request) as any,
    collectServerDiagnostics: id => diagnosticService.getDiagnostics(id),
  });
  await registerInstanceHostRoutes(app, {
    verifyToken: async (request, reply) => {
      if (request.headers.authorization !== 'Bearer max402-fixture') return reply.code(401).send({ error: 'AUTHENTICATION_REQUIRED' });
      (request as any).user = actor;
    },
    service: {} as any, serverLookup: inventory, evidenceService: {
      collect: async (...args) => {
        const pack = await contextService.collect(...args);
        for (const item of pack.hosts) {
          assert(Value.Check(LinuxHostEvidenceSchema, item.evidence), 'Real host evidence must conform to the public schema');
        }
        return pack;
      },
    },
  });
  const response = await app.inject({ method: 'GET', url: '/api/database/instances/402/host-evidence',
    headers: { authorization: 'Bearer max402-fixture' } });
  assert.equal(response.statusCode, 200, response.body);
  const pack = response.json();
  assert.equal(pack.database.instance.id, 402);
  assert.equal(pack.hosts.length, 1);
  const diagnostics = pack.hosts[0].diagnostics;
  assert.equal(diagnostics.serverId, 402);
  assert.deepEqual(diagnostics.recentSystemLogs, diagnostics.sections.systemLogs);
  assert.equal(new Set(diagnostics.gaps.map((g: any) => JSON.stringify([g.section, g.reason]))).size, diagnostics.gaps.length);
  assert(Buffer.byteLength(response.body) <= EVIDENCE_PACK_MAX_BYTES);
  // Bind the real SSH-backed service into the production tool for this isolated process only.
  serverDiagnosticService.getDiagnostics = diagnosticService.getDiagnostics.bind(diagnosticService);
  const tool = await getServerDiagnosticsTool.handler({ serverId: 402 }, { actor });
  assert(tool.success);
  assert.equal(tool.details?.expiresAt, diagnostics.expiresAt);
  assert(!Object.hasOwn(tool.details!, 'freshness'));
  assert.equal((await app.inject({ method: 'GET', url: '/api/database/instances/402/host-evidence' })).statusCode, 401);
  await writeFile(output, JSON.stringify({
    scope: 'Real SSH and fixed commands; injected inventory/database facts and fixture authentication; Fastify production route via inject; no platform DB or model call',
    host, identity: identity.stdout.trim(), commands, packBytes: Buffer.byteLength(response.body),
    diagnostics: { collectedAt: diagnostics.collectedAt, expiresAt: diagnostics.expiresAt,
      quality: diagnostics.quality, gaps: diagnostics.gaps,
      sections: Object.fromEntries(Object.entries(diagnostics.sections).map(([name, value]) => {
        const section = value as any;
        return [name, { source: section.source, quality: section.quality, count: section.items.length }];
      })) },
    toolDetails: tool.details, unauthorizedStatus: 401, testExitCode: 0,
  }, null, 2) + '\n');
  console.log('MAX-402 real SSH → host evidence HTTP serialization → diagnostic tool passed');
} finally {
  serverDiagnosticService.getDiagnostics = originalGet;
  await app.close();
  pool.closeAll();
}
