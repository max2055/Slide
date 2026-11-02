import { describe, it, expect } from "vitest";
import {
  assertDependencyAcyclic,
  DependencyChange,
  type Dependency,
} from "./alert-dependencies.js";
import { deliveryIdentity } from "./workflows/delivery-store.js";
import { NotificationDispatchScheduler } from "./workflows/notification-dispatch.js";
const ref = (id: number) => ({ resource: { type: "instance" as const, id }, rule_id: "*" });
const edge = (a: number, b: number, disabled = false): Dependency => ({
  id: `${a}-${b}`,
  name: "dependency",
  revision: 1,
  upstream: ref(a),
  downstream: ref(b),
  disabled,
  actor_id: 1,
  changed_at: new Date().toISOString(),
});
describe("MAX244 dependency boundaries", () => {
  it("rejects self and transitive cycles including different rule selectors", () => {
    expect(() => assertDependencyAcyclic([edge(1, 1)])).toThrow("DEPENDENCY_CYCLE");
    expect(() => assertDependencyAcyclic([edge(1, 2), edge(2, 3), edge(3, 1)])).toThrow(
      "DEPENDENCY_CYCLE",
    );
    expect(() => assertDependencyAcyclic([edge(1, 2), edge(2, 3), edge(3, 1, true)])).not.toThrow();
  });
  it("requires bounded resource IDs and rejects unrecognized write authority fields", () => {
    const value = { name: "dependency", upstream: ref(1), downstream: ref(2) };
    expect(
      DependencyChange.safeParse({ operation_key: "key", expected_revision: 0, value }).success,
    ).toBe(true);
    expect(
      DependencyChange.safeParse({
        operation_key: "key",
        expected_revision: 0,
        value,
        actor_id: 999,
      }).success,
    ).toBe(false);
    expect(
      DependencyChange.safeParse({
        operation_key: "key",
        expected_revision: 0,
        value: { ...value, upstream: ref(-1) },
      }).success,
    ).toBe(false);
  });
  it("separates problem/recovery/escalation identities while reusing identical transition keys on retry", async () => {
    const jobs: any[] = [];
    for (const phase of [
      undefined,
      { id: "recovery", phase: "recovery", at: new Date().toISOString() },
      { id: "escalation-error", phase: "escalation", at: new Date().toISOString() },
    ]) {
      const scheduler = new NotificationDispatchScheduler(
        {
          getPendingAlerts: async () =>
            [{ id: 7, level: "error", ...(phase ? { transition: phase } : {}) }] as any,
          getEnabledChannels: async () => [{ id: 2 }],
        },
        { routeAlert: (_, cs) => cs },
        {
          enqueue: async (j) => {
            jobs.push(j);
          },
        },
      );
      await scheduler.enqueuePending();
      await scheduler.enqueuePending();
    }
    const keys = jobs.map((j) => deliveryIdentity(j).key);
    expect(new Set(keys).size).toBe(3);
    for (let i = 0; i < 6; i += 2) expect(keys[i]).toBe(keys[i + 1]);
    expect(keys[0]).toBe("notification:7:2");
    expect(keys[2]).toBe("notification:7:2:recovery");
    expect(() =>
      deliveryIdentity({
        type: "notification.deliver",
        payload: {
          alertId: 7,
          channelId: 2,
          transition: { id: "a:b", phase: "recovery", at: "invalid" },
        },
      }),
    ).toThrow("DELIVERY_PAYLOAD_INVALID");
  });
});
