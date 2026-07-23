import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../sql-console.js';
import type { SqlConsolePage } from '../sql-console.js';

// The component intentionally keeps these members private. This adapter is
// limited to runtime behavior tests and avoids widening production visibility.
type ConsoleUnderTest = any;

function page(): ConsoleUnderTest {
  const ConsolePage = customElements.get('sql-console-page') as typeof SqlConsolePage;
  return new ConsolePage() as ConsoleUnderTest;
}

function completionContext(text: string): any {
  return {
    pos: text.length,
    matchBefore: () => ({ from: Math.max(0, text.length - 2) }),
    state: { sliceDoc: () => text },
  };
}

describe('SQL Console', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.stubGlobal('Blob', class {
      content: string;
      constructor(parts: unknown[]) { this.content = parts.join(''); }
      text() { return Promise.resolve(this.content); }
    });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  });

  it('custom element is registered', () => {
    expect(customElements.get('sql-console-page')).toBeDefined();
  });

  describe('SQLC-01: Schema-driven autocomplete', () => {
    it('provides table names and columns for a matching alias', () => {
      const subject = page();
      subject.schemas = [{ schema: 'app', tables: [{ name: 'orders', columns: [{ name: 'id', type: 'bigint', nullable: false }] }] }];
      const result = subject._sqlCompletions(completionContext('select orders.'));
      expect(result.options.map((option: any) => option.label)).toEqual(expect.arrayContaining(['orders', 'id']));
    });

    it('falls back to SQL keywords without schema objects', () => {
      const result = page()._sqlCompletions(completionContext('sel'));
      expect(result.options.map((option: any) => option.label)).toContain('SELECT');
    });
  });

  describe('SQLC-02: Sortable result table', () => {
    it('cycles ascending, descending, then unsorted for the same column', () => {
      const subject = page();
      subject._toggleSort('id');
      expect([subject.sortColumn, subject.sortDirection]).toEqual(['id', 'asc']);
      subject._toggleSort('id');
      expect([subject.sortColumn, subject.sortDirection]).toEqual(['id', 'desc']);
      subject._toggleSort('id');
      expect([subject.sortColumn, subject.sortDirection]).toEqual([null, null]);
    });

    it('keeps null values after non-null values for either sort direction', () => {
      const subject = page();
      subject.sortColumn = 'value';
      subject.sortDirection = 'asc';
      expect(subject._sortRows([{ value: null }, { value: 2 }, { value: 1 }]).map((row: any) => row.value)).toEqual([1, 2, null]);
      subject.sortDirection = 'desc';
      expect(subject._sortRows([{ value: null }, { value: 2 }, { value: 1 }]).map((row: any) => row.value)).toEqual([2, 1, null]);
    });
  });

  describe('SQLC-03: Client-side pagination', () => {
    it('resets to the first page when the page size changes', () => {
      const subject = page();
      subject.currentPage = 3;
      subject._changePageSize(25);
      expect([subject.pageSize, subject.currentPage]).toEqual([25, 1]);
    });

    it('supports the all-rows page size state', () => {
      const subject = page();
      subject._changePageSize('all');
      expect([subject.pageSize, subject.currentPage]).toEqual(['all', 1]);
    });
  });

  describe('SQLC-04: CSV export', () => {
    it('exports columns as the first CSV row', async () => {
      const subject = page();
      subject.tabs = [{ id: 'one', name: 'one', sql: '', editorView: null, result: { columns: ['id'], rows: [{ id: 1 }] } }];
      subject.activeTabId = 'one';
      let blob: any;
      vi.stubGlobal('URL', { createObjectURL: (value: any) => { blob = value; return 'blob:test'; }, revokeObjectURL: vi.fn() });
      subject._exportCSV();
      expect(await blob!.text()).toContain('id\r\n1');
    });

    it('escapes delimiters, quotes, and newlines per RFC 4180', async () => {
      const subject = page();
      subject.tabs = [{ id: 'one', name: 'one', sql: '', editorView: null, result: { columns: ['note'], rows: [{ note: 'a,"b"\nc' }] } }];
      subject.activeTabId = 'one';
      let blob: any;
      vi.stubGlobal('URL', { createObjectURL: (value: any) => { blob = value; return 'blob:test'; }, revokeObjectURL: vi.fn() });
      subject._exportCSV();
      expect(await blob!.text()).toContain('"a,""b""\nc"');
    });

    it('writes null cells as empty strings', async () => {
      const subject = page();
      subject.tabs = [{ id: 'one', name: 'one', sql: '', editorView: null, result: { columns: ['value'], rows: [{ value: null }] } }];
      subject.activeTabId = 'one';
      let blob: any;
      vi.stubGlobal('URL', { createObjectURL: (value: any) => { blob = value; return 'blob:test'; }, revokeObjectURL: vi.fn() });
      subject._exportCSV();
      expect(await blob!.text()).toContain('value\r\n');
    });
  });

  describe('SQLC-05: Multi-tab editor', () => {
    it('creates tabs with SQL-derived names', () => {
      const subject = page();
      (subject as any).renderRoot = { querySelector: () => null };
      subject._createTab('select * from users');
      expect(subject.tabs).toHaveLength(1);
      expect(subject.tabs[0].name).toBe('select * from users');
    });

    it('persists restorable tab metadata in localStorage', () => {
      const subject = page();
      subject.tabs = [{ id: 'one', name: 'One', sql: 'select 1', editorView: null, result: null }];
      subject.activeTabId = 'one';
      subject.selectedId = 7;
      subject._saveTabs();
      expect(JSON.parse(localStorage.getItem('sql-console-tabs')!)).toMatchObject({ activeId: 'one', instanceId: 7, tabs: [{ sql: 'select 1' }] });
    });

    it('requires confirmation before closing a non-empty editor tab', () => {
      const subject = page();
      subject.tabs = [{ id: 'one', name: 'One', sql: '', editorView: { state: { doc: { toString: () => 'select 1' } } }, result: null }];
      subject.activeTabId = 'one';
      subject._closeTab('one');
      expect(subject._showTabConfirm).toBe('one');
      expect(subject.tabs).toHaveLength(1);
    });
  });

  describe('SQLC-06: Query history', () => {
    it('requests history with the active search and pagination cursor', async () => {
      const subject = page();
      subject.historySearch = 'orders';
      subject.historyInstanceFilter = 7;
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ items: [{ id: 1 }], total: 1 }) });
      vi.stubGlobal('fetch', fetchMock);
      await subject._loadHistory(true);
      expect(fetchMock.mock.calls[0][0]).toContain('/api/database/instances/7/query-history?');
      expect(fetchMock.mock.calls[0][0]).toContain('search=orders');
      expect(subject.historyItems).toEqual([{ id: 1 }]);
    });

    it('appends the next history batch rather than replacing loaded entries', async () => {
      const subject = page();
      subject.historyItems = [{ id: 1 }];
      subject.historyOffset = 1;
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ items: [{ id: 2 }], total: 2 }) });
      vi.stubGlobal('fetch', fetchMock);
      await subject._loadHistory(false);
      expect(subject.historyItems).toEqual([{ id: 1 }, { id: 2 }]);
    });

    it('loads another history batch only when scrolling near the bottom', () => {
      const subject = page();
      const load = vi.spyOn(subject, '_loadHistory');
      subject._onHistoryScroll({ target: { scrollHeight: 1000, scrollTop: 850, clientHeight: 100 } } as any);
      expect(load).toHaveBeenCalledWith(false);
    });
  });

  describe('SQLC-07: EXPLAIN visualization', () => {
    it('normalizes MySQL JSON plans into a canonical node', () => {
      const result = page()._explainNormalizer({ query_block: { table: { table_name: 'orders', access_type: 'ALL', rows_examined_per_scan: 10 } } }, 'mysql');
      expect(result).toMatchObject({ operation: 'ALL orders', rows: 10 });
    });

    it('renders expandable tree nodes for child plans', () => {
      const subject = page();
      const node = { operation: 'root', rows: 1, cost: 1, details: {}, children: [{ operation: 'child', rows: 1, cost: 1, details: {}, children: [] }] };
      expect(subject._renderPlanTree(node).strings.join('')).toContain('plan-node-row');
      subject._togglePlanNode(node);
      expect(subject._expandedNodes.has(node)).toBe(true);
    });

    it('flattens a plan for the table visualization', () => {
      const subject = page();
      const node = { operation: 'root', rows: 1, cost: 1, details: {}, children: [{ operation: 'child', rows: 2, cost: 3, details: {}, children: [] }] };
      expect(subject._flattenPlan(node).map((item: any) => item.operation)).toEqual(['root', 'child']);
    });
  });
});
