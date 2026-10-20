import { chmod, readFile, writeFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { RegisteredActionEnvironment } from './action-environment.js';
import { syntheticPilot } from './action-environment.fixture.js';
import { proposedContent } from './actions/approval-binding.js';
import type { PlanConnection } from './actions/plan-store.js';
import type { ActorContext } from '../auth/actor-context.js';

describe('P10 trusted action environment', () => {
  let f: Awaited<ReturnType<typeof syntheticPilot>>, environment: RegisteredActionEnvironment;
  let server: any, clock: Date, inspect: Mock<(target: unknown, key: string) => Promise<unknown>>, connection: PlanConnection;
  const actor = { userId: 101, principalKind: 'user', roles: [], permissions: [], instanceScopes: {} } as unknown as ActorContext;
  const content = () => proposedContent(f.proposal(), actor, new Date());
  beforeEach(async () => {
    f = await syntheticPilot(); clock = new Date();
    server = { id: 501, host: f.manifest.target.host, port: 22, host_key_fingerprint: f.manifest.target.hostFingerprint };
    inspect = vi.fn(async () => f.inspection());
    environment = new RegisteredActionEnvironment(f.env, inspect);
    connection = { async execute(sql: string) {
      if (sql.includes('FROM servers')) { expect(sql).toContain('FOR SHARE'); return [[server]]; }
      if (sql.includes('UTC_TIMESTAMP')) return [[{ now: clock }]];
      throw Error('Unexpected SQL');
    } } as unknown as PlanConnection;
  });
  afterEach(async () => f?.close());
  it('builds draft material only from a verified protected registration without sending SSH', async () => {
    const draft=await environment.proposal(501);
    expect(draft.tool.hash).toBe(f.manifest.target.helperHash);
    expect(draft.policyVersion).toBe(f.manifest.policyVersion);
    expect(draft.verifier).toEqual(f.manifest.verifier);
    expect(inspect).not.toHaveBeenCalled();
    const {validUntil:_expiry,...input}=draft;
    const proposal=proposedContent({...input,schemaVersion:1,investigationId:'synthetic',resultVersion:1,target:{type:'server',id:501},evidence:f.proposal().evidence,relations:[],baselines:[],impact:'controlled'},actor,new Date(),1000);
    await expect(environment.validate(connection,proposal,new Date())).resolves.toBeUndefined();
  });
  it('rejects wrong target and altered unsigned registration during draft construction', async () => {
    await expect(environment.proposal(502)).rejects.toThrow('OPERATIONS_PRECONDITION_FAILED');
    const envelope=JSON.parse(await readFile(f.env.OPERATIONS_PILOT_MANIFEST_FILE,'utf8'));
    envelope.manifest.target.helperHash='f'.repeat(64);
    await writeFile(f.env.OPERATIONS_PILOT_MANIFEST_FILE,JSON.stringify(envelope));
    await expect(environment.proposal(501)).rejects.toThrow('OPERATIONS_PRECONDITION_FAILED');
    expect(inspect).not.toHaveBeenCalled();
  });
  it('checks exact registration, locked identity, live helper and complete verifier', async () => {
    await expect(environment.validate(connection, content(), new Date())).resolves.toBeUndefined();
    expect(inspect).toHaveBeenCalledOnce();
    expect(inspect.mock.calls[0][0]).toEqual(f.manifest.target);
  });
  it.each(['target', 'toolVersion', 'toolHash', 'policy', 'verifierVersion', 'verifierHash', 'config', 'noPrecondition', 'extraPrecondition', 'risk'])(
    'rejects altered %s before any SSH request', async field => {
      const p = content();
      if (field === 'target') p.target.id++;
      if (field === 'toolVersion') p.tool.version = 'unknown';
      if (field === 'toolHash') p.tool.hash = 'f'.repeat(64);
      if (field === 'policy') p.policyVersion = 'unknown';
      if (field === 'verifierVersion') p.verifier.version = 'unknown';
      if (field === 'verifierHash') p.verifier.definitionHash = 'f'.repeat(64);
      if (field === 'config') p.preconditions[0].expected = 'f'.repeat(64);
      if (field === 'noPrecondition') p.preconditions = [];
      if (field === 'extraPrecondition') p.preconditions.push(p.preconditions[0]);
      if (field === 'risk') p.risk = 'low';
      await expect(environment.validate(connection, p, new Date())).rejects.toThrow('OPERATIONS_PRECONDITION_FAILED');
      expect(inspect).not.toHaveBeenCalled();
    });
  it.each(['host', 'port', 'host_key_fingerprint'])('rejects changed SQL %s', async field => {
    server[field] = field === 'port' ? 2222 : 'unknown';
    await expect(environment.validate(connection, content(), new Date())).rejects.toThrow('OPERATIONS_PRECONDITION_FAILED');
    expect(inspect).not.toHaveBeenCalled();
  });
  it.each(['configHash', 'helperHash', 'unitHash', 'serverId', 'unit'])('rejects changed helper %s', async field => {
    inspect.mockResolvedValue({ ...f.inspection(), [field]: field === 'serverId' ? 502 : field === 'unit' ? 'ssh.service' : 'f'.repeat(64) });
    await expect(environment.validate(connection, content(), new Date())).rejects.toThrow();
  });
  it('rejects missing config, writable key and untrusted signature', async () => {
    await expect(new RegisteredActionEnvironment({}, inspect).validate(connection, content(), new Date())).rejects.toThrow();
    await chmod(f.env.OPERATIONS_PILOT_SSH_KEY_FILE, 0o644);
    await expect(environment.validate(connection, content(), new Date())).rejects.toThrow();
    await chmod(f.env.OPERATIONS_PILOT_SSH_KEY_FILE, 0o600);
    const envelope = JSON.parse(await readFile(f.env.OPERATIONS_PILOT_MANIFEST_FILE, 'utf8'));
    envelope.manifest.policyVersion = 'unsigned';
    await writeFile(f.env.OPERATIONS_PILOT_MANIFEST_FILE, JSON.stringify(envelope));
    await expect(environment.validate(connection, content(), new Date())).rejects.toThrow();
    expect(inspect).not.toHaveBeenCalled();
  });
  it.each(['expired', 'future', 'crossesExpiry', 'revokedDuringSSH'])('rejects %s registration', async field => {
    const p = content();
    if (field === 'expired') f.manifest.validUntil = new Date(Date.now() - 1).toISOString();
    if (field === 'future') f.manifest.validFrom = new Date(Date.now() + 60_000).toISOString();
    if (field === 'crossesExpiry') { clock = new Date(Date.parse(f.manifest.validUntil) + 1); }
    if (field === 'revokedDuringSSH') inspect.mockImplementation(async () => {
      f.manifest.policyVersion = 'revoked'; await f.save(); return f.inspection();
    });
    await f.save();
    await expect(environment.validate(connection, p, new Date())).rejects.toThrow('OPERATIONS_PRECONDITION_FAILED');
  });
});
