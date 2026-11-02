import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';
import { z } from 'zod';
import { actorContextService, type ActorContext } from '../../auth/actor-context.js';
import { hasPermission } from '../../auth/require-permission.js';
import { canManageResource, canReadResource } from '../../resources/resource-service.js';
import { RefSchema, OperationKeySchema, rule, refKey, type Ref } from '../policy/model.js';
import { TemplateBindingBodySchema } from '../../contracts/metrics/template-bindings.js';
import { TemplateBindingService, templateBindingErrorStatus } from './binding-service.js';
import { stable } from '../packages/model.js';
import { BindingPreflightError } from '../bindings/preflight.js';
import { BindingCandidateError } from '../bindings/compile.js';
import { TemplateResolutionError } from '../bindings/resolve.js';
const failureCode = (error: unknown) =>
  templateBindingErrorStatus(error)?.code ??
  (error instanceof BindingPreflightError ||
  error instanceof BindingCandidateError ||
  error instanceof TemplateResolutionError
    ? error.code
    : 'ROLLOUT_FAILED');
const decode = (v: any) => (typeof v === 'string' ? JSON.parse(v) : v);
import { RolloutInput } from '../../contracts/metrics/template-governance.js';
type Body = z.infer<typeof TemplateBindingBodySchema>;
type Item = {
  resource: Ref;
  before: Body;
  candidate: Body;
  attempt: number;
  key: string;
  state: string;
  error: string | null;
  target_revision: number | null;
  commands?: Record<string, { action: string; key: string }>;
  rollback?: boolean;
};
/** Journal/orchestration only. The existing binding service owns all trial/apply writes. */
export class TemplateGovernance {
  constructor(
    private pool: () => Pool,
    private binding: TemplateBindingService,
  ) {}
  private access(actor: ActorContext, ref: Ref, write: boolean) {
    rule(
      hasPermission(new Set(actor.permissions), write ? 'metric:manage' : 'metric:view'),
      'ROLLOUT_FORBIDDEN',
      403,
    );
    rule(
      write ? canManageResource(actor, ref) : canReadResource(actor, ref),
      'ROLLOUT_FORBIDDEN',
      403,
    );
  }
  private async transaction<T>(fn: (c: PoolConnection) => Promise<T>) {
    const c = await this.pool().getConnection();
    let reusable = false;
    try {
      await c.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
      await c.beginTransaction();
      const v = await fn(c);
      await c.commit();
      reusable = true;
      return v;
    } catch (e) {
      try {
        await c.rollback();
        reusable = true;
      } catch {}
      throw e;
    } finally {
      if (reusable) c.release();
      else c.destroy();
    }
  }
  private async live(c: PoolConnection, actor: ActorContext, locked = false) {
    return actorContextService.revalidateActorOn(c as any, actor, actor.requestId, locked);
  }
  async inventory(actor: ActorContext) {
    const rows: Array<Ref & { name: string; revision: number }> = [];
    for (const [type, table, label] of [
      ['instance', 'database_instances', 'name'],
      ['server', 'servers', 'label'],
      ['network_device', 'network_devices', 'name'],
    ] as const) {
      const [assets] = await this.pool().query<RowDataPacket[]>(
        `SELECT id,${label} AS name FROM ${table}`,
      );
      for (const a of assets) {
        const ref = { type, id: Number(a.id) };
        const current = await actorContextService.revalidateActor(actor);
        if (
          canManageResource(current, ref) &&
          hasPermission(new Set(current.permissions), 'metric:view')
        ) {
          const state = await this.binding.status(current, ref);
          rows.push({ ...ref, name: String(a.name), revision: state.revision ?? 0 });
        }
      }
    }
    const final = await actorContextService.revalidateActor(actor);
    return rows.filter(
      (r) =>
        canManageResource(final, r) && hasPermission(new Set(final.permissions), 'metric:view'),
    );
  }
  async preview(actor: ActorContext, raw: unknown) {
    const input = RolloutInput.parse(raw);
    const resources = [];
    for (const entry of input.resources) {
      const current = await actorContextService.revalidateActor(actor);
      this.access(current, entry.resource, true);
      const old = await this.binding.status(current, entry.resource);
      rule((old.revision ?? 0) === entry.expected_revision, 'ROLLOUT_REVISION', 409);
      const candidate = {
        expected_revision: entry.expected_revision,
        template_pins: [
          ...new Map([...old.template_pins, ...input.pins].map((p) => [p.template_id, p])).values(),
        ].sort((a, b) => (a.template_id < b.template_id ? -1 : 1)),
        overrides: old.configuration?.overrides ?? {},
        group_id: old.configuration?.group_id ?? null,
      };
      try {
        const after = await this.binding.preview(current, entry.resource, candidate);
        const before = old.template_pins.length
          ? await this.binding.preview(current, entry.resource, {
              ...candidate,
              template_pins: old.template_pins,
            })
          : null;
        resources.push({
          resource: entry.resource,
          revision: entry.expected_revision,
          before: before ? { budget: before.budget, parameters: before.parameters } : null,
          after: {
            budget: after.budget,
            parameters: after.parameters,
            executable: after.executable,
          },
          error: null,
        });
      } catch (error) {
        resources.push({
          resource: entry.resource,
          revision: entry.expected_revision,
          before: null,
          after: null,
          error: failureCode(error),
          conflicts: error instanceof BindingPreflightError ? error.conflicts : [],
        });
      }
    }
    const final = await actorContextService.revalidateActor(actor);
    for (const entry of input.resources) this.access(final, entry.resource, true);
    return { resources };
  }
  async create(actor: ActorContext, raw: unknown) {
    const input = RolloutInput.parse(raw);
    const fingerprint = createHash('sha256').update(stable(input)).digest('hex');
    return this.transaction(async (c) => {
      // One actor key serializes response-loss replays before inspecting mutable bindings.
      const id = randomUUID();
      await c.execute('INSERT IGNORE INTO metric_template_rollouts VALUES(?,?,?,?,?)', [
        id,
        actor.userId,
        input.operation_key,
        fingerprint,
        JSON.stringify({ pins: input.pins, created_at: new Date().toISOString() }),
      ]);
      const [batches] = await c.execute<RowDataPacket[]>(
        'SELECT id,fingerprint FROM metric_template_rollouts WHERE actor_id=? AND operation_key=? FOR UPDATE',
        [actor.userId, input.operation_key],
      );
      rule(batches[0].fingerprint === fingerprint, 'ROLLOUT_KEY_REUSED', 409);
      const current = await this.live(c, actor);
      for (const entry of input.resources) this.access(current, entry.resource, true);
      if (batches[0].id === id) {
        for (const entry of input.resources) {
          const old = await this.binding.status(current, entry.resource);
          rule((old.revision ?? 0) === entry.expected_revision, 'ROLLOUT_REVISION', 409);
          const before: Body = {
            expected_revision: entry.expected_revision,
            template_pins: old.template_pins,
            overrides: old.configuration?.overrides ?? {},
            group_id: old.configuration?.group_id ?? null,
          };
          const pins = [
            ...new Map(
              [...old.template_pins, ...input.pins].map((p) => [p.template_id, p]),
            ).values(),
          ].sort((a, b) => (a.template_id < b.template_id ? -1 : 1));
          const item: Item = {
            resource: entry.resource,
            before,
            candidate: { ...before, template_pins: pins },
            attempt: 0,
            key: `${id}:${refKey(entry.resource)}:0`,
            state: 'ready',
            error: null,
            target_revision: null,
          };
          await c.execute('INSERT INTO metric_template_rollout_items VALUES(?,?,?)', [
            id,
            refKey(entry.resource),
            JSON.stringify(item),
          ]);
        }
      }
      const final = await this.live(c, actor, true);
      for (const entry of input.resources) this.access(final, entry.resource, true);
      return { id: String(batches[0].id) };
    });
  }
  private async collectionFailure(ref: Ref, revision: number | null) {
    if (revision === null) return null;
    const [rows] = await this.pool().execute<RowDataPacket[]>(
      "SELECT id,error_code FROM metric_collect_requests WHERE resource_key=? AND revision=? AND state='failed' ORDER BY created_at DESC,id DESC LIMIT 1",
      [refKey(ref), revision],
    );
    if (rows.length)
      return {
        kind: 'collect_now',
        id: String(rows[0].id),
        code: String(rows[0].error_code ?? 'collection_failed'),
      };
    const [events] = await this.pool().execute<RowDataPacket[]>(
      "SELECT id,code FROM metric_schedule_events WHERE resource_key=? AND revision=? AND code='collection_failed' ORDER BY id DESC LIMIT 1",
      [refKey(ref), revision],
    );
    return events.length
      ? { kind: 'scheduled', id: String(events[0].id), code: String(events[0].code) }
      : null;
  }
  async read(actor: ActorContext, id: string) {
    z.string().uuid().parse(id);
    const [batch] = await this.pool().execute<RowDataPacket[]>(
      'SELECT actor_id,payload FROM metric_template_rollouts WHERE id=?',
      [id],
    );
    rule(batch.length === 1, 'ROLLOUT_NOT_FOUND', 404);
    rule(Number(batch[0].actor_id) === actor.userId, 'ROLLOUT_FORBIDDEN', 403);
    const [rows] = await this.pool().execute<RowDataPacket[]>(
      'SELECT payload FROM metric_template_rollout_items WHERE batch_id=? ORDER BY resource_key',
      [id],
    );
    const items = [];
    for (const row of rows) {
      const item = decode(row.payload) as Item;
      const current = await actorContextService.revalidateActor(actor);
      this.access(current, item.resource, false);
      const status = await this.binding.status(current, item.resource);
      const failure = await this.collectionFailure(item.resource, item.target_revision);
      items.push({
        ...item,
        status,
        collection_failure: failure,
        receipt:
          item.target_revision === null
            ? item.state
            : status.application?.applied_revision === item.target_revision
              ? 'applied'
              : status.revision !== item.target_revision
                ? 'superseded'
                : failure
                  ? 'collection_failed'
                  : (status.application?.status ?? 'unknown'),
      });
    }
    const final = await actorContextService.revalidateActor(actor);
    for (const item of items) this.access(final, item.resource, false);
    return { id, ...decode(batch[0].payload), items };
  }
  private async prepare(
    actor: ActorContext,
    id: string,
    ref: Ref,
    action: 'apply' | 'retry' | 'rollback',
    command: string,
  ) {
    await this.transaction(async (c) => {
      const [batch] = await c.execute<RowDataPacket[]>(
        'SELECT actor_id FROM metric_template_rollouts WHERE id=?',
        [id],
      );
      rule(batch.length === 1, 'ROLLOUT_NOT_FOUND', 404);
      rule(Number(batch[0].actor_id) === actor.userId, 'ROLLOUT_FORBIDDEN', 403);
      const [rows] = await c.execute<RowDataPacket[]>(
        'SELECT payload FROM metric_template_rollout_items WHERE batch_id=? AND resource_key=? FOR UPDATE',
        [id, refKey(ref)],
      );
      rule(rows.length === 1, 'ROLLOUT_NOT_FOUND', 404);
      const item = decode(rows[0].payload) as Item;
      this.access(await this.live(c, actor), ref, true);
      item.commands ??= {};
      const recorded = item.commands[command];
      if (recorded) {
        rule(recorded.action === action, 'ROLLOUT_KEY_REUSED', 409);
        rule(recorded.key === item.key, 'ROLLOUT_SUPERSEDED', 409);
        return;
      }
      const status = await this.binding.status(actor, ref);
      if (action === 'rollback' && !item.rollback) {
        rule(
          item.target_revision !== null && status.revision === item.target_revision,
          'ROLLOUT_REVISION',
          409,
        );
        rule(item.before.template_pins.length > 0, 'ROLLOUT_UNBIND_NOT_ALLOWED', 422);
        item.candidate = { ...item.before, expected_revision: status.revision! };
        item.rollback = true;
      } else if (
        action === 'retry' &&
        (item.state === 'failed' ||
          (item.state === 'submitted' &&
            status.application?.applied_revision !== item.target_revision &&
            (status.application?.status === 'failed' ||
              (await this.collectionFailure(ref, item.target_revision)))))
      ) {
        const old = await this.binding.operation(actor, ref, item.key);
        rule(old.state !== 'pending', 'ROLLOUT_APPLICATION_UNKNOWN', 409);
        const expected =
          old.state === 'committed' ? item.target_revision : item.candidate.expected_revision;
        rule((status.revision ?? 0) === expected, 'ROLLOUT_REVISION', 409);
        item.candidate.expected_revision = status.revision ?? 0;
      } else if (action !== 'apply') {
        rule(false, 'ROLLOUT_ACTION_STATE', 409);
      }
      if (action !== 'apply') {
        item.attempt++;
        item.key = `${id}:${refKey(ref)}:${item.attempt}`;
        item.state = 'ready';
        item.error = null;
      }
      item.commands[command] = { action, key: item.key };
      this.access(await this.live(c, actor, true), ref, true);
      // Persist the next exact key BEFORE any external trial/application. Crash/retry reuses it.
      await c.execute(
        'UPDATE metric_template_rollout_items SET payload=? WHERE batch_id=? AND resource_key=?',
        [JSON.stringify(item), id, refKey(ref)],
      );
      await c.execute(
        'INSERT INTO metric_template_rollout_audit(batch_id,resource_key,payload) VALUES(?,?,?)',
        [
          id,
          refKey(ref),
          JSON.stringify({ actor_id: actor.userId, action, key: item.key, state: 'intent' }),
        ],
      );
    });
  }
  async step(
    actor: ActorContext,
    id: string,
    ref: Ref,
    action: 'apply' | 'retry' | 'rollback' = 'apply',
    command: string,
  ) {
    z.string().uuid().parse(id);
    RefSchema.parse(ref);
    OperationKeySchema.parse(command);
    await this.prepare(actor, id, ref, action, command);
    return this.transaction(async (c) => {
      const [batch] = await c.execute<RowDataPacket[]>(
        'SELECT actor_id FROM metric_template_rollouts WHERE id=?',
        [id],
      );
      rule(batch.length === 1, 'ROLLOUT_NOT_FOUND', 404);
      rule(Number(batch[0].actor_id) === actor.userId, 'ROLLOUT_FORBIDDEN', 403);
      const [rows] = await c.execute<RowDataPacket[]>(
        'SELECT payload FROM metric_template_rollout_items WHERE batch_id=? AND resource_key=? FOR UPDATE',
        [id, refKey(ref)],
      );
      rule(rows.length === 1, 'ROLLOUT_NOT_FOUND', 404);
      const item = decode(rows[0].payload) as Item;
      const previous = stable(item);
      rule(item.commands?.[command]?.key === item.key, 'ROLLOUT_SUPERSEDED', 409);
      this.access(await this.live(c, actor), ref, true);
      const operation = await this.binding.operation(actor, ref, item.key);
      if (operation.state === 'pending') {
        item.state = 'unknown';
        item.error = 'ROLLOUT_APPLICATION_UNKNOWN';
      } else if (operation.state === 'committed') {
        item.state = 'submitted';
        item.target_revision = operation.operation!.target_revision;
        item.error = null;
      } else {
        const status = await this.binding.status(actor, ref);
        try {
          rule(
            (status.revision ?? 0) === item.candidate.expected_revision,
            'ROLLOUT_REVISION',
            409,
          );
          const body = { ...item.candidate, receipt_id: item.key };
          if (status.source === 'unbound') await this.binding.probe(actor, ref, body);
          await this.binding.preview(actor, ref, body);
          await this.binding.trial(actor, ref, body);
          const result = await this.binding.apply(actor, ref, { ...body, caller_key: item.key });
          if (result.kind === 'committed') {
            item.state = 'submitted';
            item.target_revision = result.revision;
            item.error = null;
          } else {
            item.state = 'unknown';
            item.error = 'ROLLOUT_APPLICATION_UNKNOWN';
          }
        } catch (error) {
          const lookup = await this.binding.operation(actor, ref, item.key);
          if (lookup.state === 'committed') {
            item.state = 'submitted';
            item.target_revision = lookup.operation!.target_revision;
            item.error = null;
          } else if (lookup.state === 'pending') {
            item.state = 'unknown';
            item.error = 'ROLLOUT_APPLICATION_UNKNOWN';
          } else {
            item.state = 'failed';
            item.error = failureCode(error);
          }
        }
      }
      // Config apply may have committed even if journal/response is lost. Its stable key recovers next time.
      this.access(await this.live(c, actor, true), ref, true);
      if (previous !== stable(item)) {
        await c.execute(
          'UPDATE metric_template_rollout_items SET payload=? WHERE batch_id=? AND resource_key=?',
          [JSON.stringify(item), id, refKey(ref)],
        );
        await c.execute(
          'INSERT INTO metric_template_rollout_audit(batch_id,resource_key,payload) VALUES(?,?,?)',
          [
            id,
            refKey(ref),
            JSON.stringify({
              actor_id: actor.userId,
              action,
              state: item.state,
              key: item.key,
              target_revision: item.target_revision,
              at: new Date().toISOString(),
            }),
          ],
        );
      }
      return item;
    });
  }
}
