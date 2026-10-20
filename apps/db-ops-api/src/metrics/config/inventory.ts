import type { RowDataPacket } from 'mysql2/promise';
import type { Resource } from '../../contracts/metrics/index.js';
import { normalizeServerOs } from '../../server-os-profile.js';
import { dbConnection } from '../../db-connection.js';
import { MysqlMetricStorage } from '../storage.js';
import { type Ref, rule } from '../policy/model.js';

/** Known resource metadata only; this is not proof of remote permissions or lifecycle. */
export async function configurationInventory(ref: Ref): Promise<Resource> {
  const pool = dbConnection.getPool(); rule(pool, 'POLICY_STORE_UNAVAILABLE', 503);
  const inventory = await new MysqlMetricStorage(pool).inventory(ref.type, String(ref.id));
  const resource: Resource = { type: ref.type, id: String(ref.id), attributes: {...inventory?.attributes} };
  const add = (key: string, value: unknown) => {
    if (typeof value === 'string' && value) resource.attributes[key] = { value, observed_at: new Date().toISOString(), source: 'resource_configuration' };
  };
  if (ref.type === 'instance') {
    const [rows] = await pool.execute<RowDataPacket[]>('SELECT db_type, db_version FROM database_instances WHERE id = ?', [ref.id]);
    delete resource.attributes['db.engine'];delete resource.attributes['db.version'];
    add('db.engine', rows[0]?.db_type); add('db.version', rows[0]?.db_version);
  } else if (ref.type === 'server') {
    const [rows] = await pool.execute<RowDataPacket[]>('SELECT os_type FROM servers WHERE id = ?', [ref.id]);
    const os = rows[0]?.os_type;
    delete resource.attributes['os.family'];
    if (normalizeServerOs(os)) add('os.family', 'linux');
  }
  return resource;
}
