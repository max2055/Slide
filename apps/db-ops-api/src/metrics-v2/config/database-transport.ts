import { Client as PgClient } from 'pg';
import mysql from 'mysql2/promise';
import { createConnection } from 'node:net';
import dmdb from 'dmdb';
import type { DatabaseConnection } from '../../database-service.js';
import { authorizeDatabaseTarget } from '../../security/database-target-policy.js';
import { AdapterError, type Transport } from '../packages/adapters.js';
import { bindDatabaseDriver } from '../database/collector.js';
import { postgresCounterTransport } from './postgres-counter.js';

/** Fixed package reads only. Dedicated sessions prevent trial timeouts changing a shared session. */
export function trialDatabaseTransport(connection: DatabaseConnection): Transport {
  const bind = connection.db_type === 'postgresql' ? postgresCounterTransport : bindDatabaseDriver;
  return bind(async (sql, timeout) => {
    if (connection.db_type === 'oracle' && connection.oraclePool) {
      const client = await connection.oraclePool.getConnection();
      try { client.callTimeout = timeout; return await client.execute(sql); }
      finally { await client.close(); }
    }
    const config = connection.config;
    const target = await authorizeDatabaseTarget({ host: config.host, port: config.port, dbType: connection.db_type },
      { allowManagedLoopback: true, allowManagedPort: true });
    if (connection.db_type === 'mysql') {
      const socket = createConnection({ host: target.address, port: target.port });
      const closed = new Promise<void>(resolve => socket.once('close', () => resolve()));
      try {
        const client = await mysql.createConnection({ stream: socket, user: config.user, password: config.password,
          database: config.database || undefined, connectTimeout: timeout, supportBigNumbers: true, bigNumberStrings: true });
        const [rows] = await client.query({ sql, timeout });
        return { rows };
      } finally {
        // mysql2's query timeout fires before the command drains. Close our private socket
        // and await close before letting the caller release the shared resource reservation.
        socket.destroy(); await closed;
      }
    }
    if (connection.db_type === 'postgresql') {
      const client = new PgClient({ host: target.address, port: target.port, user: config.user, password: config.password,
        database: config.database || 'postgres', connectionTimeoutMillis: timeout, statement_timeout: timeout });
      try { await client.connect(); return await client.query(sql); }
      finally { await client.end(); }
    }
    if (connection.db_type === 'dameng') {
      const client = await dmdb.getConnection({ user: config.user, password: config.password,
        connectString: `${target.address}:${target.port}`, schema: config.database || undefined,
        connectTimeout: timeout, socketTimeout: timeout, sessionTimeout: Math.ceil(timeout / 1000), loginEncrypt: false });
      try { return await client.execute(sql); }
      finally { await client.close(); }
    }
    throw new AdapterError('connection_error');
  });
}
