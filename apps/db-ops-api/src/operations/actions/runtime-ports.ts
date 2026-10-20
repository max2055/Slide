/** Deployment-owned ports. HTTP never supplies configuration, URLs or credentials. */
import { createPublicKey, createHash } from 'node:crypto';
import { z } from 'zod';
import { RegisteredActionEnvironment, readProtectedActionFile } from '../action-environment.js';
import { OperationsError, operationsContentHash } from '../contracts.js';
import { RestartDemoServiceAdapter } from './adapters/restart-demo-service.js';
import { ActionEvidenceAdapter, type ActionHealthSource } from './evidence-adapter.js';
import type { ActionAdapter } from './executor.js';

type Env = Readonly<Record<string, string | undefined>>;
const keys = ['OPERATIONS_PILOT_MANIFEST_FILE', 'OPERATIONS_PILOT_PUBLIC_KEY_FILE',
  'OPERATIONS_PILOT_SSH_KEY_FILE', 'OPERATIONS_ACTION_TARGET_SIGNATURE_FILE',
  'OPERATIONS_ACTION_VERIFIER_FILE', 'OPERATIONS_ACTION_HEALTH_FILE'] as const;
export function actionRuntimeConfigured(env: Env): boolean { return keys.every(key => Boolean(env[key])); }
const unavailable = () => new OperationsError('OPERATIONS_DEPENDENCY_UNAVAILABLE');

/** Bounded, read-only collector protocol. History must already exist; never
 * backfill observations or derive service health from the executor's exit code. */
export class HttpActionHealthSource implements ActionHealthSource {
  constructor(private readonly base: URL) {
    if (base.username || base.password || base.search || base.hash
      || !(base.protocol === 'https:' || (base.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(base.hostname)))) throw unavailable();
  }
  private async read(mode: string, from?: string, until?: string): Promise<unknown> {
    const url = new URL(this.base);
    url.searchParams.set('mode', mode);
    if (from) url.searchParams.set('from', from);
    if (until) url.searchParams.set('until', until);
    const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(900), headers: { 'Cache-Control': 'no-store' } });
    if (!response.ok || !response.body) throw unavailable();
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 64_000) throw unavailable();
        chunks.push(value);
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } finally { await reader.cancel(); }
  }
  async history(from: string, until: string): Promise<readonly unknown[]> {
    const data = await this.read('history', from, until);
    if (!Array.isArray(data) || data.length > 100) throw unavailable();
    return data;
  }
  sample(): Promise<unknown> { return this.read('sample'); }
}

/** Reload protected files for every use. Target signature uses the existing
 * P07 adapter protocol; the manifest separately signs policy/verifier/expiry. */
async function loadActionAdapter(env: Env, current: boolean) {
  const environment = new RegisteredActionEnvironment(env);
  const manifest = await environment.registration(), target = manifest.target;
  if (current && (Date.parse(manifest.validFrom) > Date.now() || Date.parse(manifest.validUntil) <= Date.now())) throw unavailable();
  const key = createPublicKey(await readProtectedActionFile(env.OPERATIONS_PILOT_PUBLIC_KEY_FILE, 4096));
  const signature = Buffer.from((await readProtectedActionFile(env.OPERATIONS_ACTION_TARGET_SIGNATURE_FILE, 1024)).trim(), 'base64');
  const adapter = new RestartDemoServiceAdapter(target, signature, key, async () => ({
    privateKey: await readProtectedActionFile(env.OPERATIONS_PILOT_SSH_KEY_FILE, 16_384, true),
  }));
  return { manifest, target, adapter };
}
export async function loadActionRuntimePorts(env: Env) {
  if (!actionRuntimeConfigured(env)) throw unavailable();
  try {
    const { manifest, target, adapter } = await loadActionAdapter(env, true);
    const bytes = Buffer.from(await readProtectedActionFile(env.OPERATIONS_ACTION_VERIFIER_FILE, 16_384));
    if (createHash('sha256').update(bytes).digest('hex') !== manifest.verifier.definitionHash) throw unavailable();
    const health = z.strictObject({ url: z.url() }).parse(JSON.parse(await readProtectedActionFile(env.OPERATIONS_ACTION_HEALTH_FILE, 4096)));
    const evidence = new ActionEvidenceAdapter({ ...manifest.verifier, serverId: target.serverId,
      configHash: operationsContentHash(target), helperHash: target.helperHash, unitHash: target.unitHash,
      hostFingerprint: target.hostFingerprint }, new HttpActionHealthSource(new URL(health.url)), bytes);
    return { adapter, evidence };
  } catch { throw unavailable(); }
}

export function registeredActionAdapter(env: Env): ActionAdapter {
  return {
    preflight: async plan => (await loadActionRuntimePorts(env)).adapter.preflight(plan),
    execute: async invocation => (await loadActionRuntimePorts(env)).adapter.execute(invocation),
    receipt: async (plan, id) => {
      // Historical read-only receipt remains independent of rollout flags,
      // health configuration and manifest admission expiry. The original
      // signed target/config must still match the immutable plan.
      try { return await (await loadActionAdapter(env, false)).adapter.receipt(plan, id); }
      catch { throw unavailable(); }
    },
  };
}
