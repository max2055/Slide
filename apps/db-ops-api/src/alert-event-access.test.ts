import { describe, it, expect, vi } from 'vitest';
const state = vi.hoisted(() => ({ type: 'server', id: 9 }));
vi.mock('./db-connection.js', () => ({
  dbConnection: {
    getPool: () => ({
      execute: async () => [[{ payload: { resource: { type: state.type, id: String(state.id) } } }]],
    }),
  },
}));
import { eventResourceAccess } from './alert-event-access.js';
describe('event resource authority from persisted episode', () => {
  for (const type of ['instance', 'server', 'network_device'])
    it(type + ' never treats NULL instance as public', async () => {
      state.type = type;
      const event = { id: 1, instance_id: null };
      const actor: any = {
        permissions: ['*'],
        instanceScopes: {},
        resourceBoundary: { instanceIds: [9], serverIds: [9], networkDeviceIds: [9] },
      };
      expect(await eventResourceAccess(actor, event)).toBe(true);
      expect(await eventResourceAccess(actor, event, true)).toBe(true);
      actor.resourceBoundary = { instanceIds: [], serverIds: [], networkDeviceIds: [] };
      expect(await eventResourceAccess(actor, event)).toBe(false);
      expect(await eventResourceAccess(actor, event, true)).toBe(false);
      delete actor.resourceBoundary;
      actor.permissions = [];
      expect(await eventResourceAccess(actor, event)).toBe(false);
    });
});
