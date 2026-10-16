import { describe, expect, it } from "vitest";
import {
  postgresCounterTransport,
  POSTGRES_DIAGNOSTICS_COUNTER_SQL,
} from "../config/postgres-counter.js";
import { createConfigurationRegistry } from "../config/registry.js";
import { implementationId } from "./catalog.js";
import { collectDatabase } from "./collector.js";
import { diagnosticReads } from "./diagnostics.js";

describe("compatible former realtime diagnostic fields", () => {
  it("keeps frozen releases and offers valid fields in a distinct release", () => {
    const releases = createConfigurationRegistry().list();
    const expected = {
      mysql: [
        "mysql.innodb.row_lock_average_ms",
        "mysql.innodb.deadlocks_total",
        "mysql.temporary.disk_tables_total",
        "mysql.thread_cache.hit_percent",
        "mysql.transactions.active",
        "mysql.replication.behind_source_seconds",
      ],
      postgresql: [
        "postgresql.database.tuples_returned_total",
        "postgresql.database.blocks_read_total",
        "postgresql.database.temp_files_total",
        "postgresql.database.deadlocks_total",
        "postgresql.transactions.active",
      ],
      oracle: [
        "oracle.library_cache.pin_hit_percent",
        "oracle.tablespaces.user_max_allocated_used_percent",
      ],
      dameng: [
        "dameng.memory_pool.allocated_bytes",
        "dameng.os.allocated_memory_bytes",
        "dameng.sessions.active",
      ],
    };
    for (const [engine, ids] of Object.entries(expected)) {
      const old = releases.find(
        (r) => r.package.id === `${engine}-diagnostics` && r.package.version === "1.0.0",
      )!;
      const next = releases.find(
        (r) => r.package.id === `${engine}-diagnostics` && r.package.version === "1.1.0",
      );
      expect(next, engine).toBeDefined();
      const outputs = next!.package.collectors.flatMap((c) => c.mappings.map((m) => m.metric.id));
      expect(outputs).toEqual(expect.arrayContaining(ids));
      expect(next!.package.digest).not.toBe(old.package.digest);
      expect(
        old.package.collectors.flatMap((c) => c.mappings.map((m) => m.metric.id)),
      ).not.toContain(ids[0]);
    }
  });
  it("binds new PostgreSQL totals and the reset epoch in a single actual statement", async () => {
    const read = diagnosticReads.find(
      (r) => r.engine === "postgresql" && r.name === "database_diagnostics",
    )!;
    let calls = 0;
    const transport = postgresCounterTransport(async (sql) => {
      calls++;
      expect(sql).toBe(POSTGRES_DIAGNOSTICS_COUNTER_SQL);
      return {
        rows: [
          {
            database: "app",
            database_oid: "100",
            startup: "2026-10-16T12:00:00.000000Z",
            reset: "2026-10-16T13:00:00.000001Z",
            sampled_at: "2026-10-16T14:00:00.000000Z",
            ...Object.fromEntries(read.fields.map((f) => [f.name, "9007199254740993"])),
          },
        ],
      };
    });
    const [row] = await collectDatabase(implementationId(read), transport, {}, 1000);
    expect(calls).toBe(1);
    expect(row.dimensions).toEqual({ database: "app" });
    expect(row.fields.deadlocks).toEqual({ encoding: "uint64", value: "9007199254740993" });
    expect(row.counter?.discontinuity).toMatchObject({ reason: "reset" });
  });
  it("keeps each replication channel and NULL lag, decodes status explicitly", async () => {
    const read = diagnosticReads.find((r) => r.name === "replication_channels")!;
    expect(read).toBeDefined();
    const rows = [
      {
        Channel_Name: "one",
        Seconds_Behind_Source: null,
        Replica_IO_Running: "Connecting",
        Replica_SQL_Running: "Yes",
      },
      {
        Channel_Name: "two",
        Seconds_Behind_Source: 7,
        Replica_IO_Running: "Yes",
        Replica_SQL_Running: "No",
      },
    ];
    const [a, b] = await collectDatabase(
      implementationId(read),
      { method: "sql", pool: { query: async () => [rows, []] } },
      {},
      1000,
    );
    expect(a.dimensions).toEqual({ channel: "one" });
    expect(a.fields).toMatchObject({
      lag: null,
      io_running: { encoding: "uint64", value: "0" },
      sql_running: { encoding: "uint64", value: "1" },
    });
    expect(b.dimensions).toEqual({ channel: "two" });
    expect(b.fields.lag).toEqual({ encoding: "float64", value: 7 });
    expect(
      await collectDatabase(
        implementationId(read),
        { method: "sql", pool: { query: async () => [[], []] } },
        {},
        1000,
      ),
    ).toEqual([]);
  });
  it("uses the historical replication spelling only on syntax rejection, never auth or timeout", async () => {
    const read = diagnosticReads.find((r) => r.name === "replication_channels")!;
    for (const code of ["ER_ACCESS_DENIED_ERROR", "ETIMEDOUT"]) {
      let calls = 0;
      await expect(
        collectDatabase(
          implementationId(read),
          {
            method: "sql",
            pool: {
              query: async () => {
                calls++;
                throw { code };
              },
            },
          },
          {},
          1000,
        ),
      ).rejects.toThrow();
      expect(calls).toBe(1);
    }
    const queries: string[] = [];
    const [row] = await collectDatabase(
      implementationId(read),
      {
        method: "sql",
        pool: {
          query: async ({ sql }) => {
            queries.push(sql);
            if (queries.length === 1) throw { code: "ER_PARSE_ERROR" };
            return [
              [
                {
                  Channel_Name: "",
                  Seconds_Behind_Master: 0,
                  Slave_IO_Running: "Yes",
                  Slave_SQL_Running: "Yes",
                },
              ],
              [],
            ];
          },
        },
      },
      {},
      1000,
    );
    expect(queries).toEqual(["SHOW REPLICA STATUS", "SHOW SLAVE STATUS"]);
    expect(row.fields.lag).toEqual({ encoding: "float64", value: 0 });
  });
});
