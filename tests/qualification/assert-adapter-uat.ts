import { databaseService } from '../../apps/db-ops-api/src/database-service.js';
import { sqlExecutor } from '../../apps/db-ops-api/src/sql-executor.js';

const postgresPassword = process.env.QUALIFICATION_POSTGRES_PASSWORD;
const damengPassword = process.env.QUALIFICATION_DAMENG_PASSWORD;
if (!postgresPassword || !damengPassword) {
  throw new Error('QUALIFICATION_POSTGRES_PASSWORD and QUALIFICATION_DAMENG_PASSWORD are required');
}

const postgresId = 991_001;
const damengId = 991_002;

try {
  const postgresConnected = await databaseService.addConnection(postgresId, 'qualification-postgresql', {
    host: process.env.QUALIFICATION_POSTGRES_HOST ?? '127.0.0.1',
    port: Number(process.env.QUALIFICATION_POSTGRES_PORT ?? '5432'),
    user: process.env.QUALIFICATION_POSTGRES_USER ?? 'postgres',
    password: postgresPassword,
    database: process.env.QUALIFICATION_POSTGRES_DATABASE ?? 'postgres',
    db_type: 'postgresql',
  });
  const damengConnected = await databaseService.addConnection(damengId, 'qualification-dameng', {
    host: process.env.QUALIFICATION_DAMENG_HOST ?? '127.0.0.1',
    port: Number(process.env.QUALIFICATION_DAMENG_PORT ?? '5236'),
    user: process.env.QUALIFICATION_DAMENG_USER ?? 'SYSDBA',
    password: damengPassword,
    database: process.env.QUALIFICATION_DAMENG_DATABASE ?? 'SYSDBA',
    db_type: 'dameng',
  });
  if (!postgresConnected || !damengConnected) throw new Error('adapter connection failed');

  if (!await databaseService.ensureConnectionAlive(postgresId)) throw new Error('PostgreSQL health probe failed');
  if (!await databaseService.ensureConnectionAlive(damengId)) throw new Error('Dameng health probe failed');

  const [postgresQuery, damengQuery] = await Promise.all([
    sqlExecutor.executeSql(postgresId, 'SELECT 1 AS qualification_value'),
    sqlExecutor.executeSql(damengId, 'SELECT 1 AS qualification_value'),
  ]);
  if (!postgresQuery.success || postgresQuery.rowCount !== 1) throw new Error('PostgreSQL read query failed');
  if (!damengQuery.success || damengQuery.rowCount !== 1) throw new Error('Dameng read query failed');

  const [postgresMetrics, damengMetrics] = await Promise.all([
    databaseService.getRealtimeMetrics(postgresId),
    databaseService.getRealtimeMetrics(damengId),
  ]);
  if (!postgresMetrics || postgresMetrics.db_type !== 'postgresql') throw new Error('PostgreSQL metrics readback failed');
  if (!damengMetrics || damengMetrics.db_type !== 'dameng') throw new Error('Dameng metrics readback failed');

  await databaseService.removeConnection(postgresId);
  await databaseService.removeConnection(damengId);
  if (databaseService.getConnection(postgresId) || databaseService.getConnection(damengId)) {
    throw new Error('adapter disconnect failed');
  }
  const [postgresRecovered, damengRecovered] = await Promise.all([
    databaseService.addConnection(postgresId, 'qualification-postgresql-recovered', {
      host: process.env.QUALIFICATION_POSTGRES_HOST ?? '127.0.0.1', port: Number(process.env.QUALIFICATION_POSTGRES_PORT ?? '5432'),
      user: process.env.QUALIFICATION_POSTGRES_USER ?? 'postgres', password: postgresPassword,
      database: process.env.QUALIFICATION_POSTGRES_DATABASE ?? 'postgres', db_type: 'postgresql',
    }),
    databaseService.addConnection(damengId, 'qualification-dameng-recovered', {
      host: process.env.QUALIFICATION_DAMENG_HOST ?? '127.0.0.1', port: Number(process.env.QUALIFICATION_DAMENG_PORT ?? '5236'),
      user: process.env.QUALIFICATION_DAMENG_USER ?? 'SYSDBA', password: damengPassword,
      database: process.env.QUALIFICATION_DAMENG_DATABASE ?? 'SYSDBA', db_type: 'dameng',
    }),
  ]);
  if (!postgresRecovered || !damengRecovered) throw new Error('adapter recovery failed');
  console.log('adapter UAT invariant valid: PostgreSQL and Dameng connection, health, query, metrics, disconnect, and recovery passed');
} finally {
  await databaseService.removeConnection(postgresId);
  await databaseService.removeConnection(damengId);
}
