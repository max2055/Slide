import { createRequire } from 'node:module';
import { expect, test } from '@playwright/test';

test.skip(process.env.MAX722_REAL_TEST !== '1', 'Requires an isolated full API and MySQL fixture');

test('event center reconciles authorized records and opens the exact historical rule', async ({ page }, info) => {
  const { DB_HOST, DB_NAME, DB_PORT, DB_USER, DB_PASSWORD, INITIAL_ADMIN_PASSWORD } = process.env;
  if (DB_HOST !== '127.0.0.1' || !/^slide_max722_\d+$/.test(DB_NAME ?? '')) throw new Error('Disposable MAX-722 schema required');
  const require = createRequire(new URL('../../apps/db-ops-api/package.json', import.meta.url));
  const mysql = require('mysql2/promise');
  const db = await mysql.createConnection({ host: DB_HOST, database: DB_NAME, port: Number(DB_PORT), user: DB_USER, password: DB_PASSWORD });
  try {
    await db.beginTransaction();
    const [resource] = await db.execute(
      "INSERT INTO database_instances(name,host,port,username,password_encrypted,status) VALUES('验收实例','fixture.invalid',3306,'fixture','synthetic','inactive')",
    );
    const resourceId = resource.insertId;
    const title = '同名阈值事件'.repeat(22);
    const sampleAt = new Date().toISOString();
    const timestamp = sampleAt.slice(0, 19).replace('T', ' ');
    const insertEvent = async (key: string, severity: string, status: string, source = 'legacy', name = title) => {
      const [record] = await db.execute('INSERT INTO alert_events(event_id, title, instance_id, source_type, severity, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [key, name, resourceId, source, severity, status, timestamp]);
      return record.insertId;
    };
    const insertAlert = async (severity: string, source = 'manual', name = title) => {
      const [record] = await db.execute(
        "INSERT INTO alerts(instance_id, target_type, alert_type, level, title, message, source, status, created_at) VALUES (?, 'instance', 'performance', ?, ?, '验收告警', ?, 'unread', ?)",
        [resourceId, severity, name, source, timestamp],
      );
      return record.insertId;
    };
    const alert = await insertAlert('p0', 'template-trigger');
    const p0Alerts = [alert];
    for (let index = 1; index <= 5; index++) p0Alerts.push(await insertAlert('p0', 'manual', `紧急记录 ${index}`));
    const first = await insertEvent('max722-first', 'p0', 'open', 'template-trigger');
    const second = await insertEvent('max722-second', 'critical', 'open');
    const historical = await insertEvent('max722-historical', 'warning', 'reviewed');
    await insertEvent('max722-resolved', 'warning', 'resolved');
    await insertEvent('max722-closed', 'info', 'closed');
    const rule = { rule_id: 'max722.trigger', version: 2, scope: 'template', body_hash: 'max722-rule-hash',
      item: { template_id: 'max722.template', item_id: 'uptime', item_version: 1 },
      metric: { id: 'db.uptime_seconds', semantic_version: '1.0.0' }, unit: 's', recovery_mode: 'none',
      problem: { node: 'compare', select: { aggregation: 'last' }, operator: '<', threshold: { value: 10 } } };
    const episode = { rule_id: rule.rule_id, version: rule.version, scope: rule.scope, body_hash: rule.body_hash,
      resource: { type: 'instance', id: String(resourceId) }, opened: { metric: rule.metric, at: sampleAt, value: 5 },
      last: { dimensions: {}, at: sampleAt, value: 5, quality: 'good' }, state: 'open' };
    const snapshot = { configuration: { config_revision: 4, rules: [rule], templates: [{ template_id: 'max722.template', version: 3 }] },
      opening: { sample_ids: ['max722-synthetic-sample'], attempt_ids: [] } };
    await db.execute('INSERT INTO metric_trigger_episodes (episode_id, identity_hash, resource_key, config_revision, event_id, alert_id, payload, snapshot) VALUES (?, ?, ?, 4, ?, ?, ?, ?)',
      ['max722-episode-id', 'max722-head-id', `instance:${resourceId}`, first, alert, JSON.stringify(episode), JSON.stringify(snapshot)]);
    const linkAlert = (eventId: number, alertId: number) =>
      db.execute("INSERT INTO alert_event_members (event_id, alert_id, role) VALUES (?, ?, 'related')", [eventId, alertId]);
    for (const id of p0Alerts) await linkAlert(first, id);
    await db.commit();

    await page.addInitScript(() => {
      localStorage.setItem('slide.control.settings.v1:default', JSON.stringify({ locale: 'zh-CN' }));
    });
    await page.goto('/');
    await page.getByRole('textbox', { name: '用户名' }).fill('admin');
    await page.getByPlaceholder('请输入密码（必填）').fill(INITIAL_ADMIN_PASSWORD!);
    const login = page.waitForResponse(response => response.url().endsWith('/api/auth/login') && response.request().method() === 'POST');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    expect((await login).status()).toBe(200);
    await page.getByRole('link', { name: '事件中心', exact: true }).click({ timeout: 10_000 });
    const center = page.locator('event-center-page');
    const cardValue = (label: string) => center.locator(`stat-card[label="${label}"] [part="value"]`);
    for (const [width, height] of [[1366, 768], [1440, 900], [1920, 1080]]) {
      await page.setViewportSize({ width, height });
      await expect(cardValue('活跃紧急告警（P0）')).toHaveText('6');
      await expect(cardValue('活跃严重告警')).toHaveText('0');
      await expect(cardValue('活跃紧急告警（P0）')).toBeInViewport();
      await page.screenshot({ path: info.outputPath(`max722-p0-${width}.png`), animations: 'disabled' });
    }
    const alertRow = center.locator('alert-list tr').filter({ hasText: title });
    await alertRow.getByRole('button', { name: '详情', exact: true }).press('Enter');
    const ruleDetails = center.locator('alert-detail-modal').getByText('查看触发器', { exact: true });
    await expect(ruleDetails).toBeVisible();
    await ruleDetails.press('Enter');
    await expect(center.locator('alert-detail-modal pre')).toContainText('max722-rule-hash');
    await expect(center.locator('alert-detail-modal pre')).toBeVisible();
    await page.screenshot({ path: info.outputPath('max722-alert-trigger.png'), animations: 'disabled' });
    await page.keyboard.press('Escape');

    await db.beginTransaction();
    await linkAlert(second, await insertAlert('critical', 'manual', '严重记录'));
    await linkAlert(second, await insertAlert('warning', 'manual', '警告记录'));
    await db.commit();
    await center.locator('alert-list').getByRole('button', { name: '刷新', exact: true }).click();
    await expect(cardValue('活跃严重告警')).toHaveText('1');
    await expect(cardValue('活跃紧急告警（P0）')).toHaveText('6');
    await expect(center.locator('alert-list tbody')).toContainText('警告记录');
    const alerts = center.locator('alert-list');
    await db.query('RENAME TABLE alerts TO max722_unavailable_alerts');
    try {
      await alerts.getByRole('button', { name: '刷新', exact: true }).click();
      await expect(alerts.getByRole('alert')).toContainText('加载告警失败');
      await expect(cardValue('活跃紧急告警（P0）')).toHaveCount(0);
    } finally {
      await db.query('RENAME TABLE max722_unavailable_alerts TO alerts');
    }
    await alerts.getByRole('button', { name: '重试', exact: true }).press('Enter');
    await expect(cardValue('活跃紧急告警（P0）')).toHaveText('6');

    const selectView = (name: string) => center.getByRole('tab', { name, exact: true }).click();
    await selectView('聚合事件');
    const aggregates = center.locator('event-management-page');
    const group = (name: RegExp) => aggregates.getByRole('button', { name });
    await expect(cardValue('可见事件总计')).toHaveText('5');
    await expect(group(/^活跃事件/)).toHaveText(/活跃事件\s*2/);
    await expect(group(/^已解决 \/ 已关闭/)).toHaveText(/已解决 \/ 已关闭\s*2/);
    await expect(group(/^历史未归类/)).toHaveText(/历史未归类\s*1/);
    const eventRow = (id: number) => aggregates.getByRole('button', { name: `查看事件 #${id} 详情`, exact: true });
    for (const [width, height] of [[1366, 768], [1440, 900], [1920, 1080]]) {
      await page.setViewportSize({ width, height });
      await expect(eventRow(first).getByText(`#${first}`, { exact: true })).toBeInViewport();
      await expect(eventRow(second).getByText(`#${second}`, { exact: true })).toBeInViewport();
      await expect(eventRow(first).locator('.event-name')).toHaveAttribute('title', title);
      if (width !== 1920) {
        expect(await eventRow(first).locator('.event-name').evaluate(el => el.scrollWidth > el.clientWidth)).toBe(true);
      }
      await expect(eventRow(first)).toContainText('验收实例');
      await page.screenshot({ path: info.outputPath(`max722-aggregate-${width}.png`), animations: 'disabled' });
    }
    for (const id of [first, second]) {
      await eventRow(id).press('Enter');
      const detail = aggregates.getByRole('region', { name: '事件详情' });
      await expect(detail.getByText(new RegExp(`^事件 #${id}(?:$|[：:])`)).first()).toBeVisible();
      await aggregates.getByRole('button', { name: '返回事件列表', exact: true }).click();
      await expect(eventRow(id)).toBeFocused();
    }
    await group(/^历史未归类/).click();
    await eventRow(historical).click();
    await expect(aggregates.getByText('已审阅（历史）').first()).toBeVisible();
    await expect(aggregates.getByRole('button', { name: '添加备注' })).toHaveCount(0);
    await aggregates.getByRole('button', { name: '返回事件列表', exact: true }).click();
    await expect(aggregates.getByText('当前状态可见事件共 1 条', { exact: false })).toBeVisible();
    await page.screenshot({ path: info.outputPath('max722-history.png'), animations: 'disabled' });

    for (let index = 1; index <= 50; index++) {
      await insertEvent(`max722-page-${index}`, 'warning', 'open', 'legacy', `分页验收事件 ${index}`);
    }
    await group(/^活跃事件/).click();
    await expect(group(/^活跃事件/)).toHaveText(/活跃事件\s*52/);
    await aggregates.getByRole('textbox', { name: '搜索本页事件' }).fill('同名阈值事件');
    await aggregates.getByRole('combobox', { name: '本页严重度' }).selectOption('p0');
    await expect(aggregates.getByText('本页命中 0 条 · 当前状态可见事件共 52 条')).toBeVisible();
    await aggregates.getByRole('button', { name: /下一页/ }).click();
    await expect(aggregates.getByText('本页命中 1 条 · 当前状态可见事件共 52 条')).toBeVisible();
    await expect(eventRow(first)).toBeVisible();
    await expect(cardValue('可见事件总计')).toHaveText('55');
    await aggregates.getByRole('textbox', { name: '搜索本页事件' }).fill('');
    await aggregates.getByRole('combobox', { name: '本页严重度' }).selectOption('all');
    await group(/^历史未归类/).click();
    await expect(eventRow(historical)).toBeVisible();

    await db.query('RENAME TABLE alert_events TO max722_unavailable_events');
    try {
      await aggregates.getByRole('button', { name: '刷新事件' }).click();
      await expect(aggregates.getByRole('alert')).toContainText('503');
      await expect(cardValue('可见事件总计')).toHaveText('未知');
      await expect(aggregates.getByText('暂无历史未归类事件')).toHaveCount(0);
    } finally {
      await db.query('RENAME TABLE max722_unavailable_events TO alert_events');
    }
    await aggregates.getByRole('button', { name: '重试加载' }).press('Enter');
    await expect(eventRow(historical)).toBeVisible();
    await expect(cardValue('可见事件总计')).toHaveText('55');

    await selectView('通知投递');
    const receiptRefresh = center.getByRole('button', { name: '刷新投递回执' });
    const deadLetterRefresh = center.getByRole('button', { name: '刷新通知死信' });
    await expect(receiptRefresh).toBeEnabled();
    await expect(deadLetterRefresh).toBeEnabled();
    const reads: string[] = [];
    page.on('request', request => {
      const path = new URL(request.url()).pathname;
      if (path.startsWith('/api/notification/')) reads.push(path);
    });
    for (const [button, path] of [
      [receiptRefresh, '/api/notification/deliveries'],
      [deadLetterRefresh, '/api/notification/dead-letters'],
    ] as const) {
      const response = page.waitForResponse(item => new URL(item.url()).pathname === path);
      await button.click();
      expect((await response).status()).toBe(200);
    }
    expect(reads).toEqual(['/api/notification/deliveries', '/api/notification/dead-letters']);

    await selectView('平台异常');
    const system = center.locator('system-events-page');
    await expect(system.getByText('已关闭', { exact: true })).toBeVisible();
    await expect(system.getByText('暂无可见的异常记录', { exact: true })).toBeVisible();
    await expect(center.getByText('前往资源配置模板触发器')).toHaveCount(0);
    await page.screenshot({ path: info.outputPath('max722-platform-off.png'), animations: 'disabled' });
  } finally {
    await db.end();
  }
});
