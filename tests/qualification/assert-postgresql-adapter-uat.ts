import { databaseService } from '../../apps/db-ops-api/src/database-service.js';
import { sqlExecutor } from '../../apps/db-ops-api/src/sql-executor.js';

const password = process.env.QUALIFICATION_POSTGRES_PASSWORD;
if (!password) throw new Error('QUALIFICATION_POSTGRES_PASSWORD is required');

const id = 991_001;
const config = {
  host: process.env.QUALIFICATION_POSTGRES_HOST ?? '127.0.0.1',
  port: Number(process.env.QUALIFICATION_POSTGRES_PORT ?? '5432'),
  user: process.env.QUALIFICATION_POSTGRES_USER ?? 'postgres',
  password,
  database: process.env.QUALIFICATION_POSTGRES_DATABASE ?? 'postgres',
  db_type: 'postgresql' as const,
};

try {
  if (!await databaseService.addConnection(id, 'qualification-postgresql', config)) {
    throw new Error('PostgreSQL connection failed');
  }
  if (!await databaseService.ensureConnectionAlive(id)) throw new Error('PostgreSQL health probe failed');
  const query = await sqlExecutor.executeSql(id, 'SELECT 1 AS qualification_value');
  if (!query.success || query.rowCount !== 1) throw new Error('PostgreSQL read query failed');
  const metrics = await databaseService.getRealtimeMetrics(id);
  if (!metrics || metrics.db_type !== 'postgresql') throw new Error('PostgreSQL metrics readback failed');
  await databaseService.removeConnection(id);
  if (databaseService.getConnection(id)) throw new Error('PostgreSQL disconnect failed');
  if (!await databaseService.addConnection(id, 'qualification-postgresql-recovered', config)) {
    throw new Error('PostgreSQL recovery failed');
  }
  console.log('postgresql adapter UAT invariant valid: connection, health, query, metrics, disconnect, and recovery passed');
} finally {
  await databaseService.removeConnection(id);
}
