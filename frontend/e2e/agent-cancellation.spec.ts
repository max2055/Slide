import { expect, test } from '@playwright/test';
import { dbConnection } from '../../apps/db-ops-api/src/db-connection';

test('Stop cancels the active Agent run and persists its terminal state', async ({ page }) => {
  test.skip(process.env.QUALIFICATION_CANCELLATION_E2E !== '1', 'requires the managed cancellable provider');
  test.setTimeout(60_000);

  await page.goto('/chat');
  await page.locator('.login-gate input[autocomplete="username"]').fill('admin');
  await page.locator('.login-gate input[autocomplete="current-password"]').fill('Tpam1234');
  await page.locator('.login-gate__connect').click();
  await expect(page.locator('.login-gate')).toBeHidden({ timeout: 15_000 });

  const input = page.getByRole('textbox', { name: /Message .*Enter to send/ });
  await expect(input).toBeEnabled();
  await input.fill('Keep working until I stop you');
  await page.getByRole('button', { name: 'Send message' }).click();
  const stop = page.getByRole('button', { name: 'Stop generating' });
  await expect(stop).toBeVisible({ timeout: 10_000 });
  expect(await dbConnection.initialize({
    host: '127.0.0.1', port: 3306, user: 'root', password: 'Tpam1234', database: 'db_ops_ai_qualification',
  })).toBe(true);
  try {
    const pool = dbConnection.getPool();
    expect(pool).not.toBeNull();
    let persistedRunId = '';
    await expect.poll(async () => {
      const [rows] = await pool!.query<Array<{ id: string }>>(
        `SELECT ar.id FROM agent_runs ar INNER JOIN users u ON u.id = ar.actor_id
         WHERE u.username = 'admin' ORDER BY ar.created_at DESC LIMIT 1`,
      );
      persistedRunId = rows[0]?.id ?? '';
      return persistedRunId;
    }).not.toBe('');
    expect(await page.evaluate(() => (document.querySelector('slide-app') as any)?.chatRunId)).toBe(persistedRunId);

    await stop.click();
    await expect(stop).toBeHidden({ timeout: 10_000 });
    await expect.poll(() => page.evaluate(() => {
      const app = document.querySelector('slide-app') as any;
      return app?.chatRunStatus?.phase ?? null;
    })).toBe('interrupted');

    await expect.poll(async () => {
      const [rows] = await pool!.query<Array<{ state: string; finished_at: Date | null }>>(
        `SELECT ar.state, ar.finished_at FROM agent_runs ar
         INNER JOIN users u ON u.id = ar.actor_id
         WHERE u.username = 'admin' ORDER BY ar.created_at DESC LIMIT 1`,
      );
      return rows[0] ? { state: rows[0].state, finished: Boolean(rows[0].finished_at) } : null;
    }).toEqual({ state: 'cancelled', finished: true });
  } finally {
    await dbConnection.close();
  }
});

test('unsupported attachments fail explicitly without creating an Agent run', async ({ page }) => {
  test.skip(process.env.QUALIFICATION_CANCELLATION_E2E !== '1', 'requires the managed qualification environment');
  await page.goto('/chat');
  await page.locator('.login-gate input[autocomplete="username"]').fill('admin');
  await page.locator('.login-gate input[autocomplete="current-password"]').fill('Tpam1234');
  await page.locator('.login-gate__connect').click();
  await expect(page.locator('.login-gate')).toBeHidden({ timeout: 15_000 });

  expect(await dbConnection.initialize({
    host: '127.0.0.1', port: 3306, user: 'root', password: 'Tpam1234', database: 'db_ops_ai_qualification',
  })).toBe(true);
  const pool = dbConnection.getPool()!;
  const [beforeRows] = await pool.query<Array<{ count: number }>>('SELECT COUNT(*) AS count FROM agent_runs');
  const beforeCount = Number(beforeRows[0]?.count);

  try {
    await page.locator('input[type="file"]').setInputFiles({
      name: 'pixel.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgo=', 'base64'),
    });
    const input = page.getByRole('textbox', { name: /Message .*Enter to send|Add a message or paste more images/ });
    await input.fill('Inspect this image');
    await page.getByRole('button', { name: 'Send message' }).click();
    await expect.poll(() => page.evaluate(() => (document.querySelector('slide-app') as any)?.lastError ?? null))
      .toBe('PROTOCOL_V2_INVALID');
    const [rows] = await pool.query<Array<{ count: number }>>('SELECT COUNT(*) AS count FROM agent_runs');
    expect(Number(rows[0]?.count)).toBe(beforeCount);
  } finally {
    await dbConnection.close();
  }
});
