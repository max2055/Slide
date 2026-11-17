import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { AgentRunService } from '../../apps/db-ops-api/src/adapter/agent-run-service';
import { runtimeEvidence } from './runtime-evidence';
import { dbConnection } from '../../apps/db-ops-api/src/db-connection';

for (const scenario of ['recovery', 'length', 'reject'] as const) {
  test(`runtime qualification ${scenario} keeps a unique safe final across reload`, async ({ page }, testInfo) => {
    test.skip(process.env.QUALIFICATION_CANCELLATION_E2E !== '1', 'requires isolated managed MySQL/provider');
    test.setTimeout(60_000);
    const evidence = runtimeEvidence(page, scenario, testInfo);
    let recoveryRun: { id: string; actorId: number; sessionId: string } | undefined;
    await page.goto('/chat');
    await page.locator('.login-gate input[autocomplete="username"]').fill('admin');
    await page.locator('.login-gate input[autocomplete="current-password"]').fill(process.env.QUALIFICATION_ADMIN_PASSWORD ?? 'Tpam1234');
    await page.locator('.login-gate__connect').click();
    await expect(page.locator('.login-gate')).toBeHidden({ timeout: 15_000 });
    const input = page.getByRole('textbox', { name: /Message .*Enter to send/ });
    await expect(input).toBeEnabled();
    const prompt = `runtime-qualification:${scenario}:${randomUUID()} 检查数据库`;
    await input.fill(prompt); await page.getByRole('button', { name: 'Send message' }).click();
    expect(await dbConnection.initialize({ host: process.env.DB_HOST ?? '127.0.0.1', port: Number(process.env.DB_PORT ?? 3306), user: process.env.DB_USER ?? 'root', password: process.env.DB_PASSWORD, database: 'db_ops_ai_qualification' })).toBe(true);
    try {
      const pool = dbConnection.getPool()!;
      let sessionId = '';
      await expect.poll(async () => {
        const [rows] = await pool.query<Array<{ state: string; session_id: string }>>('SELECT ar.state, ar.session_id FROM agent_runs ar JOIN chat_messages cm ON cm.session_id = ar.session_id WHERE cm.role = ? AND cm.content = ? ORDER BY ar.created_at DESC LIMIT 1', ['user', prompt]);
        sessionId = rows[0]?.session_id ?? ''; return rows[0]?.state;
      }, { timeout: 15_000 }).toBe(scenario === 'reject' ? 'failed' : 'completed');
      const expected = scenario === 'length' ? '第一段。第二段。' : '安全结论：数据库连接正常。';
      const readMessages = async () => { const [rows] = await pool.query<Array<{ content: string }>>('SELECT content FROM chat_messages WHERE session_id = ? AND role = ?', [sessionId, 'assistant']); return rows; };
      evidence.bind(sessionId, expected);
      const rows = await readMessages();
      expect(rows).toHaveLength(scenario === 'reject' ? 0 : 1);
      expect(JSON.stringify(rows)).not.toContain('正在分析数据库状态');
      await expect.poll(() => page.evaluate(() => (document.querySelector('slide-app') as any)?.chatStream ?? '')).not.toContain('正在分析数据库状态');
      if (scenario !== 'reject') {
        expect(rows[0].content).toBe(expected);
        await expect(page.getByText(expected, { exact: true })).toBeVisible();
      }
      evidence.phase('before_reload');
      await page.reload();
      if (scenario !== 'reject') await expect(page.getByText(expected, { exact: true })).toBeVisible({ timeout: 15000 });
      await expect(page.getByText('正在分析数据库状态', { exact: false })).toHaveCount(0);
      expect(await readMessages()).toEqual(rows);
      if (scenario === 'recovery') {
        const [owners] = await pool.query<Array<{ user_id: number }>>('SELECT user_id FROM chat_sessions WHERE session_id = ?', [sessionId]);
        const service = new AgentRunService();
        const { run } = await service.claim(owners[0].user_id, sessionId, randomUUID(), randomUUID());
        recoveryRun = run;
        const failingStore = new AgentRunService(() => ({ query: pool.query.bind(pool), getConnection: async () => { throw new Error('controlled storage unavailable'); } }) as any);
        await expect(failingStore.complete(run, { type: 'complete', finalContent: '重连恢复的唯一最终答案。' })).rejects.toThrow('controlled storage unavailable');
        const pending = await service.getForActor(run.id, run.actorId, sessionId);
        expect(pending?.state).toBe('running');
        expect((pending?.result as any).completionPending).toBe(true);
        evidence.bind(sessionId, '重连恢复的唯一最终答案。');
        evidence.phase('pending_staged');
        evidence.phase('before_recovery_reload');
        await page.reload();
        await expect(page.getByText('重连恢复的唯一最终答案。', { exact: true })).toBeVisible({ timeout: 15000 });
        await expect.poll(async () => (await service.getForActor(run.id, run.actorId, sessionId))?.state).toBe('completed');
        await page.reload();
        await expect(page.getByText('重连恢复的唯一最终答案。', { exact: true })).toHaveCount(1);
        const [finals] = await pool.query<Array<{ content: string }>>('SELECT content FROM chat_messages WHERE message_id = ?', [`run_${run.id}_assistant`]);
        expect(finals).toEqual([{ content: '重连恢复的唯一最终答案。' }]);
      }
    } catch (error) { evidence.testFailed(); throw error; } finally {
      if (recoveryRun) {
        try {
          const pool = dbConnection.getPool()!;
          const [runs] = await pool.query<any[]>({ sql: 'SELECT state, result_json FROM agent_runs WHERE id = ? AND actor_id = ? AND session_id = ?', timeout: 2000 }, [recoveryRun.id, recoveryRun.actorId, recoveryRun.sessionId]);
          const [messages] = await pool.query<any[]>({ sql: 'SELECT content FROM chat_messages WHERE session_id = ? AND message_id = ?', timeout: 2000 }, [recoveryRun.sessionId, `run_${recoveryRun.id}_assistant`]);
          const result = typeof runs[0]?.result_json === 'string' ? JSON.parse(runs[0].result_json) : runs[0]?.result_json;
          evidence.snapshot(recoveryRun.id, runs[0]?.state ?? 'missing', result?.completionPending === true, messages);
        } catch { evidence.fail(); }
      }
      await evidence.finish();
      await dbConnection.close();
    }
  });
}
