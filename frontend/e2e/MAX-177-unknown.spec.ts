import { test, expect } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const output = '/Users/max/Coding/40-Slide/outputs/MAX-177/F1';
const receipt = { success: false, executionState: 'unknown', retryable: false,
  error: 'SQL_OUTCOME_REQUIRES_RECONCILIATION: SQL may have committed; do not retry; inspect durable intent and target database' };

for (const encoding of ['object', 'json-string']) {
  test(`formal unknown ${encoding}: list, independent filter, complete evidence and no retry`, async ({ page }) => {
    const source = { id: 177, kind: 'sql', instance_id: 7, sql_text: 'UPDATE fixture_only SET value=1 /* controlled receipt; never executed */',
      risk_level: 'high', status: 'executing', execution_result: encoding === 'object' ? receipt : JSON.stringify(receipt),
      created_at: '2026-10-15T09:00:00Z' };
    const items = [source,
      { ...source, id: 178, sql_text: 'SELECT definite_failure', status: 'execution_failed', execution_result: { success: false, error: 'definite failure' } },
      { ...source, id: 179, sql_text: 'SELECT not_executed', status: 'approved', execution_result: null },
      { ...source, id: 180, sql_text: 'SELECT success', status: 'executed', execution_result: { success: true } },
      { ...source, id: 181, sql_text: 'SELECT conflicting_evidence', status: 'rejected', execution_result: { success: true } }];
    const writes: string[] = [];
    await page.route('http://127.0.0.1:51977/api/**', route => {
      const request = route.request();
      if (request.method() !== 'GET') { writes.push(request.url()); return route.abort(); }
      const path = new URL(request.url()).pathname;
      return route.fulfill({ json: path.endsWith('/unified') ? { items }
        : path.endsWith('/events') ? [{ event_type: 'reconciliation_required', event_data: receipt }]
          : path === '/api/approval/177' ? source : {} });
    });
    await page.route('**/MAX-177-F1-harness', route => route.fulfill({ contentType: 'text/html', body:
      '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/src/app/styles/tokens.css"><style>body{margin:0;background:var(--bg);font:14px system-ui}</style><body><script type="module">import "/src/app/ui/views/approval-dashboard.ts";document.body.append(document.createElement("approval-dashboard"));</script></body></html>' }));
    await page.goto('/MAX-177-F1-harness');
    const view = page.locator('approval-dashboard');
    await view.getByRole('button', { name: '审批历史', exact: true }).click();
    await expect(view.locator('tbody tr')).toHaveCount(5);
    const execution = view.getByRole('combobox', { name: '执行结果', exact: true });
    for (const [filter, text] of [['failed', 'definite_failure'], ['none', 'not_executed'], ['success', 'SELECT success'], ['conflict', 'conflicting_evidence']]) {
      await execution.selectOption(filter);
      await expect(view.locator('tbody tr')).toHaveCount(1);
      await expect(view.locator('tbody')).toContainText(text);
    }
    await view.getByRole('combobox', { name: '审批结果', exact: true }).selectOption('approved');
    await execution.selectOption('unknown');
    await expect(view.locator('tbody tr')).toHaveCount(1);
    await expect(view.locator('tbody')).toContainText('结果未知');
    await expect(view.locator('tbody')).not.toContainText('执行失败');
    await mkdir(output, { recursive: true });
    const metadata = { commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      sourceSha256: createHash('sha256').update(await readFile('src/app/ui/views/approval-dashboard.ts')).digest('hex'),
      source: 'Controlled HTTP receipts matching backend contract; no backend, database, target SQL or model call.', encoding };
    for (const width of [1440, 768, 390]) for (const theme of ['light', 'dark']) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(theme => { document.documentElement.dataset.themeMode = theme; }, theme);
      const name = `${encoding}-${width}-${theme}`;
      await page.screenshot({ path: `${output}/${name}-list.png`, fullPage: true });
      const trigger = view.getByRole('button', { name: /^查看证据/ });
      await trigger.click();
      const dialog = view.locator('app-dialog');
      await expect(dialog.locator('.evidence-meta')).toContainText('结果未知');
      await expect(dialog).toContainText('SQL 可能已提交');
      await expect(dialog).toContainText('请勿重试');
      await expect(dialog).toContainText('对账');
      await expect(dialog).toContainText(receipt.error);
      await expect(dialog).toContainText('"retryable":' + (encoding === 'object' ? ' false' : 'false'));
      await expect(dialog).not.toContainText('执行失败');
      await expect(dialog.getByRole('button', { name: /重试/ })).toHaveCount(0);
      const box = await dialog.locator('.dialog').boundingBox();
      expect(box!.width).toBeLessThan(width);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: `${output}/${name}-detail.png`, fullPage: true });
      await writeFile(`${output}/${name}.json`, JSON.stringify({ ...metadata, viewport: page.viewportSize(), theme, at: new Date().toISOString() }, null, 2));
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0); await expect(trigger).toBeFocused();
    }
    expect(writes).toEqual([]);
  });
}
