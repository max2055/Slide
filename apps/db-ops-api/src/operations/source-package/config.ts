import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { pilotTargetSchema } from '../action-environment.js';

const id = z.number().int().positive().safe();
export const sourcePackageSchema = z.strictObject({
  schemaVersion: z.literal(1), operationId: z.uuid(),
  database: z.string().regex(/^slide_v23_source_[a-f0-9]{8,32}$/),
  deadline: z.iso.datetime({ precision: 3 }),
  phase: z.enum(['collect', 'evaluate', 'continue', 'investigate', 'plan']),
  serverId: z.literal(3), instanceId: id,
  instanceHost: z.enum(['127.0.0.1', '192.168.49.130']),
  maxMetricJobs: z.number().int().min(1).max(12),
  actorId: id, serviceActorId: id, sessionVersion: z.number().int().positive(),
  // Operator-imported immutable package revisions. No package/target overrides in a job.
  revisions: z.strictObject({ server: id, instance: id }),
  alertRules: z.array(z.strictObject({ id, metricName: z.enum(['filesystem_used_bytes', 'filesystem_size_bytes', 'host.filesystem.used_bytes', 'host.filesystem.size_bytes']),
    operator: z.enum(['>', '<', '>=', '<=', '=', '!=']), threshold: z.number().finite(),
    durationSeconds: z.number().int().min(0).max(120),
    dimensions: z.strictObject({ mount: z.string().min(1).max(256), device: z.string().min(1).max(256), fs_type: z.string().min(1).max(32) }) })).min(1).max(2),
  api: z.string().regex(/^http:\/\/127\.0\.0\.1:(19[0-9]{3})$/),
  investigationId: z.uuid().optional(), requestId: z.uuid().optional(),
  target: pilotTargetSchema,
}).superRefine((v, c) => {
  if (v.target.serverId !== v.serverId) c.addIssue({ code: 'custom', message: 'SOURCE_TARGET_IDENTITY' });
  if (new Set(v.alertRules.map(r => r.id)).size !== v.alertRules.length) c.addIssue({ code: 'custom', message: 'SOURCE_RULE_DUPLICATE' });
  if (['continue', 'investigate', 'plan'].includes(v.phase) && (!v.investigationId || !v.requestId))
    c.addIssue({ code: 'custom', message: 'SOURCE_EXACT_REQUEST_REQUIRED' });
});
export type SourcePackage = z.infer<typeof sourcePackageSchema>;
export const sourceFailure = (code: string): never => { throw new Error(`V23_SOURCE_${code}`); };
export const bytesHash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export function sourceDefinitions() {
  const policyBytes = readFileSync(new URL('./definitions/policy.json', import.meta.url));
  const verifierBytes = readFileSync(new URL('./definitions/verifier.json', import.meta.url));
  const policy = JSON.parse(policyBytes.toString()), definition = JSON.parse(verifierBytes.toString());
  return { policy, definition, policyHash: bytesHash(policyBytes), verifierHash: bytesHash(verifierBytes),
    verifier: { id: definition.id as string, version: definition.version as string, definitionHash: bytesHash(verifierBytes),
      beforeSeconds: 120 as const, readinessSeconds: 60 as const, observationSeconds: 300 as const,
      intervalSeconds: 10 as const, maxExtraRestarts: 0 as const, requireAllHealthy: true as const } };
}
/** Midpoint uncertainty includes the full round trip; no offset correction or backdating. */
export function assertSourceClock(before: number, after: number, remote: number) {
  if (![before, after, remote].every(Number.isFinite) || after < before || after - before > 1000
    || Math.max(Math.abs(remote - before), Math.abs(remote - after)) > 2000) sourceFailure('CLOCK_UNTRUSTED');
}
export function assertSourceDeadline(config: SourcePackage, now = Date.now()) {
  const remaining = Date.parse(config.deadline) - now;
  if (remaining <= 0 || remaining > 600_000) sourceFailure('DEADLINE');
}
