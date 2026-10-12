import { randomUUID } from 'node:crypto';
import mysql, { type Pool, type RowDataPacket } from 'mysql2/promise';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MigrationRunner } from '../../migrations/runner.js';
import { ActorContextService, signAccessToken, type ActorContext } from '../../auth/actor-context.js';
import {
  InvestigationAuthorization,
  provisionInvestigationServiceIdentity,
} from '../../investigations/authorization.js';
import { InvestigationSessionBridge } from '../../investigations/session-bridge.js';
import { MysqlWorkflowStore } from '../../workflows/worker-runtime.js';
import { AgentRunService } from '../agent-run-service.js';
import {
  CanonicalStore,
  type InvestigationConnection,
  type InvestigationExecutionBinding,
} from '../canonical-store.js';
import { migrateMessageParts, type SessionEntry } from '@slide/agent-core';

const port = Number(process.env.AGENT_RUN_TEST_MYSQL_PORT);
describe.skipIf(!port)('investigation canonical transaction ports / real MySQL', () => {
  const database = `inv_canonical_${process.pid}_${randomUUID().replaceAll('-', '')}`;
  let admin: Pool, pool: Pool, canonical: CanonicalStore, contexts: ActorContextService;
  let bridge: InvestigationSessionBridge,
    owner: ActorContext,
    operator: ActorContext,
    viewer: ActorContext,
    service: ActorContext;
  let serviceId: number, roleId: number, binding: InvestigationExecutionBinding, sessionId: string, turnId: string;
  const rows = async (sql: string, values: unknown[] = []) => (await pool.query<RowDataPacket[]>(sql, values))[0];
  const tx = async <T>(work: (c: InvestigationConnection) => Promise<T>, lostAck = false): Promise<T> => {
    const c = await pool.getConnection();
    try {
      await c.beginTransaction();
      const value = await work(c as unknown as InvestigationConnection);
      await c.commit();
      if (lostAck) throw new Error('LOST_ACK');
      return value;
    } catch (e) {
      await c.rollback();
      throw e;
    } finally {
      c.release();
    }
  };
  const create = {
    title: 'Investigation facts',
    goal: 'Read current facts',
    profileId: 'ops' as const,
    profileVersion: 1,
    resources: [
      { type: 'instance' as const, id: 101, role: 'primary' as const },
      { type: 'instance' as const, id: 103, role: 'related' as const },
    ],
  };
  async function admit(actor: ActorContext, original: ActorContext = actor) {
    const inv = (await bridge.create(original, create)).investigation;
    if (original.userId !== actor.userId)
      await pool.query(
        "INSERT INTO investigation_members (investigation_id,user_id,role,granted_by,expires_at) VALUES (?, ?, 'operator', ?, NULL)",
        [inv.id, actor.userId, original.userId],
      );
    await pool.query(
      "INSERT INTO investigation_members (investigation_id,user_id,role,granted_by,expires_at) VALUES (?, ?, 'viewer', ?, NULL)",
      [inv.id, viewer.userId, original.userId],
    );
    const accepted = await bridge.admit(actor, {
      investigationId: inv.id,
      expectedVersion: inv.version,
      idempotencyKey: randomUUID(),
      message: 'Inspect',
    });
    const job = await new MysqlWorkflowStore(() => pool as never).claim('canonical-worker', 60, {
      types: ['investigation.execute'],
      exclude: false,
    });
    turnId = (await rows('SELECT message_id FROM investigation_requests WHERE id = ?', [accepted.requestId]))[0]
      .message_id;
    const { run } = await new AgentRunService(() => pool as never).claim(
      actor.userId,
      inv.sessionId,
      turnId,
      `investigation:${accepted.requestId}`,
    );
    sessionId = inv.sessionId;
    binding = {
      investigationId: inv.id,
      requestId: accepted.requestId,
      jobId: job!.id,
      runId: run.id,
      workerId: 'canonical-worker',
      fencingToken: job!.fencingToken,
    };
    return binding;
  }
  function facts(): SessionEntry[] {
    return [
      migrateMessageParts(
        {
          id: `intent_${binding.runId}`,
          role: 'assistant',
          content: null,
          source: 'fact',
          runId: binding.runId,
          turnId,
          tool_calls: [
            {
              id: 'call',
              type: 'function',
              function: { name: 'get_instance_summary', arguments: '{"instance_id":101}' },
            },
          ],
        },
        { status: 'partial' },
      ),
      {
        id: `result_${binding.runId}`,
        role: 'tool',
        content: 'bounded result',
        name: 'get_instance_summary',
        tool_call_id: 'call',
        source: 'fact',
        runId: binding.runId,
        turnId,
      },
    ];
  }
  const append = (actor = owner, entries = facts(), cp: Record<string, unknown> = { marker: 'saved' }) =>
    tx((c) => canonical.appendInvestigationToolFacts(c, actor, binding, entries, 1, cp));
  const snapshot = async () => ({
    facts: await rows('SELECT * FROM agent_canonical_facts ORDER BY id'),
    metadata: (await rows('SELECT metadata FROM chat_sessions WHERE session_id = ?', [sessionId]))[0].metadata,
  });
  beforeAll(async () => {
    const config = {
      host: '127.0.0.1',
      port,
      user: 'root',
      password: process.env.AGENT_RUN_TEST_MYSQL_PASSWORD ?? '',
      timezone: 'Z',
    };
    admin = mysql.createPool(config);
    await admin.query(`CREATE DATABASE ${database}`);
    pool = mysql.createPool({ ...config, database, connectionLimit: 12 });
    await new MigrationRunner(pool).run();
    await pool.query(
      "INSERT INTO users (id, username, password_hash) VALUES (101, 'inv-owner', 'no-login'), (102, 'inv-operator', 'no-login'), (104, 'inv-viewer', 'no-login')",
    );
    contexts = new ActorContextService(() => pool as never);
    serviceId = await tx((c) => provisionInvestigationServiceIdentity(c, 'canonical-test'));
    const [role] = await pool.query<mysql.ResultSetHeader>("INSERT INTO roles (name) VALUES ('inv-readonly')");
    roleId = role.insertId;
    await pool.query(
      "INSERT INTO role_permissions (role_id, permission_id) SELECT ?, id FROM permissions WHERE code IN ('chat:view','instance:view','metric:view','alert:view')",
      [roleId],
    );
    await pool.query(
      "INSERT INTO database_instances (id, name, host, port, username, password_encrypted) VALUES (101, 'one', 'fixture.invalid', 3306, 'fixture', 'unused'), (103, 'two', 'fixture.invalid', 3306, 'fixture', 'unused')",
    );
    canonical = new CanonicalStore(() => pool as never, new InvestigationAuthorization(contexts));
    bridge = new InvestigationSessionBridge(() => pool, new InvestigationAuthorization(contexts));
  }, 60_000);
  beforeEach(async () => {
    for (const table of [
      'investigation_admission_keys',
      'investigation_create_keys',
      'investigation_requests',
      'investigation_members',
      'investigation_resources',
      'investigations',
      'agent_canonical_facts',
      'chat_session_shares',
      'chat_messages',
      'agent_runs',
      'chat_sessions',
      'workflow_jobs',
      'outbox_events',
      'instance_permissions',
      'user_roles',
    ])
      await pool.query(`DELETE FROM ${table}`);
    for (const id of [101, 102, 104, serviceId]) {
      await pool.query('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)', [id, roleId]);
      for (const instance of [101, 103])
        await pool.query(
          "INSERT INTO instance_permissions (user_id, instance_id, access_level) VALUES (?, ?, 'read-only')",
          [id, instance],
        );
    }
    const secret = randomUUID();
    owner = await contexts.authenticateAccessToken(
      signAccessToken(await contexts.loadActiveActor(101), secret),
      secret,
    );
    operator = await contexts.loadActiveActor(102);
    viewer = await contexts.loadActiveActor(104);
    service = {
      ...(await tx((c) => contexts.loadInvestigationActorFrom(c, serviceId, 'service', 1))),
      resourceBoundary: { instanceIds: [101, 103], serverIds: [], networkDeviceIds: [] },
    };
    await admit(owner);
  });
  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS ${database}`);
      await admin.end();
    }
  });
  it('owner stores exact facts/checkpoint and shares original history mapping/cursors', async () => {
    await append();
    const before = await snapshot();
    await append();
    expect(await snapshot()).toEqual(before);
    const page = await tx((c) => canonical.getInvestigationPage(c, owner, binding, 2));
    expect(page.messages.map((m) => m.role)).toEqual(['assistant', 'tool']);
    expect(page.nextBefore).toBeTruthy();
    const next = await tx((c) => canonical.getInvestigationPage(c, owner, binding, 2, page.nextBefore!));
    expect(next.messages).toHaveLength(1);
    expect(next.messages[0].id).toBe(turnId);
    expect(page.messages.every((m) => m.messageParts?.status === 'completed')).toBe(true);
  });
  it.each(['operator', 'service'])('%s consumes service Session without impersonating its owner', async (kind) => {
    await pool.query("UPDATE workflow_jobs SET state = 'completed'");
    await admit(kind === 'operator' ? operator : service, service);
    const actor = kind === 'operator' ? operator : service;
    await append(actor);
    expect((await tx((c) => canonical.getInvestigationPage(c, actor, binding))).messages).toHaveLength(3);
    expect((await rows('SELECT user_id FROM chat_sessions WHERE session_id = ?', [sessionId]))[0].user_id).toBe(
      serviceId,
    );
    expect((await rows('SELECT actor_id, message_id FROM agent_runs WHERE id = ?', [binding.runId]))[0]).toMatchObject({
      actor_id: actor.userId,
      message_id: turnId,
    });
  });
  it.each(['viewer', 'wrong-actor', 'read-share'])('rejects %s execution and mutation', async (kind) => {
    if (kind === 'read-share')
      await pool.query(
        "INSERT INTO chat_session_shares (session_id, granted_by, recipient_user_id, permission) VALUES (?, ?, ?, 'read')",
        [sessionId, owner.userId, operator.userId],
      );
    const actor = kind === 'viewer' ? viewer : operator;
    await expect(append(actor)).rejects.toThrow('INVESTIGATION_EXECUTION_INVALID');
    await expect(tx((c) => canonical.getInvestigationPage(c, actor, binding))).rejects.toThrow();
    expect((await snapshot()).facts).toHaveLength(0);
  });
  it('viewer downgrade preserves content visibility but forbids original request execution', async () => {
    await pool.query("UPDATE workflow_jobs SET state = 'completed'");
    await admit(operator, service);
    await pool.query("UPDATE investigation_members SET role = 'viewer' WHERE investigation_id = ? AND user_id = ?", [
      binding.investigationId,
      operator.userId,
    ]);
    expect(await bridge.messages(operator, binding.investigationId)).toHaveLength(1);
    await expect(append(operator)).rejects.toThrow('INVESTIGATION_OPERATION_FORBIDDEN');
  });
  it('same retained actor fails after a related resource grant is revoked', async () => {
    await pool.query('DELETE FROM instance_permissions WHERE user_id = ? AND instance_id = 103', [owner.userId]);
    await expect(append()).rejects.toThrow('INVESTIGATION_NOT_FOUND');
    await expect(tx((c) => canonical.getInvestigationPage(c, owner, binding))).rejects.toThrow(
      'INVESTIGATION_NOT_FOUND',
    );
  });
  it.each(['old-fence', 'expired', 'cancelled', 'wrong-run', 'wrong-job', 'wrong-turn'])(
    'rejects %s atomically',
    async (kind) => {
      if (kind === 'old-fence') binding.fencingToken--;
      if (kind === 'expired')
        await pool.query('UPDATE workflow_jobs SET lease_expires_at = DATE_SUB(NOW(), INTERVAL 1 SECOND)');
      if (kind === 'cancelled')
        await bridge
          .storeFor(owner)
          .cancel({ kind: 'user', id: owner.userId }, binding.investigationId, binding.requestId);
      if (kind === 'wrong-run') binding.runId = randomUUID();
      if (kind === 'wrong-job') binding.jobId = randomUUID();
      if (kind === 'wrong-turn') turnId = 'unbound-turn';
      await expect(append()).rejects.toThrow();
      expect((await snapshot()).facts).toHaveLength(0);
    },
  );
  it('fact and checkpoint roll back with caller transaction', async () => {
    const before = await snapshot();
    await expect(
      tx(async (c) => {
        await canonical.appendInvestigationToolFacts(c, owner, binding, facts(), 1, { marker: 'rollback' });
        throw new Error('CALLER_ROLLBACK');
      }),
    ).rejects.toThrow('CALLER_ROLLBACK');
    expect(await snapshot()).toEqual(before);
  });
  it.each(['canonical_run_id', 'canonical_turn_id'])(
    'rejects explicit checkpoint %s mismatch without writing facts',
    async (field) => {
      const before = await snapshot();
      await expect(append(owner, facts(), { [field]: 'wrong-binding' })).rejects.toThrow(
        'INVESTIGATION_CHECKPOINT_INVALID',
      );
      await expect(
        tx((c) => canonical.saveInvestigationCheckpoint(c, owner, binding, { [field]: 'wrong-binding' })),
      ).rejects.toThrow('INVESTIGATION_CHECKPOINT_INVALID');
      expect(await snapshot()).toEqual(before);
    },
  );
  it('lost commit acknowledgement replays identically; full payload conflict rolls back', async () => {
    const entries = facts();
    await expect(
      tx((c) => canonical.appendInvestigationToolFacts(c, owner, binding, entries, 1, { marker: 'committed' }), true),
    ).rejects.toThrow('LOST_ACK');
    const before = await snapshot();
    await append(owner, entries, { marker: 'committed' });
    expect(await snapshot()).toEqual(before);
    const changed = structuredClone(entries);
    changed[0].metadata = { changed: true };
    await expect(append(owner, changed, { marker: 'replacement' })).rejects.toThrow('CANONICAL_ID_CONFLICT');
    expect(await snapshot()).toEqual(before);
  });
});
