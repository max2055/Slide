import { test, expect } from '@playwright/test';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
const require = createRequire(new URL('../../apps/db-ops-api/package.json', import.meta.url));
const mysql = require('mysql2/promise');
test.skip(!process.env.MAX166_ISOLATED_MYSQL, 'Use scripts/qualification/run-max166-ui.sh');
let instanceId: number;
test.beforeAll(async () => {
  if (!process.env.MAX166_ISOLATED_MYSQL) throw new Error('Requires the MAX-166 isolated MySQL runner');
  const db = await mysql.createConnection({ host: '127.0.0.1', port: Number(process.env.DB_PORT), user: 'root', password: '', database: 'db_ops_ai_qualification' });
  try {
    const [insert] = await db.query("INSERT INTO database_instances (name,host,port,username,password_encrypted,environment) VALUES ('MAX166隔离数据库','fixture.invalid',3306,'fixture','unused','testing')");
    instanceId = insert.insertId;
    await db.query('INSERT INTO schema_snapshots (instance_id,snapshot_time,table_name,column_name,column_type,is_nullable,column_key,table_rows,data_length) VALUES (?,?,?, ?, ?, ?, ?, ?, ?)', [instanceId, new Date(), 'business_table', 'id', 'int', 'NO', 'PRI', 10, 1024]);
    for (let i = 0; i < 125; i++) await db.query("INSERT INTO reports (name,type,format,instance_id,status,created_at) VALUES (?,'health','html',?,'completed','2026-10-15 00:00:00')", [`MAX166历史 ${String(i).padStart(3, '0')}`, instanceId]);
    await db.query("INSERT INTO reports (name,type,format,instance_id,status) VALUES ('MAX166真实历史','health','html',?,'completed')", [instanceId]);
  } finally { await db.end(); }
  await mkdir('test-results/max166-business', { recursive: true });
});
test('real password login, SQL-backed schema/metric/permission/report read paths', async ({ page, request }) => {
  const login = await request.post('/api/auth/login', { data: { username: 'admin', password: process.env.QUALIFICATION_ADMIN_PASSWORD } });
  expect(login.status()).toBe(200); const session = await login.json(); expect(session.token).toBeTruthy();
  const snapshot = await request.get(`/api/schema/snapshot/${instanceId}`, { headers: { Authorization: `Bearer ${session.token}` } });
  expect(snapshot.status()).toBe(200); expect(await snapshot.json()).toMatchObject({ tables: [{ table_name: 'business_table' }] });
  const batches = await Promise.all([1, 2].map(page => request.get(`/api/reports?page=${page}&limit=100`, { headers: { Authorization: `Bearer ${session.token}` } }).then(response => response.json())));
  const ids = batches.flat().map((report: any) => report.id); expect(ids).toHaveLength(126); expect(new Set(ids).size).toBe(126);
  page.on('pageerror', e => { throw new Error(`Business browser error: ${e.message}`); });
  await page.addInitScript(({ token, user }) => {
    localStorage.setItem('token', token); localStorage.setItem('user', JSON.stringify(user)); localStorage.setItem('permissions', JSON.stringify(['*']));
  }, { token: session.token, user: session.user });
  // Only the document is a harness: all API requests pass through the real Vite proxy,
  // production JWT/permission middleware, SQL routes and services. No model/collection.
  for (const d of [
    { file: 'schema-management', tag: 'schema-management-page', target: 'business_table', props: `element.instanceId=${instanceId};` },
    { file: 'index-management', tag: 'index-management-page', target: '暂无索引数据', props: `element.instanceId=${instanceId};` },
    { file: 'metric-registry', tag: 'metric-registry-viewer', target: '个指标', props: '' },
    { file: 'rbac-page', tag: 'permission-management-tab', target: '权限列表', props: '' },
    { file: 'reports', tag: 'reports-page', target: 'MAX166真实历史', props: '' },
  ]) {
    await page.route('**/max166-business-harness', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="zh-CN"><head><link rel="stylesheet" href="/src/app/styles/tokens.css"></head><body><script type="module">import '/src/app/ui/views/${d.file}.ts'; const element=document.createElement('${d.tag}');${d.props}document.body.append(element);</script></body></html>` }));
    const requests: number[] = []; const listener = (response: any) => { if (new URL(response.url()).pathname.startsWith('/api/')) requests.push(response.status()); }; page.on('response', listener);
    await page.goto('/max166-business-harness'); const view = page.locator(d.tag);
    if (d.file === 'reports') await view.getByRole('searchbox').fill('MAX166真实历史');
    await expect(view).toContainText(d.target); await expect(view.getByRole('alert')).toHaveCount(0);
    if (d.file === 'schema-management') { await view.getByRole('searchbox').fill('business_table'); await expect(view.locator('tbody tr')).toHaveCount(1); }
    if (d.file === 'reports') { await view.getByRole('searchbox').fill('MAX166真实历史'); await expect(view.locator('tbody tr')).toHaveCount(1); }
    await page.screenshot({ path: `test-results/max166-business/${d.file}-real-service.png`, fullPage: true });
    expect(requests.length).toBeGreaterThan(0); expect(requests.every(status => status === 200)).toBe(true);
    page.off('response', listener); await page.unroute('**/max166-business-harness');
  }
  for (const [path, selector] of [
    ['/settings/monitoring/metrics?view=legacy', 'metric-registry-viewer'],
    ['/settings/access/users?view=permissions', 'permission-management-tab'],
    ['/reports', 'reports-page'],
  ]) {
    await page.goto(path); const view = page.locator(selector);
    await expect(view.getByRole('searchbox')).toBeVisible();
    await expect(view.getByRole('alert')).toHaveCount(0);
    await page.screenshot({ path: `test-results/max166-business/${selector}-app-route.png`, fullPage: true });
  }

});
