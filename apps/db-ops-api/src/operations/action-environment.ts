/** P10 read-only preparation port. P07 owns invocation and execution; this
 * module has no command parameter and cannot send execute or receipt. */
import { createPublicKey, verify } from 'node:crypto';
import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { Client } from 'ssh2';
import { z } from 'zod';
import { createSshHostVerifier, normalizeSshHostKeyFingerprint } from '../security/ssh-host-key.js';
import { actionPlanContentSchema, OperationsError, operationsContentHash, type ActionPlanContent } from './contracts.js';
import { planRows, type ActionEnvironment, type PlanConnection } from './actions/plan-store.js';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
/** Wire-compatible with the reviewed P07 adapter/helper at 7c24a15d. Do not add
 * fields here: the helper computes the hash over exactly this registration. */
export const pilotTargetSchema = z.strictObject({
  protocol: z.literal(1), serverId: z.number().int().positive().safe(),
  host: z.literal('192.168.49.130'), port: z.literal(22), username: z.literal('slide-action'),
  unit: z.literal('slide-action-demo.service'), helper: z.literal('/usr/local/libexec/slide-action-demo-helper'),
  helperHash: hash, unitHash: hash, hostFingerprint: z.string(), toolVersion: z.literal('1'), eligible: z.literal(true),
});
export type PilotTarget = z.infer<typeof pilotTargetSchema>;
export const pilotManifestSchema = z.strictObject({
  schemaVersion: z.literal(1), target: pilotTargetSchema,
  policyVersion: z.string().min(1).max(128),
  verifier: actionPlanContentSchema.shape.verifier,
  validFrom: z.iso.datetime({ precision: 3 }), validUntil: z.iso.datetime({ precision: 3 }),
});
export type PilotManifest = z.infer<typeof pilotManifestSchema>;
const envelopeSchema = z.strictObject({ manifest: pilotManifestSchema, signature: z.string().regex(/^[A-Za-z0-9+/]{86}==$/) });
const inspectionSchema = z.strictObject({
  protocol: z.literal(1), configHash: hash, helperHash: hash, unitHash: hash,
  serverId: z.number().int().positive().safe(), unit: z.literal('slide-action-demo.service'),
  invocationId: z.string().regex(/^[a-f0-9]{32}$/),
});
const unavailable = () => new OperationsError('OPERATIONS_DEPENDENCY_UNAVAILABLE');
const invalid = () => new OperationsError('OPERATIONS_PRECONDITION_FAILED');
type Env = Readonly<Record<string, string | undefined>>;

async function file(path: string | undefined, limit: number, privateFile = false): Promise<string> {
  if (!path) throw unavailable();
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit || (stat.mode & 0o022) || (privateFile && (stat.mode & 0o077))) throw unavailable();
    // Bounded even if a file grows after stat().
    const buffer = Buffer.alloc(limit + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (!bytesRead || bytesRead > limit) throw unavailable();
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally { await handle.close(); }
}

/** Only deployment configuration supplies these files, never HTTP content.
 * Read on every operation so deleting/replacing a registration revokes it. */
export class RegisteredActionEnvironment implements ActionEnvironment {
  constructor(private readonly env: Env = process.env,
    private readonly inspect: (target: Readonly<PilotTarget>, privateKey: string) => Promise<unknown> = inspectPilot) {}

  private async registration(): Promise<PilotManifest> {
    try {
      const envelope = envelopeSchema.parse(JSON.parse(await file(this.env.OPERATIONS_PILOT_MANIFEST_FILE, 16_384)));
      const key = createPublicKey(await file(this.env.OPERATIONS_PILOT_PUBLIC_KEY_FILE, 4096));
      if (key.asymmetricKeyType !== 'ed25519' || !verify(null,
        Buffer.from(operationsContentHash(envelope.manifest)), key, Buffer.from(envelope.signature, 'base64'))) throw invalid();
      if (normalizeSshHostKeyFingerprint(envelope.manifest.target.hostFingerprint) !== envelope.manifest.target.hostFingerprint) throw invalid();
      return envelope.manifest;
    } catch (error) {
      if (error instanceof OperationsError) throw error;
      throw unavailable();
    }
  }

  /** Trusted draft material only; create() still performs every live check. */
  async proposal(targetId: number) {
    const manifest = await this.registration(), target = manifest.target;
    if (target.serverId !== targetId || Date.parse(manifest.validFrom) > Date.now()
      || Date.parse(manifest.validUntil) <= Date.now()) throw invalid();
    return { tool: { name: 'restart_demo_service' as const, version: target.toolVersion, hash: target.helperHash },
      parameters: { unit: target.unit }, policyVersion: manifest.policyVersion, verifier: manifest.verifier,
      preconditions: [{ kind: 'target_config_hash', expected: operationsContentHash(target) }],
      risk: 'medium' as const, rollback: { capability: 'none' as const, description: '重启不能恢复原进程内存；再次重启需要新计划与独立批准。' },
      validUntil: manifest.validUntil };
  }

  async validate(c: PlanConnection, content: Readonly<ActionPlanContent>, now: Date): Promise<void> {
    const manifest = await this.registration(), target = manifest.target;
    const valid = (clock: number) => {
      if (!Number.isFinite(clock) || Date.parse(manifest.validFrom) > clock || Date.parse(manifest.validUntil) <= clock
        || Date.parse(content.validFrom) < Date.parse(manifest.validFrom)
        || Date.parse(content.validUntil) > Date.parse(manifest.validUntil)) throw invalid();
    };
    valid(+now);
    if (content.target.type !== 'server' || content.target.id !== target.serverId
      || content.tool.name !== 'restart_demo_service' || content.tool.version !== target.toolVersion || content.tool.hash !== target.helperHash
      || content.parameters.unit !== target.unit || content.policyVersion !== manifest.policyVersion
      || operationsContentHash(content.verifier) !== operationsContentHash(manifest.verifier)
      || content.rollback.capability !== 'none' || content.risk !== 'medium'
      || content.preconditions.length !== 1 || content.preconditions[0].kind !== 'target_config_hash'
      || content.preconditions[0].expected !== operationsContentHash(target)) throw invalid();
    const [server] = await planRows(c, 'SELECT id,host,port,host_key_fingerprint FROM servers WHERE id=? FOR SHARE', [target.serverId]);
    if (!server || server.host !== target.host || Number(server.port) !== target.port
      || server.host_key_fingerprint !== target.hostFingerprint) throw invalid();
    let observation: z.infer<typeof inspectionSchema>;
    try {
      observation = inspectionSchema.parse(await this.inspect(target,
        await file(this.env.OPERATIONS_PILOT_SSH_KEY_FILE, 16_384, true)));
    } catch { throw unavailable(); }
    if (observation.configHash !== operationsContentHash(target) || observation.helperHash !== target.helperHash
      || observation.unitHash !== target.unitHash || observation.serverId !== target.serverId) throw invalid();
    // A slow SSH read cannot carry a stale/revoked registration through commit.
    if (operationsContentHash(await this.registration()) !== operationsContentHash(manifest)) throw invalid();
    const [clock] = await planRows(c, 'SELECT UTC_TIMESTAMP(3) AS now');
    valid(new Date(clock.now).getTime());
  }
}

/** A fresh connection avoids pooled credentials/identity crossing accounts.
 * Fixed target + pinned key + bounded output/time. No shell interpolation. */
export async function inspectPilot(target: Readonly<PilotTarget>, privateKey: string): Promise<unknown> {
  // Also validate callers of this exported read-only transport.
  const trusted = pilotTargetSchema.parse(target);
  const hostVerifier = createSshHostVerifier(trusted.hostFingerprint);
  return new Promise((resolve, reject) => {
    const client = new Client(); let settled = false;
    const finish = (error?: Error, value?: unknown) => {
      if (settled) return; settled = true; clearTimeout(timer); client.end();
      if (error) reject(unavailable()); else resolve(value);
    };
    const timer = setTimeout(() => finish(unavailable()), 20_000);
    client.once('error', () => finish(unavailable()));
    client.once('close', () => finish(unavailable()));
    client.once('ready', () => client.exec('sudo -n -- /usr/local/libexec/slide-action-demo-helper inspect', (error, stream) => {
      if (error) return finish(error);
      let output = '', bytes = 0;
      const take = (chunk: Buffer, stdout: boolean) => {
        bytes += chunk.length;
        if (bytes > 16_384) { stream.close(); finish(unavailable()); }
        else if (stdout) output += chunk.toString('utf8');
      };
      stream.on('data', chunk => take(chunk, true));
      stream.stderr.on('data', chunk => take(chunk, false));
      stream.once('error', () => finish(unavailable()));
      stream.once('close', (code: number, signal: string) => {
        if (code !== 0 || signal) return finish(unavailable());
        try { finish(undefined, JSON.parse(output)); } catch { finish(unavailable()); }
      });
    }));
    try { client.connect({ host: trusted.host, port: trusted.port, username: trusted.username, privateKey,
      hostVerifier, readyTimeout: 10_000, tryKeyboard: false, agentForward: false }); }
    catch { finish(unavailable()); }
  });
}
