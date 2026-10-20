/** Parent-signed, exact-successor authorization. No signing/approval command is
 * exposed to the implementation operator. The parent provisions the trust key
 * separately after independent review; absence fails closed. */
import { createPublicKey, verify } from 'node:crypto';
import { z } from 'zod';
import { assertSourceDeadline, bytesHash, sourceFailure, type SourcePackage } from './config.js';
const digest = z.string().regex(/^[a-f0-9]{64}$/), head = z.string().regex(/^[a-f0-9]{40}$/);
export const sourceAuditPublicKeyPath = '/Users/max/Coding/40-Slide/outputs/2026-10-18-v23-source/parent-source-audit-public-key.pem';
export const sourceAuditSchema = z.strictObject({
  schemaVersion: z.literal(1), reviewId: z.uuid(),
  reviewerId: z.literal('1ef5122f-7ac8-4a18-8f18-cae01ffd527d'), reviewEvidenceHash: digest,
  decision: z.literal('pre_execution_connection_failure_zero_usage'), failureCode: z.literal('V23_SOURCE_INSTANCE_CONNECTION'),
  metricsJobs: z.literal(0), modelUsage: z.literal(0), reviewedAt: z.iso.datetime({ precision: 3 }), expiresAt: z.iso.datetime({ precision: 3 }),
  predecessor: z.strictObject({ intentId: z.uuid(), operationId: z.uuid(), configHash: digest, head, jobHash: digest }),
  successor: z.strictObject({ operationId: z.uuid(), configHash: digest, head, lockHash: digest,
    database: z.string(), databaseServerUuid: z.uuid(), databasePort: z.number().int().min(1024).max(65535).refine(p => ![3306, 3307, 3308].includes(p)), deadline: z.iso.datetime({ precision: 3 }) }),
});
export const sourceContinuationAuditSchema = sourceAuditSchema.omit({ decision: true, failureCode: true, metricsJobs: true, modelUsage: true }).extend({
  decision: z.literal('known_partial_explicit_continuation'),
  partial: z.strictObject({ investigationId: z.uuid(), requestId: z.uuid(), runId: z.uuid(), resultVersion: z.number().int().positive(),
    executionJobId: z.uuid(), executionJobHash: digest, recordsHash: digest }),
});
export type SourceAudit = z.infer<typeof sourceAuditSchema> | z.infer<typeof sourceContinuationAuditSchema>;
export interface SourceAuditInput { envelope: Buffer; publicKey: Buffer; binding: { head: string; configHash: string; lockHash: string; databasePort: number }; }
export const sourceIntentHash = (row: unknown) => bytesHash(JSON.stringify([row]));
export function verifySourceAudit(input: SourceAuditInput, config: SourcePackage): SourceAudit {
  assertSourceDeadline(config);
  const envelope = z.strictObject({ payload: z.string().max(16000), signature: z.string().regex(/^[A-Za-z0-9+/]{86}==$/) })
    .parse(JSON.parse(input.envelope.toString()));
  const bytes = Buffer.from(envelope.payload, 'base64'), key = createPublicKey(input.publicKey);
  if (key.asymmetricKeyType !== 'ed25519' || !verify(null, bytes, key, Buffer.from(envelope.signature, 'base64')))
    sourceFailure('AUDIT_SIGNATURE');
  const receipt = z.union([sourceAuditSchema, sourceContinuationAuditSchema]).parse(JSON.parse(bytes.toString())), next = receipt.successor;
  if (receipt.predecessor.operationId === config.operationId || config.phase !== (receipt.decision === 'known_partial_explicit_continuation' ? 'continue' : 'collect')
    || next.operationId !== config.operationId || next.database !== config.database || next.deadline !== config.deadline
    || next.databasePort !== input.binding.databasePort
    || next.head !== input.binding.head || next.configHash !== input.binding.configHash || next.lockHash !== input.binding.lockHash)
    sourceFailure('AUDIT_BINDING');
  if (receipt.decision === 'known_partial_explicit_continuation'
    && (receipt.partial.investigationId !== config.investigationId || receipt.partial.requestId !== config.requestId)) sourceFailure('AUDIT_BINDING');
  const now = Date.now();
  if (Date.parse(receipt.reviewedAt) > now || Date.parse(receipt.expiresAt) <= now
    || Date.parse(receipt.reviewedAt) >= Date.parse(receipt.expiresAt) || Date.parse(receipt.expiresAt) < Date.parse(config.deadline))
    sourceFailure('AUDIT_EXPIRED');
  return receipt;
}
