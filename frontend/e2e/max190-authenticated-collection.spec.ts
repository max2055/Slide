import { expect, test, type Page } from '@playwright/test';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomBytes, createHash } from 'node:crypto';
import { mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// Explicitly authorized real target; platform writes remain in a disposable MySQL copy.
// No HTTP mocks, seeded browser session, synthetic publications or product LLM calls.
test.skip(process.env.MAX190_AUTHENTICATED_REAL !== '1', 'Requires explicit mysql3306 real-service run');
const require = createRequire(resolve('../apps/db-ops-api/package.json'));
const mysql = require('mysql2/promise'), bcrypt = require('bcrypt'), dotenv = require('dotenv');
const output = process.env.MAX190_OUTPUT_DIR ?? '/Users/max/Coding/40-Slide/outputs/MAX-190-trial-real';
const apiDirectory = resolve('../apps/db-ops-api'), api = 'http://127.0.0.1:3190', site = 'http://127.0.0.1:5196';
const schema = `max190_auth_${process.pid}`, container = `max190-auth-${process.pid}`;
const rootPassword = randomBytes(24).toString('hex'), password = randomBytes(24).toString('hex');
const children: ChildProcess[] = [];
let source: any, pool: any, started = false, token = '', sourceDigest = '';
const report: any = { source: 'Real mysql3306, complete Fastify/JWT login/navigation and production scheduler', requests: [], processes: [], checks: {}, product_llm_calls: 0 };
const save = () => writeFile(`${output}/result.json`, JSON.stringify(report, null, 2));
const matrix = process.env.MAX190_VISUAL_MATRIX === '1';
async function captureMatrix(page: Page, name: string) {
  for (const width of [1440, 390]) for (const mode of ['light', 'dark']) {
    await page.setViewportSize({ width, height: 1000 });
    await page.evaluate(mode => { document.documentElement.dataset.themeMode = mode; }, mode);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${name}: document overflow`).toBe(true);
    await page.evaluate(() => { for (const el of document.querySelectorAll('*')) if (el.scrollTop) el.scrollTop = 0; });
    await page.screenshot({ path: `${output}/${name}-${width}-${mode}.png` });
    const editor = page.locator('metric-configuration');
    if (await editor.isVisible()) {
      const overflows = await editor.evaluate((el: any) => [...el.shadowRoot.querySelectorAll('.edit-grid,.template-preview,.fields,.coverage-line')].filter((node: any) => node.scrollWidth > node.clientWidth + 1).map((node: any) => node.className));
      expect(overflows, `${name}: inner overflow`).toEqual([]);
      await editor.getByRole('button', {name:'检查并启用',exact:true}).scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${output}/${name}-actions-${width}-${mode}.png` });
    }
  }
}
const snapshot = async () => {
  const [d] = await source.query('SELECT id,target_type,unit,value_type,default_interval,collection_sqls,compute_expr FROM metric_definitions WHERE is_builtin=0 ORDER BY id');
  const [b] = await source.query('SELECT * FROM instance_templates WHERE instance_id=1 ORDER BY template_id');
  const [r] = await source.query('SELECT * FROM database_instances WHERE id=1');
  const [providers] = await source.query('SELECT * FROM llm_providers ORDER BY id');
  const [routes] = await source.query('SELECT * FROM llm_scene_bindings ORDER BY scene');
  const [servers] = await source.query('SELECT * FROM servers ORDER BY id');
  const [devices] = await source.query('SELECT * FROM network_devices ORDER BY id');
  return createHash('sha256').update(JSON.stringify([d,b,r,providers,routes,servers,devices])).digest('hex');
};
async function request(path: string, body?: unknown, method?: string) {
  const response = await fetch(api + path, { method: method ?? (body === undefined ? 'GET' : 'POST'), headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  report.requests.push({ path, status: response.status });
  if (!response.ok) throw new Error(`Real API ${path}: HTTP ${response.status}`);
  return response.json();
}
async function launch(args: string[], cwd: string, env: NodeJS.ProcessEnv, name: string) {
  const file = await open(`${output}/${name}.private.log`, 'w', 0o600);
  const child = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', file.fd, file.fd] });
  children.push(child); await file.close();
  report.processes.push({ pid: child.pid, cwd, command: ['node', ...args], log: `${name}.private.log` });
  return child;
}
async function ready(url: string, child: ChildProcess) {
  await expect.poll(async () => {
    if (child.exitCode !== null) throw new Error('Task process exited; inspect private log');
    try { return (await fetch(url)).status; } catch { return 0; }
  }, { timeout: 90000 }).toBe(200);
}
test.beforeAll(async () => {
  test.setTimeout(240000); await mkdir(output, { recursive: true });
  const cfg = dotenv.parse(await readFile(process.env.SLIDE_DEBUG_ENV_FILE!));
  source = mysql.createPool({ host: cfg.DB_HOST || '127.0.0.1', port: Number(cfg.DB_PORT || 3306), user: cfg.DB_USER, password: cfg.DB_PASSWORD, database: cfg.DB_NAME, timezone: 'Z' });
  const [[version]] = await source.query('SELECT VERSION() AS version'); expect(version.version).toMatch(/^9\.6\./);
  sourceDigest = await snapshot();
  report.code = { head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), tree: execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim() };
  execFileSync('docker', ['run', '-d', '--name', container, '-p', '127.0.0.1:23390:3306', '-e', 'MYSQL_ROOT_PASSWORD', '-e', 'MYSQL_ROOT_HOST', 'mysql:8.4'], { env: { ...process.env, MYSQL_ROOT_PASSWORD: rootPassword, MYSQL_ROOT_HOST: '%' }, stdio: 'pipe' }); started = true;
  await expect.poll(async () => {
    try { const c = await mysql.createConnection({ host: '127.0.0.1', port: 23390, user: 'root', password: rootPassword, connectTimeout: 1000 }); await c.end(); return true; } catch { return false; }
  }, { timeout: 120000 }).toBe(true);
  const env = { ...process.env, DB_HOST: '127.0.0.1', DB_PORT: '23390', DB_USER: 'root', DB_PASSWORD: rootPassword, DB_NAME: schema,
    JWT_SECRET_KEY: randomBytes(32).toString('hex'), ENCRYPTION_KEY: cfg.ENCRYPTION_KEY,
    PORT: '3190', HOST: '127.0.0.1', AGENT_WS_PORT: '29990', SLIDE_MEMORY_PIPELINE_ENABLED: 'false', METRICS_COLLECTION_ENABLED: 'true',
    INITIAL_ADMIN_USERNAME: 'admin', INITIAL_ADMIN_PASSWORD: password };
  const migration = await launch(['--import', 'tsx', 'init-db.ts'], apiDirectory, env, 'migration');
  await new Promise<void>((ok, fail) => { migration.once('exit', code => code === 0 ? ok() : fail(new Error('Disposable platform migration failed'))); migration.once('error', fail); });
  pool = mysql.createPool({ host: env.DB_HOST, port: 23390, user: 'root', password: rootPassword, database: schema, timezone: 'Z' });
  await pool.query("UPDATE users SET password_hash=?,status='active' WHERE username='admin'", [await bcrypt.hash(password, 10)]);
  await pool.query("INSERT IGNORE INTO user_roles(user_id,role_id) SELECT u.id,r.id FROM users u JOIN roles r ON r.name='admin' WHERE u.username='admin'");
  // Preserve configured providers/routes verbatim in the disposable platform for engine startup.
  // Secrets stay in memory/encrypted SQL fields; no provider tests or inference are requested.
  await pool.query('DELETE FROM llm_scene_bindings');
  await pool.query('DELETE FROM llm_providers');
  for (const table of ['llm_providers','llm_scene_bindings']) {
    const [rows] = await source.query('SELECT * FROM ??', [table]);
    const [columns] = await pool.query('SHOW COLUMNS FROM ??', [table]);
    const names = new Set(columns.map((c: any) => c.Field));
    for (const row of rows) {
      const copy = Object.fromEntries(Object.entries(row).filter(([key]) => names.has(key)).map(([key,value]) =>
        [key, value && typeof value === 'object' && !(value instanceof Date) ? JSON.stringify(value) : value]));
      await pool.query('INSERT INTO ?? SET ?', [table,copy]);
    }
  }
  const [[instance]] = await source.query('SELECT id,name,host,port,username,password_encrypted,db_type,db_version,database_name,environment,status FROM database_instances WHERE id=1');
  await pool.query('INSERT INTO database_instances SET ?', [instance]);
  if (matrix) {
    report.fixtureResources = {};
    for (const table of ['servers', 'network_devices']) {
      const [rows] = await source.query('SELECT * FROM ?? ORDER BY id LIMIT 1', [table]);
      const [columns] = await pool.query('SHOW COLUMNS FROM ??', [table]);
      const names = new Set(columns.map((c: any) => c.Field));
      for (const row of rows) {
        const copy = Object.fromEntries(Object.entries(row).filter(([key]) => names.has(key)));
        // Read-only UI verification: never probe or schedule these copied targets.
        copy.collection_enabled = 0;
        await pool.query('INSERT INTO ?? SET ?', [table, copy]);
      }
      report.fixtureResources[table] = rows.map((r: any) => r.id);
    }
  }
  const [definitions] = await source.query('SELECT id,target_type,name,unit,value_type,db_types,aggregation,default_interval,is_collected,is_builtin,collection_sqls,compute_expr FROM metric_definitions WHERE is_builtin=0');
  for (const row of definitions) {
    for (const key of ['collection_sqls','db_types']) if (row[key] && typeof row[key] !== 'string') row[key] = JSON.stringify(row[key]);
    await pool.query('INSERT INTO metric_definitions SET ? ON DUPLICATE KEY UPDATE ?', [row,row]);
  }
  const [templates] = await source.query('SELECT t.id,t.name,t.db_type,t.macro_defaults,t.metrics,t.enabled,i.macro_overrides,i.disabled_metrics FROM metric_templates t JOIN instance_templates i ON i.template_id=t.id WHERE i.instance_id=1');
  for (const [table, column] of [['metric_templates','metrics'],['instance_templates','disabled_metrics']]) {
    const [columns] = await pool.query('SHOW COLUMNS FROM ?? LIKE ?', [table,column]);
    if (!columns.length) await pool.query("ALTER TABLE ?? ADD COLUMN ?? JSON NULL COMMENT 'Retained legacy configuration for migration validation'", [table,column]);
  }
  for (const row of templates) {
    const { macro_overrides, disabled_metrics, ...template } = row;
    for (const key of ['macro_defaults','metrics']) if (template[key] && typeof template[key] !== 'string') template[key] = JSON.stringify(template[key]);
    await pool.query('INSERT INTO metric_templates SET ? ON DUPLICATE KEY UPDATE ?', [template,template]);
    await pool.query('INSERT INTO instance_templates(instance_id,template_id,macro_overrides,disabled_metrics) VALUES(?,?,?,?)', [1,row.id,macro_overrides && JSON.stringify(macro_overrides),disabled_metrics && JSON.stringify(disabled_metrics)]);
  }
  // Retain an actual historical row as migration evidence; never use it as a formal value.
  const [history] = await source.query('SELECT instance_id,connections,recorded_at FROM metrics_history WHERE instance_id=1 ORDER BY id DESC LIMIT 1');
  if (history.length) await pool.query('INSERT INTO metrics_history SET ?', [history[0]]);
  report.target = { id: 1, name: instance.name, version: instance.db_version, host: instance.host, port: instance.port, source_configuration_digest: sourceDigest };
  report.fixture = { schema, container, platform: 'MySQL 8.4 disposable copy', sourceDefinitionIds: definitions.map((r: any) => r.id), sourceTemplateIds: templates.map((r: any) => r.id), syntheticPublications: 0 };
  const diagnostic = `import { dbConnection } from './src/db-connection.ts';
    import { metricConfigurationService } from './src/metrics/config/routes.ts';
    import { admin } from './src/metrics/policy/test-support.ts';
    await dbConnection.initialize();
    try { const result = await metricConfigurationService.status(admin, {type:'instance',id:1}); console.log('MAX190_STATUS_DIAGNOSTIC='+JSON.stringify({ok:true,binding:result.binding})); }
    catch(error) { console.log('MAX190_STATUS_DIAGNOSTIC='+JSON.stringify({ok:false,name:error.name,code:error.code,message:error.message,stack:error.stack?.split('\\n').slice(1,7)})); }
    finally { await dbConnection.close(); }`;
  const diagnosticLog = execFileSync(process.execPath, ['--import','tsx','--input-type=module','-e',diagnostic], {cwd:apiDirectory,env,encoding:'utf8',timeout:30000});
  report.directStatus = JSON.parse(diagnosticLog.split('\n').find((line: string) => line.startsWith('MAX190_STATUS_DIAGNOSTIC='))!.slice('MAX190_STATUS_DIAGNOSTIC='.length));
  await save();
  const backend = await launch(['--import', 'tsx', 'server.ts'], apiDirectory, env, 'api'); await ready(api + '/api/health/ready', backend);
  const vite = await launch([resolve('node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', '5196', '--strictPort'], resolve('.'), { ...env, VITE_API_PROXY_TARGET: api, VITE_AGENT_WS_PROXY_TARGET: 'http://127.0.0.1:29990' }, 'vite'); await ready(site, vite);
  await save();
});
test.afterAll(async () => {
  test.setTimeout(60000);
  for (const child of [...children].reverse()) if (child.exitCode === null) {
    child.kill('SIGTERM'); await new Promise<void>(ok => { child.once('exit', () => ok()); setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); ok(); }, 7000).unref(); });
  }
  if (source) { report.checks.originalConfigurationUnchanged = await snapshot() === sourceDigest; await source.end(); }
  await pool?.end();
  if (started) { execFileSync('docker', ['stop', container], { stdio: 'pipe' }); execFileSync('docker', ['rm', '--volumes', container], { stdio: 'pipe' }); }
  report.cleanup = { containerRemoved: started, processes: children.map(c => ({ pid: c.pid, exitCode: c.exitCode, signal: c.signalCode })) }; await save();
});

test(matrix ? 'authenticated R1 page matrix, formal field consistency and resource editor navigation' : 'login → existing mysql3306 editor → mixed trial → publish → three formal cycles → list/detail/settings', async ({ page }) => {
  test.setTimeout(240000); page.setDefaultTimeout(15000);
  const stage = async (name: string) => { report.stage = name; await save(); };
  await page.addInitScript(() => localStorage.setItem('slide.i18n.locale', 'zh-CN'));
  page.on('response', response => { const path = new URL(response.url()).pathname; if (path.startsWith('/api/metrics/')) report.requests.push({ path, status: response.status(), source: 'browser' }); });
  await page.goto(site + '/instances-db'); await stage('login page');
  await page.getByRole('textbox', { name: '用户名', exact: true }).fill('admin'); await stage('username filled');
  await page.getByLabel('密码', { exact: true }).fill(password); await stage('password filled');
  const login = page.waitForResponse(r => r.url().endsWith('/api/auth/login') && r.request().method() === 'POST');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  expect((await login).status()).toBe(200); await stage('REST login succeeded');
  token = await page.evaluate(() => localStorage.getItem('token') ?? ''); expect(token).not.toBe('');
  await expect(page.locator('instances-page')).toBeVisible(); report.checks.authenticatedNavigation = true; await stage('authenticated resource page');
  await page.screenshot({ path: `${output}/authenticated-list.png`, fullPage: true });
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  await page.getByRole('tab', { name: '监控与采集', exact: true }).click();
  const editor = page.locator('metric-configuration'); await stage('resource editor');
  await page.screenshot({ path: `${output}/editor-initial.png`, fullPage: true });
  const catalog = await request('/api/metrics/config/catalog');
  report.httpStatus = await request('/api/metrics/config/resources/instance/1/status'); await save();
  const pin = catalog.packages.find((r: any) => r.package.id === 'mysql-custom-existing-scalars').package;
  await editor.getByLabel('采集包 / 模板版本', { exact: true }).selectOption(pin.digest); await stage('custom SQL package selected');
  await editor.getByLabel('采集间隔（秒）覆盖方式', { exact: true }).selectOption('set');
  await editor.getByLabel('采集间隔（秒）', { exact: true }).fill('5');
  await page.screenshot({ path: `${output}/editor-desktop-light.png`, fullPage: true });
  if (matrix) await captureMatrix(page, 'editor-normal');
  await editor.getByRole('button', { name: '检查并启用', exact: true }).click();
  await editor.getByRole('button', { name: '预检与影响预览' }).click(); await expect(editor).toContainText('影响 1 个资源');
  const trialResponse = page.waitForResponse(r => r.url().endsWith('/trial') && r.request().method() === 'POST');
  await editor.getByRole('button', { name: '试采', exact: true }).click();
  const trial = await trialResponse; expect(trial.status()).toBe(200); report.trial = await trial.json();
  expect(report.trial.samples.some((s: any) => s.value !== null && s.quality.status === 'good')).toBe(true);
  await expect(editor).toContainText('可发布有效指标，部分指标仍失败/待验证');
  await expect(editor.getByRole('button', { name: '发布', exact: true })).toBeEnabled();
  for (const width of [1440,390]) for (const mode of ['light','dark']) {
    await page.setViewportSize({ width, height: 1000 }); await page.evaluate(mode => { document.documentElement.dataset.themeMode = mode; }, mode);
    await page.screenshot({ path: `${output}/mixed-trial-${width}-${mode}.png`, fullPage: true });
  }
  const activation = page.waitForResponse(r => r.url().endsWith('/activate') && r.request().method() === 'POST');
  await editor.getByRole('button', { name: '发布', exact: true }).click();
  const published = await activation; expect(published.status()).toBe(200); report.activation = await published.json(); await save();
  const root = '/api/metrics/config/resources/instance/1';
  await expect.poll(async () => { report.status = await request(root + '/status'); await save(); return report.status.formal_visibility.state; }, { timeout: 120000, intervals: [1000,2000,3000] }).toBe('available');
  if (!matrix) await expect.poll(async () => {
    const [[row]] = await pool.query("SELECT COUNT(DISTINCT p.observed_at) n FROM metric_publications p JOIN metric_rollout r ON r.series_hash=p.series_hash WHERE r.resource_type='instance' AND r.resource_id='1'");
    report.formalCycles = Number(row.n); return report.formalCycles;
  }, { timeout: 90000, intervals: [1000,2000,3000] }).toBeGreaterThanOrEqual(3);
  report.formalQuery = await request('/api/metrics/query', { resource: { type: 'instance', id: 1 }, view: 'all', from: new Date(Date.now()-60000).toISOString(), to: new Date().toISOString(), bucket_ms: 5000 });
  for (const id of ['custom.mysql.processlist_connections','custom.mysql.slow_queries_snapshot']) {
    expect(report.formalQuery.metrics.find((m: any) => m.definition.id === id)?.series.some((s: any) => s.buckets.some((b: any) => b.value !== null && b.quality.status === 'good'))).toBe(true);
  }
  report.checks.threeFormalCycles = matrix ? 'reused e556eba1 evidence; not repeated' : true; report.checks.existingSqlFormalValues = true; await save();
  await page.keyboard.press('Escape');
  await editor.getByText('最近正式采集尝试与技术证据', { exact: true }).click();
  await editor.getByRole('button', { name: '重新加载', exact: true }).click();
  await expect(editor.locator('.state-card')).toContainText('正式可用');
  await page.getByRole('button', { name: '返回资源列表', exact: true }).click();
  await expect(page.locator('resource-metrics-table')).toContainText('已绑定');
  await page.screenshot({ path: `${output}/list-formal.png`, fullPage: true });
  if (matrix) {
    // Compare the exact response consumed by the table, including capability changes
    // introduced by imported custom packages; do not hard-code MySQL 9.6 unsupported.
    const tableResult = await page.locator('resource-metrics-table').evaluate((el: any) => el.rows.get(1));
    report.listEvidence = tableResult;
    const capacity = tableResult.result.metrics.find((m: any) => m.definition.id === 'mysql.tables.estimated_allocated_bytes');
    const capacityBucket = capacity.series[0]?.buckets.at(-1);
    if (capacityBucket?.value) {
      const bytes = Number(capacityBucket.value.value);
      const units = ['B', 'KiB', 'MiB', 'GiB'];
      const index = Math.min(3, Math.floor(Math.log2(Math.max(1, bytes)) / 10));
      const formatted = index ? (bytes / 1024 ** index).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : bytes.toLocaleString('zh-CN');
      await expect(page.locator('resource-metrics-table').getByRole('cell').filter({hasText: `${formatted} ${units[index]}`})).toBeVisible();
    } else await expect(page.locator('resource-metrics-table')).toContainText(capacity.state === 'unsupported' ? '该版本不支持' : '待样本');
    const uptime = tableResult.result.metrics.find((m: any) => m.definition.id === 'db.uptime_seconds').series[0]?.buckets.at(-1)?.value?.value;
    if (uptime != null) await expect(page.locator('resource-metrics-table')).toContainText(`${Math.floor(Number(uptime)/86400)} 天 ${Math.floor(Number(uptime)%86400/3600)} 小时`);
    report.listStatus = await request(root + '/status');
    expect(pin).toMatchObject(report.listStatus.binding.package);
    expect(report.listStatus.binding.published_revision).toBe(report.activation.resources[0].binding.revision);
    report.checks.listValuesAndBindingMatchApi = true;
    await captureMatrix(page, 'list-normal');
  }
  await page.goto(site + '/instance-detail?id=1');
  await page.getByRole('tab', { name: '采集配置', exact: true }).click();
  await expect(page.locator('resource-collection-section')).toContainText('正式可用');
  if (matrix) {
    const section = page.locator('resource-collection-section');
    await section.getByText('技术证据与配置版本', { exact: true }).click();
    report.detailStatus = await request(root + '/status');
    const status = await section.evaluate((el: any) => el.status);
    report.detailRenderedStatus = status;
    await expect(section.locator('.fact-strip')).toContainText(pin.version);
    await expect(section.locator('.collection-facts')).toContainText(`发布 ${status.binding.published_revision} · 应用 ${status.binding.applied_revision}`);
    const visibleTimes = await section.locator('.collection-facts time').evaluateAll(times => times.map(t => t.getAttribute('datetime')));
    expect(visibleTimes).toEqual([status.collection.last_attempt_at, status.collection.last_success_at, status.formal_visibility.last_observed_at].filter(Boolean));
    expect(status.binding).toEqual(report.detailStatus.binding);
    expect(pin).toMatchObject(status.binding.package);
    expect(status.binding.published_revision).toBe(report.activation.resources[0].binding.revision);
    report.checks.detailPackageAndRevisions = true;
    await section.getByText('技术证据与配置版本', { exact: true }).click();
  }
  for (const width of [1440,390]) for (const mode of ['light','dark']) {
    await page.setViewportSize({ width, height: 1000 });
    await page.evaluate(mode => { document.documentElement.dataset.themeMode = mode; }, mode);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `${output}/detail-${width}-${mode}.png`, fullPage: true });
  }
  if (matrix) {
    await page.getByRole('tab', { name: '指标与趋势', exact: true }).click();
    const metrics = page.locator('semantic-metrics');
    await expect(metrics.locator('.summary-grid')).toBeVisible();
    const rendered = await metrics.evaluate((el: any) => el.result);
    report.detailMetrics = rendered;
    expect(rendered.configuration_revision).toBe(report.activation.resources[0].binding.revision);
    for (const id of ['custom.mysql.processlist_connections', 'custom.mysql.slow_queries_snapshot']) {
      const metric = rendered.metrics.find((m: any) => m.definition.id === id);
      const card = metrics.locator('.current').filter({has: page.getByRole('heading', {name:id, exact:true})});
      for (const series of metric.series) {
        const bucket = series.buckets.at(-1);
        await expect(card).toContainText(String(bucket?.value?.value ?? '未知'));
        await expect(card).toContainText(bucket.unit);
      }
    }
    report.checks.detailFormalValuesAndRevision = true;
    await captureMatrix(page, 'metrics-normal');
  }
  await page.goto(site + '/settings/monitoring/metrics?view=packages');
  await page.getByRole('tab', { name: '采集包', exact: true }).click();
  await expect(page.locator('metric-settings')).toContainText('MySQL 现有自定义指标');
  await page.screenshot({ path: `${output}/templates-formal.png`, fullPage: true });
  if (matrix) {
    const settings = page.locator('metric-settings');
    await settings.getByLabel('搜索采集包', { exact: true }).fill(pin.id);
    const row = settings.getByRole('row').filter({ hasText: 'MySQL 现有自定义指标' });
    await expect(row).toContainText(pin.version);
    await captureMatrix(page, 'templates-normal');
    await row.getByRole('button', { name: '查看模板', exact: true }).click();
    const detail = settings.locator('app-dialog');
    await detail.getByText('高级详情：原始 JSON', { exact: true }).click();
    const displayed = JSON.parse(await detail.locator('pre').innerText());
    expect(displayed.package).toEqual(pin);
    report.checks.settingsDigestVersionCoverage = true;
    await captureMatrix(page, 'template-detail');
    await page.keyboard.press('Escape');
    await expect(row.getByRole('button', { name: '查看模板', exact: true })).toBeFocused();
    report.checks.templateDialogFocusRestored = true;
  }
  if (matrix && process.env.MAX190_RESOURCE_MATRIX === '1') {
    for (const [type, route, tag, table, detailRoute] of [
      ['server', 'servers', 'servers-page', 'servers', 'server-detail'],
      ['network_device', 'network-devices', 'network-devices-page', 'network_devices', 'network-device-detail'],
    ]) {
      const id = report.fixtureResources[table][0];
      expect(id, `${type}: copied source resource`).toBeTruthy();
      await page.goto(`${site}/${route}`);
      const view = page.locator(tag);
      await expect(view.getByRole('button', {name:'编辑',exact:true})).toBeVisible();
      await captureMatrix(page, `${type}-list`);
      await view.getByRole('button', {name:'编辑',exact:true}).click();
      const shell = view.locator('resource-editor-shell');
      await expect(shell).toBeVisible();
      await expect(view.locator('app-dialog[title="编辑采集配置"]')).toHaveCount(0);
      await captureMatrix(page, `${type}-basic`);
      await shell.getByRole('tab', {name:'基本信息',exact:true}).focus();
      await page.keyboard.press('ArrowRight');
      await expect(shell.getByRole('tab', {name:'监控与采集',exact:true})).toBeFocused();
      const configuration = view.locator('metric-configuration');
      await expect(configuration.getByLabel('采集包 / 模板版本', {exact:true})).toBeVisible();
      await captureMatrix(page, `${type}-editor`);
      await configuration.getByLabel('采集间隔（秒）覆盖方式', {exact:true}).selectOption('set');
      await configuration.getByLabel('采集间隔（秒）', {exact:true}).fill('11');
      await shell.getByRole('tab', {name:'基本信息',exact:true}).click();
      const field = type === 'server' ? view.locator('app-form-field[label="标签 (可选)"] input') : view.locator('app-form-field[label="名称"] input');
      await field.fill('MAX-190 disposable connection edit');
      await view.getByRole('button', {name:'保存连接并配置采集',exact:true}).click();
      await expect(shell.getByRole('tab', {name:'监控与采集',exact:true})).toHaveAttribute('aria-selected','true');
      await expect(configuration.getByLabel('采集间隔（秒）', {exact:true})).toHaveValue('11');
      await shell.getByRole('button', {name:'返回资源列表',exact:true}).click();
      await expect(configuration.getByText('放弃未发布的修改？', {exact:true})).toBeVisible();
      await configuration.getByRole('button', {name:'继续编辑',exact:true}).click();
      await expect(configuration.getByLabel('采集间隔（秒）', {exact:true})).toHaveValue('11');
      await shell.getByRole('button', {name:'返回资源列表',exact:true}).click();
      await configuration.getByRole('button', {name:'放弃修改并继续',exact:true}).click();
      await expect(view.getByRole('button', {name:'编辑',exact:true})).toBeFocused();
      await view.getByRole('button', {name:'详情',exact:true}).click();
      await page.getByRole('tab', {name:'采集配置',exact:true}).click();
      const section = page.locator('resource-collection-section');
      await expect(section.locator('.fact-strip')).toBeVisible();
      await captureMatrix(page, `${type}-detail`);
      await section.getByRole('button', {name:'修改监控与采集 →',exact:true}).click();
      await expect(page.locator('resource-editor-shell').getByRole('tab', {name:'监控与采集',exact:true})).toHaveAttribute('aria-selected', 'true');
      await expect(page.locator('metric-configuration').getByLabel('采集包 / 模板版本', {exact:true})).toBeVisible();
      report.checks[`${type}InlineEditorNavigationFocusAndDiscard`] = true;
      await save();
    }
  }
  report.checks.listDetailSettings = true;
  expect(await snapshot()).toBe(sourceDigest); report.checks.originalConfigurationUnchanged = true; await save();
});
