import { expect, test } from '@playwright/test';

// Real production Lit and CodeMirror, controlled instance/schema API; no SQL execution.
for (const [width, height] of [[1440, 900], [1366, 768], [1920, 1080]]) {
  test(`#440/#441/#683 editor lifecycle and dialect ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.route('**/api/**', async route => {
      const path = new URL(route.request().url()).pathname;
      if (!path.startsWith('/api/')) return route.fallback();
      if (path === '/api/database/instances') {
        await new Promise(resolve => setTimeout(resolve, 150));
        return route.fulfill({ json: ['mysql', 'oracle', 'dameng'].map((db_type, i) => ({ id: i + 1, name: db_type, db_type })) });
      }
      return route.fulfill({ json: [] });
    });
    await page.addInitScript(() => localStorage.setItem('sql-console-tabs', JSON.stringify({
      tabs: [{ id: 'one', name: 'one', sql: 'SELECT 1' }, { id: 'two', name: 'two', sql: 'SELECT 2' }],
      activeId: 'one', instanceId: 2,
    })));
    await page.goto('/e2e/fixtures/sql-console.html');
    await expect(page.locator('.cm-editor')).toBeVisible();
    await page.waitForFunction(() => (document.querySelector('sql-console-page') as any).instances.length === 3);
    const result = await page.evaluate(async () => {
      const el = document.querySelector('sql-console-page') as any;
      const first = el.tabs[0].editorView;
      const correctDialect = () => el.tabs.every((t: any) => !t.editorView || el._dialect.get(t.editorView.state).language === el._sqlLanguage().language);
      if (!correctDialect()) throw new Error('async restoration dialect');
      el._switchTab('two');
      const second = el.tabs[1].editorView;
      el._switchTab('one');
      if (el.tabs[0].editorView !== first) throw new Error('tab recreated');
      first.dispatch({ changes: { from: 0, to: first.state.doc.length, insert: 'SELECT 99' } });
      for (const id of [3, 1, 2]) {
        await el._selectInstance(id);
        if (!correctDialect() || first.state.doc.toString() !== 'SELECT 99') throw new Error('dialect/content');
      }
      const { CompletionContext } = await import('/node_modules/@codemirror/autocomplete/dist/index.js');
      const { EditorState } = await import('/node_modules/@codemirror/state/dist/index.js');
      el.schemas = [{ schema: 'app', tables: Array.from({ length: 1000 }, (_, i) => ({ name: 't' + i, alias: i === 0 ? 'a' : '', columns: [{ name: '编号' }] })) }];
      const state = EditorState.create({ doc: 'select a.' });
      const options = el._sqlCompletions(new CompletionContext(state, state.doc.length, true)).options;
      if (options.filter((o: any) => o.type === 'property').length !== 1) throw new Error('duplicate columns');
      let firstDestroyed = 0, secondDestroyed = 0;
      const d1 = first.destroy.bind(first), d2 = second.destroy.bind(second);
      first.destroy = () => { firstDestroyed++; d1(); };
      second.destroy = () => { secondDestroyed++; d2(); };
      el._closeTab('two', true);
      el.remove();
      el.disconnectedCallback();
      if (el.tabs.some((t: any) => t.editorView)) throw new Error('retained editor');
      document.body.append(el);
      await el.updateComplete;
      await new Promise(resolve => requestAnimationFrame(resolve));
      if (el.tabs[0].editorView.state.doc.toString() !== 'SELECT 99') throw new Error('reentry lost SQL');
      el.remove();
      return { firstDestroyed, secondDestroyed };
    });
    expect(result).toEqual({ firstDestroyed: 1, secondDestroyed: 1 });
  });
}
