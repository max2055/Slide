import type { Pool } from "mysql2/promise";
import { expect, it, vi } from "vitest";
import type { BulkJob } from "./model.js";
import { MysqlBulkStore } from "./store.js";

it("never borrows a replacement connection for progress after the worker lease connection fails", async () => {
  let disconnected = false;
  const connection = {
    execute: vi.fn(async () => {
      if (disconnected) throw new Error("lease connection lost");
      return [[{ held: 1 }]];
    }),
    ping: vi.fn(async () => {
      if (disconnected) throw new Error("lease connection lost");
    }),
    release: vi.fn(),
    destroy: vi.fn(),
  };
  const pool = { getConnection: vi.fn(async () => connection), execute: vi.fn() };
  const store = new MysqlBulkStore(() => pool as unknown as Pool);
  const job = { id: "job", state: "running" } as BulkJob;
  await store.exclusive(async () => {
    await store.save(job, true);
    disconnected = true;
    await expect(store.fence()).rejects.toThrow("lease connection lost");
    await expect(store.save(job, true)).rejects.toThrow("lease connection lost");
  });
  expect(pool.execute).not.toHaveBeenCalled();
  expect(pool.getConnection).toHaveBeenCalledTimes(1);
  expect(connection.destroy).toHaveBeenCalledTimes(1);
  await expect(store.save(job, true)).rejects.toThrow("BULK_WORKER_LEASE_LOST");
});
