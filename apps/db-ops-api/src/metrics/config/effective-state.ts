import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';
import { rule, type Ref } from '../policy/model.js';

/** Read the live asset switch. Missing/deleting assets fail closed, independently of inherited policy. */
export async function assetCollectionEnabled(connection: Pick<Pool | PoolConnection, 'execute'>, ref: Ref, lock = false): Promise<boolean> {
  const table = ref.type === 'instance' ? 'database_instances' : ref.type === 'server' ? 'servers' : 'network_devices';
  const expression = ref.type === 'instance' ? "status = 'active' AND lifecycle_state = 'available'" : 'collection_enabled = 1';
  const [rows] = await connection.execute<RowDataPacket[]>(`SELECT ${expression} AS enabled FROM ${table} WHERE id = ?${lock ? ' FOR UPDATE' : ''}`, [ref.id]);
  return Number(rows[0]?.enabled) === 1;
}

export async function assertAssetCollectionEnabled(connection: Pick<Pool | PoolConnection, 'execute'>, ref: Ref): Promise<void> {
  rule(await assetCollectionEnabled(connection, ref), 'ASSET_COLLECTION_DISABLED', 409);
}
