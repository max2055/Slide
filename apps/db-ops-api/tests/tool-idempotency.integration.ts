/** Opt-in real MySQL regression for #371. Creates/drops only a random task database.
 * Set DB_HOST, DB_PORT, DB_USER and DB_PASSWORD explicitly, then run:
 * pnpm --filter slide-api exec tsx tests/tool-idempotency.integration.ts
 * The default unit-test collection does not load this script or any local credentials.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import mysql, { type PoolOptions, type RowDataPacket } from 'mysql2/promise';
import { AgentToolIdempotencyService } from '../src/security/agent-tool-idempotency-service.js';

for (const name of ['DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASSWORD']) {
  assert.notEqual(process.env[name], undefined, `${name} must be explicitly configured`);
}
const config: PoolOptions = {
  host: process.env.DB_HOST, port: Number(process.env.DB_PORT),
  user: process.env.DB_USER, password: process.env.DB_PASSWORD,
  connectTimeout: 5_000,
};
assert.ok(Number.isInteger(config.port) && config.port! > 0 && config.port! <= 65535, 'Invalid DB_PORT');
const database = `max452_${randomUUID().replaceAll('-', '')}`;
const admin = await mysql.createConnection(config);
let created = false;
try {
  const [version] = await admin.query<RowDataPacket[]>('SELECT VERSION() version');
  console.log(JSON.stringify({ database, host: config.host, port: config.port, mysql: version[0].version }));
  await admin.query(`CREATE DATABASE ${mysql.escapeId(database)}`);
  created = true;
  await admin.query(`USE ${mysql.escapeId(database)}`);
  for (const migration of ['078_agent_tool_idempotency.sql', '079_agent_tool_idempotency_comments.sql', '156_agent_tool_recovery.sql']) {
    await admin.query(await readFile(new URL(`../sql/migrations/${migration}`, import.meta.url), 'utf8'));
  }
  await admin.query('CREATE TABLE test_side_effects (request_key VARCHAR(128) NOT NULL)');
  for (const foundRows of [true, false]) {
    const pool = mysql.createPool({ ...config, database, connectionLimit: 4, ...(foundRows ? {} : { flags: ['-FOUND_ROWS'] }) });
    try {
      // Confirm driver semantics rather than assuming the requested flags took effect.
      await pool.query('INSERT INTO test_side_effects VALUES (?)', ['flag-probe']);
      const [noop] = await pool.query<mysql.ResultSetHeader>('UPDATE test_side_effects SET request_key = request_key WHERE request_key = ?', ['flag-probe']);
      assert.equal(noop.affectedRows, foundRows ? 1 : 0);
      await pool.query('DELETE FROM test_side_effects WHERE request_key = ?', ['flag-probe']);
      const provider = () => ({
        async query<T = unknown>(sql: string, values?: unknown[]): Promise<[T, unknown?]> {
          const [rows, fields] = await pool.query(sql, values);
          return [rows as T, fields];
        },
      });
      const services = [new AgentToolIdempotencyService(provider), new AgentToolIdempotencyService(provider)];
      const args = { databases: [{ host: 'fixture', port: 3308 }], concurrency: 1 };
      // Multiple connections, independent service objects, and repeated races.
      for (let round = 0; round < 5; round++) {
        const key = `${foundRows}-${round}`;
        const claims = await Promise.all(Array.from({ length: 24 }, (_, index) => services[index % 2].claim(7, 'session', 'slide_add_database_batch', key, args)));
        assert.equal(claims.filter(c => c.kind === 'claimed').length, 1, 'exactly one claim');
        assert.equal(claims.filter(c => c.kind === 'in_progress').length, 23);
        for (const claim of claims) {
          if (claim.kind === 'claimed') await pool.query('INSERT INTO test_side_effects VALUES (?)', [key]);
        }
        assert.equal((await services[0].claim(7, 'session', 'slide_add_database_batch', key, { ...args, concurrency: 2 })).kind, 'conflict');
        const result = { success: true, data: { total: 1, succeeded: 1, failed: 0, results: [{ instanceId: 101 }] } };
        const owner = claims.find(c => c.kind === 'claimed')!;
        if (owner.kind !== 'claimed') throw new Error('missing owner');
        await assert.rejects(services[1].heartbeat(7, 'session', 'slide_add_database_batch', key, { ...owner, ownerToken: 'foreign' }), /OWNERSHIP_LOST/);
        await services[0].heartbeat(7, 'session', 'slide_add_database_batch', key, owner);
        await Promise.all(Array.from({ length: 24 }, (_, index) => services[index % 2].checkpoint(7, 'session', 'slide_add_database_batch', key, owner, index, { state: 'completed', result: { index } })));
        // Repeating the same checkpoint is valid even with FOUND_ROWS disabled.
        await services[0].checkpoint(7, 'session', 'slide_add_database_batch', key, owner, 0, { state: 'completed', result: { index: 0 } });
        const [checkpoint] = await pool.query<RowDataPacket[]>('SELECT checkpoint_json FROM agent_tool_idempotency WHERE idempotency_key = ?', [key]);
        assert.equal(Object.keys(checkpoint[0].checkpoint_json.items).length, 24);
        await services[0].finish(7, 'session', 'slide_add_database_batch', key, owner.argumentsHash, 'completed', result, owner.ownerToken);
        const replay = await Promise.all(Array.from({ length: 24 }, () => services[1].claim(7, 'session', 'slide_add_database_batch', key, args)));
        for (const claim of replay) assert.deepEqual(claim, { kind: 'completed', argumentsHash: claims[0].argumentsHash, result });
        assert.equal((await services[1].claim(7, 'session', 'slide_add_database_batch', key, {})).kind, 'conflict');
        const [rows] = await pool.query<RowDataPacket[]>('SELECT COUNT(*) n FROM agent_tool_idempotency WHERE idempotency_key = ?', [key]);
        const [effects] = await pool.query<RowDataPacket[]>('SELECT COUNT(*) n FROM test_side_effects WHERE request_key = ?', [key]);
        assert.equal(rows[0].n, 1);
        assert.equal(effects[0].n, 1);
      }
      // A failed record must not be reclaimed implicitly (#372 is separate scope).
      const failedKey = `failed-${foundRows}`;
      const first = await services[0].claim(7, 'session', 'tool', failedKey, args);
      if (first.kind !== 'claimed') throw new Error('missing owner');
      await services[0].finish(7, 'session', 'tool', failedKey, first.argumentsHash, 'failed', { error: 'fixture' }, first.ownerToken);
      assert.equal((await services[1].claim(7, 'session', 'tool', failedKey, args)).kind, 'unknown');
      console.log(JSON.stringify({ foundRows, rounds: 5, concurrentRequestsPerRound: 24, claimedPerRound: 1, inProgressPerRound: 23, sideEffectsPerRound: 1, concurrentReplaysPerRound: 24, conflictRunning: 'pass', conflictCompleted: 'pass', failedNotReclaimed: 'pass', concurrentCheckpoints: 24, foreignOwnerFenced: 'pass', repeatedCheckpoint: 'pass' }));
    } finally {
      await pool.end();
    }
  }
} finally {
  try {
    if (created) {
      await admin.query(`DROP DATABASE ${mysql.escapeId(database)}`);
      console.log(JSON.stringify({ cleanup: 'pass', database }));
    }
  } finally {
    await admin.end();
  }
}
