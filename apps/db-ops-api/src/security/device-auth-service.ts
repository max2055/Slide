import { createHash, createPublicKey, randomBytes, verify as verifySignature } from 'node:crypto';
import { dbConnection } from '../db-connection.js';
import type { ActorContext } from '../auth/actor-context.js';

type Executor = { execute(sql: string, values?: unknown[]): Promise<[any, unknown?]> };
const DEVICE_ID_RE = /^[a-f0-9]{64}$/i;

function decodeBase64Url(value: string): Buffer {
  return Buffer.from(value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4), 'base64');
}

function publicKeyObject(publicKey: string) {
  const raw = decodeBase64Url(publicKey);
  if (raw.length !== 32) throw new Error('DEVICE_AUTH_PUBLIC_KEY_INVALID');
  // RFC 8410 SubjectPublicKeyInfo prefix for an Ed25519 public key.
  return createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]), format: 'der', type: 'spki' });
}

export function deviceSigningPayload(params: { deviceId: string; timestamp: number; nonce: string; method: string; path: string; body: string }): string {
  const bodyHash = createHash('sha256').update(params.body).digest('hex');
  return [params.deviceId, params.timestamp, params.nonce, params.method.toUpperCase(), params.path, bodyHash].join('.');
}

export class DeviceAuthService {
  constructor(private readonly executorProvider: () => Executor | null = () => dbConnection.getPool() as Executor | null) {}

  private executor(): Executor {
    const executor = this.executorProvider();
    if (!executor) throw new Error('DEVICE_AUTH_STORE_UNAVAILABLE');
    return executor;
  }

  async register(actor: ActorContext, deviceId: string, publicKey: string): Promise<{ deviceId: string; status: string }> {
    if (!DEVICE_ID_RE.test(deviceId) || decodeBase64Url(publicKey).length !== 32) throw new Error('DEVICE_AUTH_INPUT_INVALID');
    publicKeyObject(publicKey);
    await this.executor().execute(
      `INSERT INTO device_registrations (user_id, device_id, public_key, status, paired_by)
       VALUES (?, ?, ?, 'paired', ?)
       ON DUPLICATE KEY UPDATE public_key = VALUES(public_key), status = IF(status = 'revoked', 'paired', status), paired_by = VALUES(paired_by)`,
      [actor.userId, deviceId, publicKey, actor.userId],
    );
    return { deviceId, status: 'paired' };
  }

  async issueChallenge(actor: ActorContext, deviceId: string): Promise<{ nonce: string; expiresAt: string }> {
    const [rows] = await this.executor().execute(
      `SELECT id, status FROM device_registrations WHERE user_id = ? AND device_id = ? LIMIT 1`,
      [actor.userId, deviceId],
    );
    if (!Array.isArray(rows) || !rows[0] || rows[0].status !== 'paired') throw new Error('PAIRING_REQUIRED');
    const nonce = randomBytes(24).toString('base64url');
    const expiresAt = new Date(Date.now() + 5 * 60_000);
    await this.executor().execute(
      `UPDATE device_registrations SET challenge_hash = ?, challenge_expires_at = ?, updated_at = NOW() WHERE id = ?`,
      [createHash('sha256').update(nonce).digest('hex'), expiresAt, rows[0].id],
    );
    return { nonce, expiresAt: expiresAt.toISOString() };
  }

  async verify(actor: ActorContext, params: { deviceId: string; publicKey: string; signature: string; timestamp: number; nonce: string; method: string; path: string; body: string }): Promise<boolean> {
    if (!DEVICE_ID_RE.test(params.deviceId) || Math.abs(Date.now() - params.timestamp) > 5 * 60_000) return false;
    const [rows] = await this.executor().execute(
      `SELECT id, public_key, status, challenge_hash, challenge_expires_at FROM device_registrations WHERE user_id = ? AND device_id = ? LIMIT 1`,
      [actor.userId, params.deviceId],
    );
    if (!Array.isArray(rows) || !rows[0] || rows[0].status !== 'paired' || rows[0].public_key !== params.publicKey) return false;
    if (rows[0].challenge_hash !== createHash('sha256').update(params.nonce).digest('hex') || !rows[0].challenge_expires_at || new Date(rows[0].challenge_expires_at).getTime() < Date.now()) return false;
    const payload = deviceSigningPayload(params);
    const valid = verifySignature(null, Buffer.from(payload), publicKeyObject(params.publicKey), decodeBase64Url(params.signature));
    if (valid) await this.executor().execute(`UPDATE device_registrations SET last_seen_at = NOW(), challenge_hash = NULL, challenge_expires_at = NULL WHERE id = ?`, [rows[0].id]);
    return valid;
  }
}

let singleton: DeviceAuthService | undefined;
export function getDeviceAuthService(): DeviceAuthService { return singleton ??= new DeviceAuthService(); }
