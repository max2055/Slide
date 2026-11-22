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
    const [resource] = await db.execute(
      "INSERT INTO database_instances(name,host,port,username,password_encrypted,status) VALUES('验收实例','fixture.invalid',3306,'fixture','synthetic','inactive')",
    );
    const resourceId = resource.insertId;
    const title = '同名阈值事件'.repeat(13);
    const timestamp = '2026-11-10 00:00:00';
    const insertEvent = async (key: string, severity: string, status: string, source = 'legacy') => {
      const [record] = await db.execute('INSERT INTO alert_events(event_id, title, instance_id, source_type, severity, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [key, title, resourceId, source, severity, status, timestamp]);
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
    for (let index = 1; index <= 5; index++) await insertAlert('p0', 'manual', `紧急记录 ${index}`);
    const first = await insertEvent('max722-first', 'p0', 'open', 'template-trigger');
    const second = await insertEvent('max722-second', 'critical', 'open');
    const historical = await insertEvent('max722-historical', 'warning', 'reviewed');
    await insertEvent('max722-resolved', 'warning', 'resolved');
    await insertEvent('max722-closed', 'info', 'closed');
    const rule = { rule_id: 'max722.trigger', version: 2, scope: 'template', body_hash: 'max722-rule-hash',
      item: { template_id: 'max722.template', item_id: 'uptime', item_version: 1 },
      metric: { id: 'db.uptime_seconds', semantic_version: '1.0.0' }, unit: 's', recovery_mode: 'none',
      problem: { node: 'compare', select: { aggregation: 'last' }, operator: '<', threshold: { value: 10 } } };
    const sampleAt = '2026-11-10T00:00:00Z';
    const episode = { rule_id: rule.rule_id, version: rule.version, scope: rule.scope, body_hash: rule.body_hash,
      resource: { type: 'instance', id: String(resourceId) }, opened: { metric: rule.metric, at: sampleAt, value: 5 },
      last: { dimensions: {}, at: sampleAt, value: 5, quality: 'good' }, state: 'open' };
    const snapshot = { configuration: { config_revision: 4, rules: [rule], templates: [{ template_id: 'max722.template', version: 3 }] },
      opening: { sample_ids: ['max722-synthetic-sample'], attempt_ids: [] } };
    await db.execute('INSERT INTO metric_trigger_episodes (episode_id, identity_hash, resource_key, config_revision, event_id, alert_id, payload, snapshot) VALUES (?, ?, ?, 4, ?, ?, ?, ?)',
      ['max722-episode-id', 'max722-head-id', `instance:${resourceId}`, first, alert, JSON.stringify(episode), JSON.stringify(snapshot)]);

    const login = await page.request.post('/api/auth/login', { data: { username: 'admin', password: INITIAL_ADMIN_PASSWORD } });
    expect(login.status()).toBe(200);
    const session = await login.json();
    await page.addInitScript(({ token, refreshToken, user }) => {
      localStorage.setItem('token', token);
      localStorage.setItem('slide.control.session_token.v1', token);
      if (refreshToken) localStorage.setItem('refreshToken', refreshToken);
      localStorage.setItem('user', JSON.stringify(user));
      localStorage.setItem('slide.control.settings.v1:default', JSON.stringify({ locale: 'zh-CN' }));
    }, session);
    await page.goto('/');
    await page.locator('.shell-nav a[href="/events"]').click();
    const center = page.locator('event-center-page');
    const cardValue = (label: string) => center.locator(`stat-card[label="${label}"] [part="value"]`);
    for (const [width, height] of [[1366, 768], [1440, 900], [1920, 1080]]) {
      await page.setViewportSize({ width, height });
      await expect(cardValue('活跃紧急告警（P0）')).toHaveText('6');
      await expect(cardValue('活跃严重告警')).toHaveText('0');
      await expect(cardValue('活跃紧急告警（P0）')).toBeInViewport();
      await page.screenshot({ path: info.outputPath(`max722-p0-${width}.png`) });
    }
    const alertRow = center.locator('alert-list tr').filter({ hasText: title });
    await alertRow.getByRole('button', { name: '详情', exact: true }).press('Enter');
    const ruleDetails = center.locator('alert-detail-modal').getByText('查看触发器', { exact: true });
    await expect(ruleDetails).toBeVisible();
    await ruleDetails.press('Enter');
    await expect(center.locator('alert-detail-modal pre')).toContainText('max722-rule-hash');
    await expect(center.locator('alert-detail-modal pre')).toBeVisible();
    await page.screenshot({ path: info.outputPath('max722-alert-trigger.png') });
    await page.keyboard.press('Escape');

    await insertAlert('critical', 'manual', '严重记录');
    await insertAlert('warning', 'manual', '警告记录');
    await center.locator('alert-list').getByRole('button', { name: '刷新', exact: true }).click();
    await expect(cardValue('活跃严重告警')).toHaveText('1');
    await expect(cardValue('活跃紧急告警（P0）')).toHaveText('6');
    await expect(center.locator('alert-list tbody')).toContainText('警告记录');

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
      await expect(eventRow(first)).toContainText('验收实例');
      await page.screenshot({ path: info.outputPath(`max722-aggregate-${width}.png`) });
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
    await page.screenshot({ path: info.outputPath('max722-history.png') });

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
    await expect(cardValue('可见事件总计')).toHaveText('5');

    await selectView('通知投递');
    await expect(center.getByRole('button', { name: '刷新投递回执' })).toBeVisible();
    await expect(center.getByRole('button', { name: '刷新通知死信' })).toBeVisible();

    await selectView('平台异常');
    const system = center.locator('system-events-page');
    await expect(system.getByText('已关闭', { exact: true })).toBeVisible();
    await expect(system.getByText('暂无可见的异常记录', { exact: true })).toBeVisible();
    await expect(center.getByText('前往资源配置模板触发器')).toHaveCount(0);
    await page.screenshot({ path: info.outputPath('max722-platform-off.png') });
  } finally {
    await db.end();
  }
});
