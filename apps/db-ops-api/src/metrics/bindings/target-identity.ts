/**
 * MAX-238 / NATIVE-CONFIGURATION-FLOW-R3 — the exact target + credential
 * version a capability fact belongs to.
 *
 * A credential reference of the form `credential:asset-instance-11` only names
 * the resource, so the same reference survives a target rewrite or a credential
 * rotation. Bootstrap capability evidence must not: it is a fact about one exact
 * reachable target, read with one exact credential version.
 *
 * This module reads the platform's own target row on the caller's connection and
 * folds its non-secret configuration and its encrypted credential column into one
 * one-way digest. The encrypted column is never decrypted here and never stored in
 * the evidence record; only the digest leaves this function. A changed host, port,
 * user, database, credential type or credential blob therefore changes the
 * identity, and evidence written for the old one cannot answer for the new one.
 */
import { createHash } from 'node:crypto';
import type { Ref } from '../policy/model.js';
import { stable } from '../packages/model.js';

export const TARGET_IDENTITY_FORMAT = 'max238.target-identity.v1';

export type TargetIdentityExecutor = {
  execute(sql: string, values?: unknown[]): Promise<[unknown, unknown]>;
};

const text = (value: unknown): string => value === null || value === undefined ? '' : String(value);

const digest = (ref: Ref, fields: Record<string, unknown>): string =>
  `sha256:${createHash('sha256').update(stable({
    format: TARGET_IDENTITY_FORMAT, resource: `${ref.type}:${ref.id}`, ...fields,
  })).digest('hex')}`;

/** The exact row that decides which remote target and credential a read used. */
async function targetFields(
  executor: TargetIdentityExecutor, ref: Ref,
): Promise<Record<string, unknown> | null> {
  if (ref.type === 'instance') {
    const [rows] = await executor.execute(
      `SELECT host, port, username, db_type, database_name, password_encrypted
         FROM database_instances WHERE id = ?`, [ref.id],
    ) as unknown as [Array<Record<string, unknown>>, unknown];
    const row = rows?.[0];
    if (!row) return null;
    return {
      host: text(row.host), port: text(row.port), username: text(row.username),
      db_type: text(row.db_type), database_name: text(row.database_name),
      credential_type: 'password', credential: text(row.password_encrypted),
    };
  }
  if (ref.type === 'server') {
    const [rows] = await executor.execute(
      `SELECT host, port, credential_type, host_key_fingerprint, credential_encrypted
         FROM servers WHERE id = ?`, [ref.id],
    ) as unknown as [Array<Record<string, unknown>>, unknown];
    const row = rows?.[0];
    if (!row) return null;
    return {
      host: text(row.host), port: text(row.port), credential_type: text(row.credential_type),
      host_key_fingerprint: text(row.host_key_fingerprint), credential: text(row.credential_encrypted),
    };
  }
  const [devices] = await executor.execute(
    'SELECT host, snmp_port FROM network_devices WHERE id = ?', [ref.id],
  ) as unknown as [Array<Record<string, unknown>>, unknown];
  const device = devices?.[0];
  if (!device) return null;
  const [credentials] = await executor.execute(
    `SELECT protocol, username, auth_protocol, privacy_protocol, credential_type, host_key_fingerprint,
            auth_secret_encrypted, privacy_secret_encrypted, credential_encrypted
       FROM network_device_credentials WHERE device_id = ? ORDER BY protocol`, [ref.id],
  ) as unknown as [Array<Record<string, unknown>>, unknown];
  return {
    host: text(device.host), snmp_port: text(device.snmp_port),
    credentials: (credentials ?? []).map(row => ({
      protocol: text(row.protocol), username: text(row.username), auth_protocol: text(row.auth_protocol),
      privacy_protocol: text(row.privacy_protocol), credential_type: text(row.credential_type),
      host_key_fingerprint: text(row.host_key_fingerprint), auth_secret: text(row.auth_secret_encrypted),
      privacy_secret: text(row.privacy_secret_encrypted), credential: text(row.credential_encrypted),
    })),
  };
}

/**
 * One identity for the resource's current target and credential version. A missing
 * target row is `null` (the caller reports "resource not found"); a storage error
 * propagates, so an unreadable row is never treated as an unchanged target.
 */
export async function trustedTargetIdentity(
  executor: TargetIdentityExecutor, ref: Ref,
): Promise<string | null> {
  const fields = await targetFields(executor, ref);
  return fields === null ? null : digest(ref, fields);
}
