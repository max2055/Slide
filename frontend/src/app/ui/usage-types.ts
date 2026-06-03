export type UsageEntry = Record<string, unknown>;
export type SessionUsageTimeSeries = unknown;
export type SessionUsageTimePoint = { ts: number; tokens: number; cost?: number };
export type SessionsUsageTotals = { tokens: number; cost: number; runs: number };
export type SessionsUsageResult = { totals: SessionsUsageTotals; entries: SessionsUsageEntry[] };
export type SessionsUsageEntry = Record<string, unknown>;
export type CostUsageSummary = { totalCost: number; currency?: string };
export type CostUsageDailyEntry = { date: string; cost: number };
