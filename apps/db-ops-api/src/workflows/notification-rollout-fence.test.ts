import { describe, expect, it, vi } from 'vitest';
import { JobRegistry } from './job-registry.js';
import { registerNotificationHandlers } from './notification-handlers.js';
import type { DeliveryClaim, DeliveryGate, DeliveryRequest } from './delivery-store.js';
import {
  parseRolloutAlertFence,
  type RolloutAlertPublicationGate,
} from '../metrics-v2/rollout/alert-publication-fence.js';

const fence = {
  series_hash: 'a'.repeat(64),
  source: 'v2',
  generation: 4,
  revision: 12,
};

const alert = {
  id: 7,
  instance_id: 3,
  source: 'metrics-v2-rollout',
  status: 'unread',
  level: 'warning',
  title: 'CPU high',
  message: 'CPU high',
  created_at: new Date('2026-09-24T00:00:00.000Z'),
  tags: { rollout_fence: fence },
};

const channel = {
  id: 2,
  name: 'operations',
  type: 'webhook' as const,
  enabled: true,
  config: { webhook_url: 'https://hooks.example.com/metrics' },
  created_at: new Date('2026-09-24T00:00:00.000Z'),
  updated_at: new Date('2026-09-24T00:00:00.000Z'),
};

function deliveryGate(finished: Array<{ state: string; error?: string }>): DeliveryGate {
  return {
    preflightFailed: async () => {},
    snapshot: async () => null,
    acquire: async (job, _context, request) => request ? {
      key: `notification:${job.payload.alertId}:${job.payload.channelId}`,
      attemptId: 'attempt-1',
      request,
    } : null,
    finish: async (_job, _context, _claim, state, error) => { finished.push({ state, error }); },
  };
}

async function execute(publicationGate: RolloutAlertPublicationGate) {
  const registry = new JobRegistry();
  const sent = vi.fn().mockResolvedValue({ success: true });
  const finished: Array<{ state: string; error?: string }> = [];
  registerNotificationHandlers(registry, {
    getAlertById: async () => alert as any,
    getChannelById: async () => channel,
  }, {
    send: sent,
    buildMessage: () => ({ text: 'CPU high' }),
  }, {
    getReportById: async () => null,
  }, deliveryGate(finished), publicationGate);
  await registry.execute({
    id: 'delivery-1',
    type: 'notification.deliver',
    payload: { alertId: alert.id, channelId: channel.id },
    attempts: 1,
    maxAttempts: 5,
    fencingToken: 1,
  });
  return { sent, finished };
}

describe('Metrics V2 alert notification publication fence', () => {
  it('skips a queued alert after its source generation becomes stale', async () => {
    const run = vi.fn(async (_alertId: number, actual: typeof fence, _publish: () => Promise<void>) => {
      expect(actual).toEqual(fence);
      return 'stale' as const;
    });

    const result = await execute({ run });

    expect(run).toHaveBeenCalledOnce();
    expect(result.sent).not.toHaveBeenCalled();
    expect(result.finished).toEqual([{ state: 'skipped', error: 'ROLLOUT_ALERT_STALE' }]);
  });

  it('holds a matching fence through the external publication', async () => {
    const run = vi.fn(async (_alertId: number, _actual: typeof fence, publish: () => Promise<void>) => {
      await publish();
      return 'published' as const;
    });

    const result = await execute({ run });

    expect(result.sent).toHaveBeenCalledOnce();
    expect(result.finished).toEqual([{ state: 'sent', error: undefined }]);
  });

  it('rejects a Metrics V2 alert without a complete immutable fence', () => {
    expect(() => parseRolloutAlertFence({ source: 'metrics-v2-rollout', tags: { rollout_fence: { ...fence, revision: 0 } } }))
      .toThrow('ROLLOUT_ALERT_FENCE_INVALID');
  });

  it('does not add a rollout fence to legacy alerts', () => {
    expect(parseRolloutAlertFence({ source: 'legacy', tags: null })).toBeUndefined();
  });
});
