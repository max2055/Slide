// Test-only gate for cancellation/handler unit probes; SQL semantics are tested against MySQL separately.
import type { DeliveryGate, DeliveryRequest } from './delivery-store.js';
import { deliveryIdentity } from './delivery-store.js';
export function testDeliveryGate(): DeliveryGate {
  const rows = new Map<string, { request: DeliveryRequest; state: string }>();
  return {
    preflightFailed: async () => {},
    snapshot: async key => rows.get(key)?.request ?? null,
    acquire: async (job, context, request) => {
      context.signal.throwIfAborted();
      const { key } = deliveryIdentity(job);
      if (!request || rows.has(key)) return null;
      rows.set(key, { request, state: 'sending' });
      return { key, attemptId: String(job.fencingToken), request };
    },
    finish: async (_job, context, claim, state) => { context.signal.throwIfAborted(); rows.get(claim.key)!.state = state; },
  };
}
