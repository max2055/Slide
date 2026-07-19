import { databaseService } from '../../apps/db-ops-api/src/database-service.js';

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

  const [postgresMetrics, damengMetrics] = await Promise.all([
    databaseService.getRealtimeMetrics(postgresId),
    databaseService.getRealtimeMetrics(damengId),
  ]);
  if (!postgresMetrics || postgresMetrics.db_type !== 'postgresql') throw new Error('PostgreSQL metrics readback failed');
  if (!damengMetrics || damengMetrics.db_type !== 'dameng') throw new Error('Dameng metrics readback failed');
  console.log('adapter UAT invariant valid: PostgreSQL and Dameng connected and returned native metrics');
} finally {
  await databaseService.removeConnection(postgresId);
  await databaseService.removeConnection(damengId);
}
