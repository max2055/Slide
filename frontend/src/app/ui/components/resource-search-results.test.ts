import { afterEach, expect, it, vi } from 'vitest';
const { authFetch } = vi.hoisted(() => ({ authFetch: vi.fn() }));
vi.mock('../../../api/index.js', () => ({ authFetch }));
import { ResourceMetricsTable } from './resource-metrics-table.js';
import { collectionStatus } from './metric-test-fixtures.js';
const response = (data: unknown) => ({ ok: true, status: 200, json: async () => data });
afterEach(() => { document.body.replaceChildren(); authFetch.mockReset(); sessionStorage.clear(); });

it('MAX-390 reports pre-pagination results, avoids update loops and handles metadata-only changes', async () => {
  authFetch.mockImplementation(async (url: string) => response(url.endsWith('/status') ? collectionStatus() : { profile: { columns: [] }, window: {}, metrics: [] }));
  const table = new ResourceMetricsTable();
  const counts: number[] = [];
  table.addEventListener('resource-results-changed', e => counts.push((e as CustomEvent<number>).detail));
  table.entries = Array.from({ length: 25 }, (_, i) => ({ id: i, searchValues: [i < 3 ? 'Alpha' : 'Beta'] }));
  document.body.append(table);
  await vi.waitFor(() => expect(counts.at(-1)).toBe(25));
  (table as any).page = 2; await table.updateComplete;
  expect(counts).toEqual([25]);
  table.search = 'aLPha'; await table.updateComplete;
  expect(counts.at(-1)).toBe(3);
  // Parent renders fresh arrays after receiving the event; this must settle.
  table.entries = table.entries.map(e => ({ ...e })); await table.updateComplete;
  expect(counts).toEqual([25, 3]);
  table.entries = table.entries.map(e => ({ ...e, searchValues: ['Beta'] })); await table.updateComplete;
  expect(counts.at(-1)).toBe(0);
  table.search = '   '; await table.updateComplete;
  expect(counts.at(-1)).toBe(25);
  table.entries = []; await table.updateComplete;
  expect(counts.at(-1)).toBe(0);
});

it('MAX-390 updates async state matches and drops stale metric replies after revocation and inventory removal', async () => {
  let release!: (value: unknown) => void;
  authFetch.mockImplementation(() => new Promise(resolve => { release = resolve; }));
  const table = new ResourceMetricsTable();
  const counts: number[] = [];
  table.addEventListener('resource-results-changed', e => counts.push((e as CustomEvent<number>).detail));
  table.search = '采集状态未知';
  table.entries = [{ id: 1, searchValues: ['Alpha'] }];
  document.body.append(table); await table.updateComplete;
  expect(counts.at(-1)).toBe(0);
  authFetch.mockResolvedValue(response(collectionStatus()));
  release(response({ profile: { columns: [] }, window: {}, metrics: [] }));
  await vi.waitFor(() => expect(counts.at(-1)).toBe(1));
  authFetch.mockImplementation(() => new Promise(resolve => { release = resolve; }));
  const loading = table.load(true);
  window.dispatchEvent(new Event('slide-permissions-loaded'));
  await table.updateComplete;
  expect(counts.at(-1)).toBe(0);
  release(response({ profile: { columns: [] }, window: {}, metrics: [] }));
  await loading; await table.updateComplete;
  expect(counts.at(-1)).toBe(0);
  table.search = '无查看权限'; await table.updateComplete;
  await vi.waitFor(() => expect(counts.at(-1)).toBe(1));
  table.entries = []; await table.updateComplete;
  expect(counts.at(-1)).toBe(0);
});
