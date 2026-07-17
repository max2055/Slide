export type DatabaseType = 'mysql' | 'postgresql' | 'oracle' | 'dameng' | 'mongodb' | 'redis' | 'elasticsearch';
export type CapabilityState = 'declared' | 'configured' | 'verified' | 'degraded' | 'unsupported';
export type AdapterCapability = 'connect' | 'query' | 'explain' | 'metrics' | 'health' | 'alerts' | 'reports' | 'writeApproval';
export interface AdapterCapabilityRow { dbType: DatabaseType; driver: string | null; state: CapabilityState; creatable: boolean; capabilities: Partial<Record<AdapterCapability, CapabilityState>>; reason?: string; }

const implemented: AdapterCapabilityRow[] = [
  ['mysql', 'mysql2'], ['postgresql', 'pg'], ['oracle', 'oracledb'], ['dameng', 'dmdb'],
].map(([dbType, driver]) => ({ dbType: dbType as DatabaseType, driver, state: 'declared' as const, creatable: true, capabilities: { connect: 'declared', query: 'declared', explain: 'declared', metrics: 'declared', health: 'declared', alerts: 'declared', reports: 'declared', writeApproval: 'declared' } }));
const unsupported: AdapterCapabilityRow[] = ['mongodb', 'redis', 'elasticsearch'].map((dbType) => ({ dbType: dbType as DatabaseType, driver: null, state: 'unsupported', creatable: false, capabilities: { connect: 'unsupported', query: 'unsupported', explain: 'unsupported', metrics: 'unsupported', health: 'unsupported', alerts: 'unsupported', reports: 'unsupported', writeApproval: 'unsupported' }, reason: 'No complete adapter, collector, approval path, and integration evidence are available.' }));
const rows = [...implemented, ...unsupported];

export function getAdapterCapability(dbType: string): AdapterCapabilityRow | null { return rows.find((row) => row.dbType === dbType) ?? null; }
export function listAdapterCapabilities(): readonly AdapterCapabilityRow[] { return rows; }
export function assertCreatableDatabaseType(dbType: string): asserts dbType is DatabaseType {
  const row = getAdapterCapability(dbType);
  if (!row || !row.creatable) throw new Error(`DATABASE_TYPE_UNSUPPORTED:${dbType}`);
}
