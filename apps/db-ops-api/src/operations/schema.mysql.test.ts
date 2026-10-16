/** Isolated domain composition, NOT production migration/server assembly. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import mysql, { type Connection } from 'mysql2/promise';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { OperationsAuthorization, OPERATIONS_PERMISSIONS } from './authorization.js';
import { ActorContextService } from '../auth/actor-context.js';

const port = Number(process.env.OPERATIONS_TEST_MYSQL_PORT ?? process.env.AGENT_RUN_TEST_MYSQL_PORT);
describe.skipIf(!port)('operations draft schema / real MySQL', () => {
  let admin: Connection, db: Connection;
  const database = `operations_p01_${randomUUID().replaceAll('-', '')}`;
  const schema = () => readFileSync(new URL('./schema/operations-v1.sql', import.meta.url), 'utf8');
  const apply = async () => { for (const sql of schema().split(';').map(s => s.trim()).filter(Boolean)) await db.query(sql); };
  beforeAll(async () => {
    const options = { host: '127.0.0.1', port, user: 'root',
      password: process.env.OPERATIONS_TEST_MYSQL_PASSWORD ?? process.env.AGENT_RUN_TEST_MYSQL_PASSWORD ?? '', timezone: 'Z' };
    admin = await mysql.createConnection(options);
    await admin.query(`CREATE DATABASE ${database} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    db = await mysql.createConnection({ ...options, database });
    // Existing ACL tables, without a second user/resource truth source in the draft.
    for (const sql of [
      'CREATE TABLE users (id INT UNSIGNED PRIMARY KEY, username VARCHAR(64), password_hash VARCHAR(128), status VARCHAR(16), session_version BIGINT DEFAULT 1)',
      'CREATE TABLE roles (id INT PRIMARY KEY, name VARCHAR(64))',
      'CREATE TABLE permissions (id INT PRIMARY KEY, code VARCHAR(128))',
      'CREATE TABLE user_roles (user_id INT, role_id INT, grant_expiry DATETIME NULL)',
      'CREATE TABLE role_permissions (role_id INT, permission_id INT)',
      'CREATE TABLE instance_permissions (user_id INT, instance_id INT, access_level VARCHAR(32), grant_expiry DATETIME NULL)',
      "CREATE TABLE database_instances (id INT PRIMARY KEY, lifecycle_state VARCHAR(32) DEFAULT 'available')",
      'CREATE TABLE servers (id INT PRIMARY KEY)', 'CREATE TABLE network_devices (id INT PRIMARY KEY)',
      "INSERT INTO users VALUES (1,'author','disabled','active',1),(2,'reviewer','disabled','active',1)",
      "INSERT INTO roles VALUES (1,'p01-reviewer')", 'INSERT INTO user_roles VALUES (1,1,NULL),(2,1,NULL)',
      "INSERT INTO permissions VALUES (1,'instance:view'),(2,'instance:manage'),(3,'servers:view'),(4,'servers:manage')",
      'INSERT INTO role_permissions VALUES (1,1),(1,2),(1,3),(1,4)',
      "INSERT INTO instance_permissions VALUES (1,1,'read-write',NULL),(2,1,'read-write',NULL)",
      'INSERT INTO database_instances(id) VALUES(1)', 'INSERT INTO servers VALUES(1)',
    ]) await db.query(sql);
    for (const [i, code] of Object.values(OPERATIONS_PERMISSIONS).entries()) {
      await db.execute('INSERT INTO permissions VALUES (?, ?)', [i + 10, code]);
      await db.execute('INSERT INTO role_permissions VALUES (1, ?)', [i + 10]);
    }
    // Real historical table definitions. Never alter them from the new draft.
    const legacy = readFileSync(new URL('../../sql/migrations/026_operations.sql', import.meta.url), 'utf8').split(';');
    for (const sql of legacy.slice(0, 2)) await db.query(sql);
    await db.query("INSERT INTO operations(id,actor_id,origin,resource_type,resource_id,command_type,risk,idempotency_key,correlation_id,state) VALUES('legacy',1,'chat','server','1','read','low','old','old','succeeded')");
    await db.query("INSERT INTO operation_events(operation_id,to_state,reason_code) VALUES('legacy','succeeded','OLD')");
    await db.query(readFileSync(new URL('../../sql/migrations/029_resource_observations.sql', import.meta.url), 'utf8').split(';')[0]);
    await db.query("INSERT INTO resource_relations(source_type,source_id,target_type,target_id,relation_type,provenance) VALUES('instance',1,'server',1,'runs_on','legacy-unverified')");
    await apply();
  }, 30_000);
  afterAll(async () => {
    await db?.end();
    if (admin) { await admin.query(`DROP DATABASE IF EXISTS ${database}`); await admin.end(); }
  });

  it('reenters without converting or deleting V1 history and has no metrics shadow table', async () => {
    await apply();
    const [legacy] = await db.query<any[]>("SELECT state, attempt FROM operations WHERE id='legacy'");
    expect(legacy).toEqual([{ state: 'succeeded', attempt: 1 }]);
    const [relations] = await db.query<any[]>('SELECT provenance FROM resource_relations');
    expect(relations[0].provenance).toBe('legacy-unverified');
    const [revisions] = await db.query<any[]>('SELECT COUNT(*) n FROM resource_relation_revisions');
    expect(revisions[0].n).toBe(0);
    const [tables] = await db.query<any[]>('SHOW TABLES');
    expect(tables.some(row => String(Object.values(row)[0]).startsWith('metric_'))).toBe(false);
  });
  it('enforces exact plan version and one approval / one execution under duplicate sends', async () => {
    await db.execute("INSERT INTO action_plans(id,investigation_id,author_kind,author_id,requester_kind,requester_id,target_type,target_id) VALUES('p','i','user',1,'user',1,'server',1)");
    await db.execute("INSERT INTO action_plan_versions(plan_id,version,content_hash,content,policy_version,valid_from,valid_until) VALUES('p',1,?,?,'v1',UTC_TIMESTAMP(3),DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 15 MINUTE))", ['a'.repeat(64), '{}']);
    for (const approval of [1, 2, 3]) await db.execute(`INSERT INTO action_approval_bindings
      (approval_id,plan_id,plan_version,content_hash,policy_version,author_id,requester_id,reviewer_id,expires_at)
      VALUES(?,'p',1,?,'v1',1,1,2,DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 15 MINUTE))`, [approval, 'a'.repeat(64)]);
    const insert = (id: string, approval: number, version: number, request: string) => db.execute(`INSERT INTO action_executions
      (id,plan_id,plan_version,approval_id,operation_id,actor_id,request_key,payload_hash)
      VALUES(?,'p',?,?,?,2,?,?)`, [id, version, approval, `remote-${id}`, request, 'b'.repeat(64)]);
    await insert('e1', 1, 1, 'request-1');
    await expect(insert('e2', 1, 1, 'request-2')).rejects.toMatchObject({ code: 'ER_DUP_ENTRY' });
    await expect(insert('e3', 2, 1, 'request-1')).rejects.toMatchObject({ code: 'ER_DUP_ENTRY' });
    await expect(insert('e4', 3, 2, 'request-4')).rejects.toMatchObject({ code: 'ER_NO_REFERENCED_ROW_2' });
    await db.execute("UPDATE action_executions SET state='outcome_unknown',sent_at=UTC_TIMESTAMP(3) WHERE id='e1'");
    await apply();
    const [rows] = await db.query<any[]>("SELECT state, approval_id FROM action_executions WHERE id='e1'");
    expect(rows).toEqual([{ state: 'outcome_unknown', approval_id: 1 }]);
    await expect(db.execute("DELETE FROM action_plan_versions WHERE plan_id='p' AND version=1")).rejects.toMatchObject({ code: 'ER_ROW_IS_REFERENCED_2' });
  });
  it('checks live SQL role/scope/session/resource revocation and independent human approval', async () => {
    const auth = new OperationsAuthorization();
    const contexts = new ActorContextService();
    // mysql2 v3's narrower ExecuteValues signature needs an adapter to the
    // existing ActorContext SQL port, without changing shared auth source.
    const executor = { execute: (sql: string, values?: unknown[]) => db.execute(sql, values as any[]) };
    const caller = await contexts.loadInvestigationActorFrom(executor, 2, 'user', 1, 'p01');
    const refs = [{ type: 'instance' as const, id: 1 }, { type: 'server' as const, id: 1 }];
    await expect(auth.authorize(executor, caller, refs, 'context:manage')).resolves.toMatchObject({ userId: 2 });
    await expect(auth.authorize(executor, caller, refs, 'actions:approve', { author: { kind: 'user', id: 2 }, requester: { kind: 'user', id: 1 } }))
      .rejects.toMatchObject({ statusCode: 403 });
    await expect(auth.authorize(executor, caller, refs, 'actions:approve', { author: { kind: 'user', id: 1 }, requester: { kind: 'user', id: 1 } }))
      .resolves.toMatchObject({ userId: 2 });
    await db.query('DELETE FROM instance_permissions WHERE user_id=2');
    await expect(auth.authorize(executor, caller, refs, 'cases:read')).rejects.toMatchObject({ statusCode: 404 });
    await db.query("INSERT INTO instance_permissions VALUES(2,1,'read-only',NULL)");
    await expect(auth.authorize(executor, caller, refs, 'context:manage')).rejects.toMatchObject({ statusCode: 403 });
    await db.query('UPDATE users SET session_version=2 WHERE id=2');
    await expect(auth.authorize(executor, caller, refs, 'cases:read')).rejects.toMatchObject({ statusCode: 404 });
    const fresh = await contexts.loadInvestigationActorFrom(executor, 2, 'user', 2, 'p01');
    await db.query('DELETE FROM role_permissions WHERE permission_id=3');
    await expect(auth.authorize(executor, fresh, refs, 'cases:read')).rejects.toMatchObject({ statusCode: 404 });
  });
});
