import { expect, test } from '@playwright/test';

test('Q08 offers keyboard recovery after the first instance read fails and keeps the SQL draft', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const draft = '-- 保留草稿\nSELECT  42';
  await page.addInitScript(sql => localStorage.setItem('sql-console-tabs', JSON.stringify({
    tabs: [{ id: 'query', name: '查询', sql }], activeId: 'query', instanceId: 2,
  })), draft);
  const allowRetry = Promise.withResolvers<void>();
  const requests: string[] = [];
  let listReads = 0;
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (!path.startsWith('/api/')) return route.fallback();
    requests.push(path);
    if (path !== '/api/database/instances') return route.fulfill({ json: [] });
    if (++listReads === 1) return route.fulfill({ status: 503, json: { error: 'INSTANCE_ENUMERATION_UNAVAILABLE' } });
    await allowRetry.promise;
    return route.fulfill({ json: [{ id: 2, name: '已授权实例', db_type: 'mysql', host: 'example.test', port: 3306 }] });
  });

  await page.goto('/e2e/fixtures/sql-console.html');
  const workbench = page.locator('sql-console-page');
  const draftText = async () => workbench.evaluate(element => (element as any).getSQL());
  const selector = workbench.getByRole('combobox', { name: '数据库实例' });
  const execute = workbench.locator('.btn-execute');
  const retry = workbench.getByRole('button', { name: '重试读取数据库实例' });
  try {
    await expect(workbench.getByRole('alert')).toContainText('数据库实例读取失败');
    await expect.poll(draftText).toBe(draft);
    await expect(selector).toBeDisabled();
    await expect(execute).toBeDisabled();
    await workbench.locator('.cm-content').press('Control+Enter');
    expect(requests).toEqual(['/api/database/instances']);

    await workbench.getByRole('button', { name: '格式化' }).focus();
    await page.keyboard.press('Tab');
    await expect(retry).toBeFocused();
    await page.keyboard.press('Enter');
    await expect.poll(() => listReads).toBe(2);
    await expect(workbench.getByRole('status')).toContainText('正在读取数据库实例');
    await expect(execute).toBeDisabled();
    await expect.poll(draftText).toBe(draft);
    await page.keyboard.press('Enter');
    expect(listReads).toBe(2);
  } finally {
    allowRetry.resolve();
  }
  await expect(selector).toHaveValue('2');
  await expect(selector).toBeFocused();
  await expect(execute).toBeEnabled();
  await expect(retry).toHaveCount(0);
  await expect(workbench.getByRole('alert')).toHaveCount(0);
  await expect.poll(draftText).toBe(draft);
  await expect.poll(() => [...requests].sort()).toEqual([
    '/api/database/instances',
    '/api/database/instances',
    '/api/database/instances/2/databases',
    '/api/database/instances/2/schema-objects',
  ]);
});

for (const { state, response, role, text } of [
  { state: 'denied', response: { status: 403, json: { error: 'FORBIDDEN' } }, role: 'alert', text: '没有权限读取数据库实例' },
  { state: 'empty', response: { json: [] }, role: 'status', text: '当前没有可访问的数据库实例' },
  { state: 'invalid', response: { json: [{ id: 2, name: '不完整的实例' }] }, role: 'alert', text: '数据库实例列表响应无效' },
] as const) {
  test(`Q08 distinguishes the ${state} instance list state and never uses the saved target`, async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('sql-console-tabs', JSON.stringify({
      tabs: [{ id: 'query', name: '查询', sql: 'SELECT 42' }], activeId: 'query', instanceId: 2,
    })));
    const requests: string[] = [];
    await page.route('**/api/**', route => {
      const path = new URL(route.request().url()).pathname;
      if (!path.startsWith('/api/')) return route.fallback();
      requests.push(path);
      return route.fulfill(path === '/api/database/instances' ? response : { json: [] });
    });
    await page.goto('/e2e/fixtures/sql-console.html');
    const workbench = page.locator('sql-console-page');
    await expect(workbench.getByRole(role)).toContainText(text);
    await expect(workbench.getByRole('combobox', { name: '数据库实例' })).toBeDisabled();
    await expect(workbench.locator('.btn-execute')).toBeDisabled();
    await expect(workbench.locator('.btn-explain')).toBeDisabled();
    const editor = workbench.locator('.cm-content');
    await expect(editor).toHaveText('SELECT 42');
    await editor.press('Control+Enter');
    expect(requests).toEqual(['/api/database/instances']);
  });
}

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

test('SQL toolbar exposes busy state and prevents repeated execution or analysis', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('sql-console-tabs', JSON.stringify({
    tabs: [{ id: 'query', name: '查询', sql: 'SELECT 1' }], activeId: 'query', instanceId: 1,
  })));
  await page.route('**/api/database/instances**', route => route.fulfill({
    json: new URL(route.request().url()).pathname === '/api/database/instances'
      ? [{ id: 1, name: '隔离样本', db_type: 'mysql' }]
      : [],
  }));
  await page.goto('/e2e/fixtures/sql-console.html');
  const workbench = page.locator('sql-console-page');
  await expect(workbench.locator('.cm-content')).toHaveText('SELECT 1');

  for (const { endpoint, name, busyName } of [
    { endpoint: 'execute', name: /^执行 /, busyName: /^执行中/ },
    { endpoint: 'explain', name: '分析计划', busyName: '分析中...' },
  ]) {
    const response = Promise.withResolvers<void>();
    let requests = 0;
    const requestPattern = new RegExp(`/api/database/instances/1/${endpoint}(?:\\?|$)`);
    await page.route(requestPattern, async route => {
      requests++;
      await response.promise;
      await route.fulfill({ status: 400, json: { error: '受控请求结束' } });
    });
    const idle = workbench.getByRole('button', { name });
    await expect(idle).toHaveAttribute('aria-busy', 'false');
    try {
      await idle.click();
      const busy = workbench.getByRole('button', { name: busyName });
      await expect(busy).toBeDisabled();
      await expect(busy).toHaveAttribute('aria-busy', 'true');
      await busy.evaluate(button => button.dispatchEvent(new MouseEvent('click', { bubbles: true })));
      await expect.poll(() => requests).toBe(1);
    } finally {
      response.resolve();
    }
    await expect(idle).toBeEnabled();
    await expect(idle).toHaveAttribute('aria-busy', 'false');
    expect(requests).toBe(1);
  }
});

test('execution plans show the current instance and SQL and do not survive a failed read', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('sql-console-tabs', JSON.stringify({
    tabs: [{ id: 'query', name: '查询', sql: 'SELECT 1' }], activeId: 'query', instanceId: 1,
  })));
  await page.route('**/api/database/instances**', route => route.fulfill({
    json: new URL(route.request().url()).pathname === '/api/database/instances'
      ? [{ id: 1, name: '一号库', db_type: 'mysql' }, { id: 2, name: '二号库', db_type: 'mysql' }]
      : [],
  }));
  const oldRead = Promise.withResolvers<void>();
  const oldReply = Promise.withResolvers<void>();
  await page.route('**/api/database/instances/*/explain?*', async route => {
    const url = new URL(route.request().url());
    const sql = url.searchParams.get('sql');
    if (url.pathname.includes('/1/')) {
      oldRead.resolve();
      await oldReply.promise;
      return route.fulfill({ json: { plan: { query_block: { table: { table_name: 'old_table' } } }, db_type: 'mysql' } });
    }
    if (sql === 'SELECT 2') {
      return route.fulfill({ json: { plan: { query_block: { select_id: 1, ordering_operation: {
        using_filesort: true, table: { table_name: 'current_table', access_type: 'ref', key: 'ordered_idx' },
      } } }, db_type: 'mysql' } });
    }
    if (sql === 'SELECT 3') return route.fulfill({ status: 504, body: '', contentType: 'text/plain' });
    return route.fulfill({ status: 200, body: '', contentType: 'application/json' });
  });
  await page.goto('/e2e/fixtures/sql-console.html');
  const workbench = page.locator('sql-console-page');
  const editor = workbench.locator('.cm-content');
  const analyze = workbench.locator('.btn-explain');
  const tree = workbench.locator('.plan-tree');
  const table = workbench.locator('.plan-table');
  await expect(editor).toHaveText('SELECT 1');
  try {
    await analyze.click();
    await oldRead.promise;
    await workbench.locator('.toolbar select').first().selectOption('2');
    await editor.fill('SELECT 2');
    await expect(analyze).toBeEnabled();
    await analyze.click();
    await expect(tree).toContainText('current_table');
    await workbench.getByRole('button', { name: '表格', exact: true }).click();
    await expect(table).toContainText('current_table');
    await expect(table).toContainText('ordered_idx');
  } finally {
    oldReply.resolve();
  }
  await expect(table).not.toContainText('old_table');
  await editor.fill('SELECT 3');
  await expect(table).toHaveCount(0);
  await analyze.click();
  await expect(workbench.getByRole('alert')).toContainText('读取执行计划超时');
  await editor.fill('SELECT 4');
  await expect(workbench.getByRole('alert')).toHaveCount(0);
  await analyze.click();
  await expect(workbench.getByRole('alert')).toContainText('响应无效');
  await expect(tree).toHaveCount(0);
  await expect(table).toHaveCount(0);
});

test('SQL results can show all rows and switch back to numbered pages', async ({ page }) => {
  const rows = Array.from({ length: 61 }, (_, index) => ({ id: 61 - index }));
  let resultRows = rows;
  await page.addInitScript(() => localStorage.setItem('sql-console-tabs', JSON.stringify({
    tabs: [{ id: 'query', name: '查询', sql: 'SELECT 1' }], activeId: 'query', instanceId: 1,
  })));
  await page.route('**/api/database/instances**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/database/instances/1/execute') {
      return route.fulfill({ json: { success: true, columns: ['id'], rows: resultRows, rowCount: resultRows.length } });
    }
    return route.fulfill({ json: path === '/api/database/instances' ? [{ id: 1, name: '隔离样本', db_type: 'mysql' }] : [] });
  });

  await page.goto('/e2e/fixtures/sql-console.html');
  const workbench = page.locator('sql-console-page');
  const execute = workbench.locator('.btn-execute');
  const size = workbench.locator('.page-size-select');
  const info = workbench.locator('.page-info');
  const cells = workbench.locator('.results-scroll tbody td');
  const next = workbench.getByRole('button', { name: '下一页' });

  await execute.click();
  await expect(info).toHaveText('1–50 / 61 行');
  await next.click();
  await expect(info).toHaveText('51–61 / 61 行');
  await size.selectOption('all');
  await expect(info).toHaveText('1–61 / 61 行');
  await expect(cells).toHaveCount(61);
  await expect(next).toHaveCount(0);
  await expect(size).toHaveValue('all');

  await workbench.getByRole('columnheader', { name: 'id' }).click();
  await expect(cells.first()).toHaveText('1');
  await expect(cells.last()).toHaveText('61');
  await size.selectOption('25');
  await expect(info).toHaveText('1–25 / 61 行');
  await expect(cells).toHaveCount(25);
  await expect(cells.first()).toHaveText('1');
  await size.selectOption('100');
  await expect(info).toHaveText('1–61 / 61 行');
  await expect(next).toBeDisabled();

  await size.selectOption('all');
  resultRows = [];
  await execute.click();
  await expect(info).toHaveText('0–0 / 0 行');
  await expect(cells).toHaveCount(0);
  await expect(size).toHaveValue('all');
  await size.selectOption('50');
  await expect(info).toHaveText('0–0 / 0 行');
  await expect(next).toBeDisabled();
});

test('Q03 sorts SQL result columns by keyboard and exposes the active direction', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => localStorage.setItem('sql-console-tabs', JSON.stringify({
    tabs: [{ id: 'query', name: '查询', sql: 'SELECT 1' }], activeId: 'query', instanceId: 1,
  })));
  let executions = 0;
  await page.route('**/api/database/instances**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/database/instances/1/execute') {
      executions++;
      return route.fulfill({ json: {
        success: true, columns: ['id', 'name'], rowCount: 3,
        rows: [{ id: 2, name: 'C' }, { id: 3, name: 'A' }, { id: 1, name: 'B' }],
      } });
    }
    return route.fulfill({ json: path === '/api/database/instances'
      ? [{ id: 1, name: '隔离样本', db_type: 'mysql', host: 'example.test', port: 3306 }] : [] });
  });

  await page.goto('/e2e/fixtures/sql-console.html');
  const workbench = page.locator('sql-console-page');
  await workbench.locator('.btn-execute').click();
  const rows = workbench.locator('.results-scroll tbody td:first-child');
  const id = workbench.getByRole('columnheader', { name: 'id' });
  const name = workbench.getByRole('columnheader', { name: 'name' });
  const idSort = id.getByRole('button', { name: 'id' });
  const nameSort = name.getByRole('button', { name: 'name' });
  const sortedHeaders = workbench.locator('th[aria-sort]');
  await expect(rows).toHaveText(['2', '3', '1']);
  await expect(sortedHeaders).toHaveCount(0);
  await workbench.locator('.page-size-select').focus();
  await page.keyboard.press('Tab');
  await expect(idSort).toBeFocused();
  expect(await idSort.evaluate(button => button.matches(':focus-visible'))).toBe(true);

  await page.keyboard.press('Enter');
  await expect(id).toHaveAttribute('aria-sort', 'ascending');
  await expect(rows).toHaveText(['1', '2', '3']);
  await page.keyboard.press('Space');
  await expect(id).toHaveAttribute('aria-sort', 'descending');
  await expect(rows).toHaveText(['3', '2', '1']);
  await page.keyboard.press('Enter');
  await expect(sortedHeaders).toHaveCount(0);
  await expect(rows).toHaveText(['2', '3', '1']);

  await page.keyboard.press('Enter');
  await page.keyboard.press('Tab');
  await expect(nameSort).toBeFocused();
  await page.keyboard.press('Space');
  await expect(name).toHaveAttribute('aria-sort', 'ascending');
  await expect(sortedHeaders).toHaveCount(1);
  await expect(rows).toHaveText(['3', '1', '2']);
  expect(executions).toBe(1);
});
