import { createHash } from "node:crypto";
import type { Pool, PoolConnection, RowDataPacket } from "mysql2/promise";
import { rule } from "../policy/model.js";
import type { BulkJob, BulkStore } from "./model.js";

const decode = (value: string | BulkJob): BulkJob =>
  typeof value === "string" ? JSON.parse(value) : value;
/** Queue state only. Publication and its immutable audit remain owned by PolicyService. */
export class MysqlBulkStore implements BulkStore {
  private worker: PoolConnection | null = null;
  constructor(private pool: () => Pool) {}
  async exclusive<T>(fn: () => Promise<T>, key = "worker"): Promise<T | null> {
    const connection = await this.pool().getConnection();
    const lock = `metric-bulk:${createHash("sha256").update(key).digest("hex").slice(0, 40)}`;
    let acquired = false;
    try {
      const [rows] = await connection.execute<RowDataPacket[]>("SELECT GET_LOCK(?,0) AS held", [
        lock,
      ]);
      if (Number(rows[0].held) !== 1) return null;
      acquired = true;
      if (key === "worker") this.worker = connection;
      return await fn();
    } finally {
      if (key === "worker" && this.worker === connection) this.worker = null;
      // If release fails, destroy the connection so its lock never returns to the pool.
      try {
        if (acquired) await connection.execute("SELECT RELEASE_LOCK(?)", [lock]);
      } catch {
        connection.destroy();
      }
      connection.release();
    }
  }
  async fence() {
    rule(this.worker, "BULK_WORKER_LEASE_LOST", 503);
    await this.worker.ping();
  }
  async create(job: BulkJob) {
    const result = await this.exclusive(async () => {
      const [old] = await this.pool().execute<RowDataPacket[]>(
        "SELECT payload FROM metric_bulk_jobs WHERE owner_id=? AND idempotency_key=?",
        [job.actor.userId, job.key],
      );
      if (old[0]) {
        const saved = decode(old[0].payload);
        rule(saved.input_digest === job.input_digest, "BULK_IDEMPOTENCY_CONFLICT", 409);
        return saved;
      }
      const [counts] = await this.pool().execute<RowDataPacket[]>(
        `SELECT COUNT(*) AS total,SUM(owner_id=?) AS owned FROM metric_bulk_jobs
        WHERE state IN ('draft','queued','running') AND (state<>'draft' OR expires_at>UTC_TIMESTAMP(3))`,
        [job.actor.userId],
      );
      rule(Number(counts[0].total) < 100 && Number(counts[0].owned) < 10, "BULK_QUEUE_LIMIT", 429);
      await this.pool().execute(
        `INSERT INTO metric_bulk_jobs(id,owner_id,idempotency_key,state,payload,expires_at) VALUES(?,?,?,?,?,?)`,
        [
          job.id,
          job.actor.userId,
          job.key,
          job.state,
          JSON.stringify(job),
          new Date(job.expires_at),
        ],
      );
      return job;
    }, "admission");
    rule(result, "BULK_BUSY", 409);
    return result;
  }
  async get(id: string) {
    const [rows] = await this.pool().execute<RowDataPacket[]>(
      "SELECT payload FROM metric_bulk_jobs WHERE id=?",
      [id],
    );
    return rows[0] ? decode(rows[0].payload) : null;
  }
  async save(job: BulkJob, fenced = false) {
    const executor = fenced ? this.worker : this.pool();
    rule(executor, "BULK_WORKER_LEASE_LOST", 503);
    // A worker write uses the lock-owning connection. A lost connection cannot
    // reconnect through the pool and overwrite a replacement worker's results.
    await executor.execute("UPDATE metric_bulk_jobs SET state=?,payload=? WHERE id=?", [
      job.state,
      JSON.stringify(job),
      job.id,
    ]);
  }
  async list(owner?: number) {
    const [rows] = await this.pool().execute<RowDataPacket[]>(
      owner === undefined
        ? "SELECT payload FROM metric_bulk_jobs WHERE state IN ('queued','running') ORDER BY created_at,id LIMIT 10"
        : "SELECT payload FROM metric_bulk_jobs WHERE owner_id=? ORDER BY created_at DESC,id DESC LIMIT 10",
      owner === undefined ? [] : [owner],
    );
    return rows.map((row) => decode(row.payload));
  }
  async cancel(id: string) {
    await this.pool().execute("UPDATE metric_bulk_jobs SET cancel_requested=TRUE WHERE id=?", [id]);
  }
  async cancelled(id: string) {
    const [rows] = await this.pool().execute<RowDataPacket[]>(
      "SELECT cancel_requested FROM metric_bulk_jobs WHERE id=?",
      [id],
    );
    return !rows[0] || Boolean(rows[0].cancel_requested);
  }
}
