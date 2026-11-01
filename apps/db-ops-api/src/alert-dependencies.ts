import { randomUUID, createHash } from "node:crypto";
import type { Pool, PoolConnection, RowDataPacket } from "mysql2/promise";
import { z } from "zod";
import { actorContextService, type ActorContext } from "./auth/actor-context.js";
import { stable } from "./metrics/packages/model.js";
import { OperationKeySchema, rule, type Ref } from "./metrics/policy/model.js";
import {
  canManageResource,
  canReadResource,
  MysqlResourceRelationStore,
} from "./resources/resource-service.js";
export { DependencyChange } from "./contracts/alert-dependencies.js";
import { DependencyChange, type Dependency, type Value } from "./contracts/alert-dependencies.js";
export type { Dependency } from "./contracts/alert-dependencies.js";
const decode = (v: any) => (typeof v === "string" ? JSON.parse(v) : v);
const key = (r: Ref) => `${r.type}:${r.id}`;
/** Conservative resource graph also rejects cycles made from different rule selectors. */
export function assertDependencyAcyclic(rows: Dependency[]) {
  const graph = new Map<string, string[]>();
  for (const v of rows.filter((r) => !r.disabled)) {
    const a = key(v.upstream.resource),
      b = key(v.downstream.resource);
    graph.set(a, [...(graph.get(a) ?? []), b]);
  }
  const path = new Set<string>(),
    done = new Set<string>();
  const visit = (v: string) => {
    rule(!path.has(v), "DEPENDENCY_CYCLE", 409);
    if (done.has(v)) return;
    path.add(v);
    for (const b of graph.get(v) ?? []) visit(b);
    path.delete(v);
    done.add(v);
  };
  for (const v of graph.keys()) visit(v);
}
export class AlertDependencies {
  constructor(private pool: () => Pool) {}
  private access(a: ActorContext, v: Value, write: boolean) {
    rule(
      !write || a.permissions.includes("*") || a.permissions.includes("alert:manage"),
      "DEPENDENCY_FORBIDDEN",
      403,
    );
    for (const e of [v.upstream, v.downstream])
      rule(
        write ? canManageResource(a, e.resource) : canReadResource(a, e.resource),
        "DEPENDENCY_FORBIDDEN",
        403,
      );
  }
  private async tx<T>(
    actor: ActorContext,
    work: (c: PoolConnection, live: (lock?: boolean) => Promise<ActorContext>) => Promise<T>,
  ) {
    const c = await this.pool().getConnection();
    let reusable = false;
    try {
      await c.query("SET TRANSACTION ISOLATION LEVEL READ COMMITTED");
      await c.beginTransaction();
      await c.execute("SELECT id FROM alert_dependency_lock WHERE id=1 FOR UPDATE");
      const live = (lock = false) =>
        actorContextService.revalidateActorOn(c as any, actor, actor.requestId, lock);
      await live();
      const result = await work(c, live);
      await c.commit();
      reusable = true;
      return result;
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
  async list(actor: ActorContext) {
    return this.tx(actor, async (c, live) => {
      const [rows] = await c.execute<RowDataPacket[]>("SELECT payload FROM alert_dependencies");
      const a = await live();
      return rows
        .map((r) => decode(r.payload) as Dependency)
        .filter((v) => {
          try {
            this.access(a, v, false);
            return true;
          } catch {
            return false;
          }
        });
    });
  }
  async catalog(actor: ActorContext) {
    return this.tx(actor, async (c, live) => {
      const a = await live(),
        result: Array<Ref & { name: string; rules: Array<{ id: string; source: string }> }> = [];
      for (const [type, table, label] of [
        ["instance", "database_instances", "name"],
        ["server", "servers", "label"],
        ["network_device", "network_devices", "name"],
      ] as const) {
        const [rows] = await c.execute<RowDataPacket[]>(`SELECT id,${label} AS name FROM ${table}`);
        for (const row of rows) {
          const ref = { type, id: Number(row.id) };
          if (!canManageResource(a, ref)) continue;
          const [snapshots] = await c.execute<RowDataPacket[]>(
            "SELECT payload FROM metric_trigger_snapshots WHERE resource_key=? ORDER BY config_revision DESC LIMIT 1",
            [key(ref)],
          );
          const rules: Array<{ id: string; source: string }> = [
            { id: "*", source: "该资源全部问题规则" },
          ];
          if (snapshots.length)
            for (const r of decode(snapshots[0].payload).rules)
              if (!rules.some((v) => v.id === r.rule_id))
                rules.push({ id: r.rule_id, source: "已应用模板规则" });
          if (type === "instance") {
            const [legacy] = await c.execute<RowDataPacket[]>(
              "SELECT id,name,instance_ids FROM alert_rules WHERE enabled=1",
            );
            for (const r of legacy) {
              const ids = decode(r.instance_ids);
              if (!ids || ids.includes(ref.id))
                rules.push({ id: `legacy:${r.id}`, source: `原告警规则：${r.name}` });
            }
          }
          result.push({ ...ref, name: String(row.name ?? key(ref)), rules });
        }
      }
      const final = await live();
      return result.filter((r) => canManageResource(final, r));
    });
  }
  async operation(actor: ActorContext, op: string) {
    OperationKeySchema.parse(op);
    return this.tx(actor, async (c, live) => {
      const [rows] = await c.execute<RowDataPacket[]>(
        "SELECT payload FROM alert_dependency_operations WHERE actor_id=? AND operation_key=?",
        [actor.userId, op],
      );
      if (!rows.length) return { status: "absent" };
      const stored = decode(rows[0].payload);
      for (const v of stored.required) this.access(await live(), v, true);
      return { status: "committed", result: stored.result };
    });
  }
  async change(actor: ActorContext, id: string | null, raw: unknown) {
    if (id) z.string().uuid().parse(id);
    const input = DependencyChange.parse(raw);
    rule(input.disabled ? !input.value && id : input.value, "DEPENDENCY_INPUT");
    const digest = createHash("sha256")
      .update(stable({ id, ...input }))
      .digest("hex");
    return this.tx(actor, async (c, live) => {
      const [ops] = await c.execute<RowDataPacket[]>(
        "SELECT fingerprint,payload FROM alert_dependency_operations WHERE actor_id=? AND operation_key=?",
        [actor.userId, input.operation_key],
      );
      if (ops.length) {
        rule(ops[0].fingerprint === digest, "DEPENDENCY_KEY_REUSED", 409);
        const saved = decode(ops[0].payload);
        for (const v of saved.required) this.access(await live(true), v, true);
        return saved.result;
      }
      const [rows] = await c.execute<RowDataPacket[]>("SELECT payload FROM alert_dependencies");
      const all = rows.map((r) => decode(r.payload) as Dependency),
        previous = all.find((r) => r.id === id);
      rule(!id || previous, "DEPENDENCY_NOT_FOUND", 404);
      if (previous) this.access(await live(), previous, true);
      rule((previous?.revision ?? 0) === input.expected_revision, "DEPENDENCY_REVISION", 409);
      let next: Dependency = {
        ...(input.value ?? previous!),
        id: id ?? randomUUID(),
        revision: (previous?.revision ?? 0) + 1,
        disabled: !!input.disabled,
        actor_id: actor.userId,
        changed_at: new Date().toISOString(),
      };
      this.access(await live(), next, true);
      const assets = new MysqlResourceRelationStore(() => c as any);
      for (const e of [next.upstream, next.downstream])
        rule(await assets.exists(e.resource), "DEPENDENCY_RESOURCE_MISSING", 404);
      if (!next.disabled)
        for (const e of [next.upstream, next.downstream]) {
          if (e.rule_id === "*") continue;
          if (e.rule_id.startsWith("legacy:")) {
            const [rules] = await c.execute<RowDataPacket[]>(
              "SELECT instance_ids FROM alert_rules WHERE id=? AND enabled=1",
              [Number(e.rule_id.slice(7)) || 0],
            );
            rule(
              e.resource.type === "instance" &&
                rules.length === 1 &&
                (!decode(rules[0].instance_ids) ||
                  decode(rules[0].instance_ids).includes(e.resource.id)),
              "DEPENDENCY_RULE_MISSING",
              409,
            );
          } else {
            const [snapshots] = await c.execute<RowDataPacket[]>(
              "SELECT payload FROM metric_trigger_snapshots WHERE resource_key=? ORDER BY config_revision DESC LIMIT 1",
              [key(e.resource)],
            );
            rule(
              snapshots.length &&
                decode(snapshots[0].payload).rules.some((r: any) => r.rule_id === e.rule_id),
              "DEPENDENCY_RULE_MISSING",
              409,
            );
          }
        }
      assertDependencyAcyclic([...all.filter((r) => r.id !== id), next]);
      const noop =
        !!previous &&
        stable({
          name: previous.name,
          upstream: previous.upstream,
          downstream: previous.downstream,
          disabled: previous.disabled,
        }) ===
          stable({
            name: next.name,
            upstream: next.upstream,
            downstream: next.downstream,
            disabled: next.disabled,
          });
      if (noop) next = previous!;
      else {
        await c.execute(
          "INSERT INTO alert_dependencies VALUES(?,?,?) ON DUPLICATE KEY UPDATE revision=VALUES(revision),payload=VALUES(payload)",
          [next.id, next.revision, JSON.stringify(next)],
        );
        await c.execute(
          "INSERT INTO alert_dependency_audit(dependency_id,revision,payload) VALUES(?,?,?)",
          [next.id, next.revision, JSON.stringify(next)],
        );
      }
      const result = { success: true, dependency: next, noop };
      const required = previous ? [previous, next] : [next];
      await c.execute("INSERT INTO alert_dependency_operations VALUES(?,?,?,?)", [
        actor.userId,
        input.operation_key,
        digest,
        JSON.stringify({ result, required }),
      ]);
      const final = await live(true);
      for (const v of required) this.access(final, v, true);
      return result;
    });
  }
}
/** Called under the existing formal writer transaction. Acknowledgement never changes problem truth. */
export async function blockingDependencies(c: PoolConnection, ref: Ref, ruleId: string) {
  const [rows] = await c.execute<RowDataPacket[]>(
    "SELECT payload FROM alert_dependencies FOR SHARE",
  );
  const blocked: Dependency[] = [];
  for (const row of rows) {
    const d: Dependency = decode(row.payload);
    if (
      d.disabled ||
      key(d.downstream.resource) !== key(ref) ||
      (d.downstream.rule_id !== "*" && d.downstream.rule_id !== ruleId)
    )
      continue;
    const [episodes] = await c.execute<RowDataPacket[]>(
      `SELECT payload FROM metric_trigger_episodes WHERE resource_key=? FOR SHARE`,
      [key(d.upstream.resource)],
    );
    if (
      episodes.some((r) => {
        const p = decode(r.payload);
        return (
          p.state === "open" && (d.upstream.rule_id === "*" || p.rule_id === d.upstream.rule_id)
        );
      })
    ) {
      blocked.push(d);
      continue;
    }
    const column =
      d.upstream.resource.type === "instance"
        ? "instance_id"
        : d.upstream.resource.type === "server"
          ? "server_id"
          : "network_device_id";
    const [legacy] = await c.execute<RowDataPacket[]>(
      `SELECT tags FROM alerts WHERE ${column}=? AND status NOT IN ('resolved','closed') AND (source IS NULL OR source<>'template-trigger') FOR SHARE`,
      [d.upstream.resource.id],
    );
    if (
      legacy.some(
        (r) =>
          d.upstream.rule_id === "*" ||
          `legacy:${decode(r.tags ?? {}).rule_id}` === d.upstream.rule_id,
      )
    )
      blocked.push(d);
  }
  return blocked;
}
