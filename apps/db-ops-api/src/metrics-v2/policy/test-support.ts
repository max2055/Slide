import type { Capability, Resource } from '../../contracts/metrics-v2/index.js';
import { builtinReleases } from '../packages/builtins.js';
import { type Audit, type Group, type Published, type Ref, type Binding, refKey } from './model.js';
import type { PolicyStore, PolicyTransaction } from './store.js';

export const at = '2026-09-18T00:00:00.000Z';
export const pin = (() => { const { id, version, digest } = builtinReleases()[0].package; return { id, version, digest }; })();
export const admin = { userId: 1, username: 'fixture', roles: [], permissions: ['*'], instanceScopes: {}, sessionVersion: 1, requestId: 'test-policy' };
export const resource = (id = 1): Resource => ({ type: 'instance', id: String(id), attributes: {
  'db.engine': { value: 'mysql', observed_at: at, source: 'fixture' }, 'db.version': { value: '8.0.46', observed_at: at, source: 'fixture' },
} });
export const binding = (id = 1): Binding => ({ resource: { type: 'instance', id }, package: pin, group_id: null, overrides: {}, revision: 1 });
export const capabilities = (id = 1): Capability[] => builtinReleases()[0].package.collectors.flatMap(c => c.mappings.map(m => ({
  resource_id: String(id), metric: m.metric, method: c.method, status: 'supported' as const,
  basis: [{ kind: 'permission' as const, evidence: 'fixed_read_succeeded' }], evaluated_at: at, valid_until: '2026-09-19T00:00:00.000Z',
})));

/** Transactional test adapter; production persistence is separately exercised against MySQL. */
export class MemoryPolicyStore implements PolicyStore {
  groups = new Map<string, Group>();
  bindings = new Map<string, Published>();
  caps = new Map<string, Capability[]>();
  logs: Audit[] = [];
  failAudit = false;
  private tail: Promise<unknown> = Promise.resolve();
  async transaction<T>(fn: (tx: PolicyTransaction) => Promise<T>): Promise<T> {
    const execute = async () => {
      const groups = structuredClone(this.groups), bindings = structuredClone(this.bindings), logs = structuredClone(this.logs), caps = structuredClone(this.caps);
      const tx: PolicyTransaction = {
        group: async id => structuredClone(groups.get(id) ?? null),
        members: async id => structuredClone([...bindings.values()].filter(v => v.binding.group_id === id)),
        binding: async ref => structuredClone(bindings.get(refKey(ref)) ?? null),
        capabilities: async ref => structuredClone(caps.get(refKey(ref)) ?? []),
        saveCapabilities: async (ref, values) => { caps.set(refKey(ref), structuredClone(values)); },
        saveGroup: async group => { groups.set(group.id, structuredClone(group)); },
        saveBinding: async (value, reset) => { bindings.set(refKey(value.binding.resource), structuredClone(value)); if (reset) caps.delete(refKey(value.binding.resource)); },
        audit: async value => { if (this.failAudit) throw new Error('audit failed with secret'); logs.push(value); },
        audits: async target => logs.filter(a => a.target === target),
      };
      const result = await fn(tx);
      this.groups = groups; this.bindings = bindings; this.logs = logs; this.caps = caps;
      return result;
    };
    const result = this.tail.then(execute); this.tail = result.catch(() => undefined); return result;
  }
}
export const testResources = { exists: async (ref: Ref) => ref.id !== 404,
  inventory: async (ref: Ref): Promise<Resource> => ref.type === 'instance' ? resource(ref.id) : { type: ref.type, id: String(ref.id), attributes: {} } };
