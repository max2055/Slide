import { test, expect, type Page } from '@playwright/test';
import { createServer } from 'node:http';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startInvestigationServer } from './fixtures/investigation-server.ts';

// Product UI -> JWT + live SQL authorization -> formal routes/services.
// SQL resource observations and local HTTP Git are fixtures; no model/SSH/SNMP.
let env: Awaited<ReturnType<typeof startInvestigationServer>>;
let actor: Awaited<ReturnType<typeof env.contexts.loadActiveActor>>;
let reader: typeof actor;
let root: string, origin: string, commit: string;
let upstream: ReturnType<typeof createServer>;
const saved = new Map<string, string | undefined>();
const output = process.env.MAX157_OUTPUT_DIR ?? '/Users/max/Coding/40-Slide/outputs/max157-ui-acceptance';

test.beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'slide-max157-'));
  const repo = join(root, 'group/repo.git'); await mkdir(join(repo, 'src'), { recursive: true });
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: 'pipe' }).trim();
  git('init', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.test');
  for (let i = 0; i < 61; i++) await writeFile(join(repo, 'src', `collector-${i}.ts`), `export const index = ${i};\n`);
  await writeFile(join(repo, 'manifest.json'), '{"fixture":true}');
  git('add', '.'); git('commit', '-m', 'local acceptance'); commit = git('rev-parse', 'HEAD');
  upstream = createServer((req, res) => {
    const url = new URL(req.url!, 'http://fixture');
    const child = spawn('git', ['http-backend'], { env: { ...process.env, GIT_PROJECT_ROOT: root, GIT_HTTP_EXPORT_ALL: '1', PATH_INFO: url.pathname,
      QUERY_STRING: url.search.slice(1), REQUEST_METHOD: req.method, CONTENT_TYPE: req.headers['content-type'] ?? '', REMOTE_USER: 'fixture' } });
    req.pipe(child.stdin); child.stdin.on('error', () => {}); child.stderr.resume();
    const chunks: Buffer[] = []; child.stdout.on('data', chunk => chunks.push(chunk));
    child.on('close', code => {
      const data = Buffer.concat(chunks), boundary = data.indexOf('\r\n\r\n');
      if (code !== 0 || boundary < 0) { res.writeHead(500); res.end(); return; }
      for (const line of data.subarray(0, boundary).toString().split('\r\n')) {
        const colon = line.indexOf(':'); if (colon < 0) continue;
        const name = line.slice(0, colon), value = line.slice(colon + 1).trim();
        if (name.toLowerCase() === 'status') res.statusCode = Number(value.split(' ')[0]); else res.setHeader(name, value);
      }
      res.end(data.subarray(boundary + 4));
    });
  });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
  const overrides = { SLIDE_GITLAB_ORIGINS: origin, SLIDE_SOURCE_ROOT: join(root, 'snapshots'), SLIDE_SOURCE_SIGNING_KEY: randomUUID() + randomUUID(),
    SLIDE_RELEASE_MANIFEST: '', SLIDE_RELEASE_ID: '', SLIDE_COMMIT_SHA: '', SLIDE_SOURCE_DIGEST: '' };
  for (const [key, value] of Object.entries(overrides)) { saved.set(key, process.env[key]); process.env[key] = value; }
  env = await startInvestigationServer({ resourcePilot: true, uiAcceptance: true });
  await env.pool.query("INSERT IGNORE INTO permissions (code,name,resource,action) VALUES ('*','Fixture admin','admin','all'),('view_dashboard','Dashboard','dashboard','view')");
  await env.pool.query("INSERT IGNORE INTO role_permissions (role_id,permission_id) SELECT 101,id FROM permissions");
  actor = await env.contexts.loadActiveActor(101);
  await env.pool.query("INSERT INTO users (id,username,password_hash) VALUES (103,'ui-reader','no-login')");
  await env.pool.query("INSERT INTO roles (id,name) VALUES (103,'ui-readonly')");
  await env.pool.query('INSERT INTO user_roles (user_id,role_id) VALUES (103,103)');
  await env.pool.query("INSERT INTO role_permissions (role_id,permission_id) SELECT 103,id FROM permissions WHERE code IN ('servers:view','network_devices:view','metric:view','view_dashboard','config:view','chat:view','ai:view')");
  reader = await env.contexts.loadActiveActor(103);
  const headers = { Authorization: `Bearer ${env.token(actor)}`, 'Content-Type': 'application/json' };
  const config = await fetch(`${env.apiUrl}/api/platform/source/config`, { method: 'PUT', headers,
    body: JSON.stringify({ provider: 'gitlab', baseUrl: origin, repositoryPath: 'group/repo', ref: 'main', allowedPaths: [], allowModelContent: false }) });
  expect(config.status).toBe(200);
  const sync = await fetch(`${env.apiUrl}/api/platform/source/sync`, { method: 'POST', headers, body: JSON.stringify({ token: 'local-fixture-only' }) });
  expect(sync.status).toBe(200);
  await env.pool.query('INSERT INTO metrics_history (instance_id,cpu_usage,memory_usage,connections,qps,recorded_at) VALUES (101,92.4,57.1,410,200,NOW())');
  await env.pool.query("INSERT INTO resource_relations (source_type,source_id,target_type,target_id,relation_type,provenance,valid_from) VALUES ('instance',101,'server',101,'runs_on','fixture_configuration',NOW())");
  await mkdir(output, { recursive: true });
});
test.afterAll(async () => {
  try { if (env) { expect(env.counts()).toEqual({ toolCalls: 0, providerCalls: 0 }); await env.close(); } }
  finally {
    if (upstream) { upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve())); }
    for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    if (root) await rm(root, { recursive: true, force: true });
  }
});
async function login(page: Page, theme = 'dark', currentActor = actor) {
  await page.addInitScript(({ token, permissions, theme }) => {
    localStorage.setItem('token', token); localStorage.setItem('permissions', JSON.stringify(permissions));
    localStorage.setItem('user', JSON.stringify({ id: 101, username: 't06-owner' }));
    localStorage.setItem('slide.i18n.locale', 'zh-CN'); localStorage.setItem('app-theme-mode', theme);
    localStorage.setItem('slide.control.settings.v1:default', JSON.stringify({ theme: 'claw', themeMode: theme, locale: 'zh-CN' }));
  }, { token: env.token(currentActor), permissions: currentActor.permissions, theme });
}
async function capture(page: Page, name: string) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `${output}/${name}-real-service.png`, fullPage: true, animations: 'disabled' });
}

test('real source save -> HTTP Git sync -> SQL manifest -> detail search/paging -> metadata -> reload', async ({ page }) => {
  await login(page); await page.goto(`${env.url}/settings/platform/source`);
  const view = page.locator('source-settings');
  await view.getByText('仓库配置与同步', { exact: true }).click();
  await view.getByLabel('GitLab URL', { exact: true }).fill(origin);
  await view.getByLabel('仓库路径', { exact: true }).fill('group/repo');
  await view.getByLabel('分支、标签或 Commit', { exact: true }).fill('main');
  await view.getByRole('button', { name: '保存配置', exact: true }).click(); await expect(view).toContainText('配置已保存');
  await view.getByLabel('同步令牌', { exact: true }).fill('local-fixture-only');
  await view.getByRole('button', { name: '同步源码', exact: true }).click();
  await expect(view).toContainText('部分同步完成'); await expect(view.getByLabel('同步令牌', { exact: true })).toHaveValue('');
  await view.getByText('仓库配置与同步', { exact: true }).click();
  await capture(page, 'source-1280-dark');
  const manifest = page.locator('source-manifest');
  await manifest.getByRole('button', { name: '浏览快照 →' }).click(); await expect(manifest.locator('tbody tr')).toHaveCount(10);
  await manifest.getByRole('combobox', { name: '每页文件数' }).selectOption('25'); await expect(manifest.locator('tbody tr')).toHaveCount(25);
  await manifest.getByRole('searchbox').fill('collector-60.ts'); await expect(manifest.locator('tbody tr')).toHaveCount(1);
  await manifest.getByRole('button', { name: '版本元数据', exact: true }).click(); await expect(manifest.locator('app-dialog')).toContainText(commit);
  await capture(page, 'source-metadata-1280-dark');
  await page.keyboard.press('Escape'); await expect(manifest.getByRole('button', { name: '版本元数据', exact: true })).toBeFocused();
  await page.reload(); await expect(manifest.getByRole('searchbox')).toHaveValue('collector-60.ts');
  await manifest.getByRole('tab', { name: /^文件/ }).focus(); await page.keyboard.press('ArrowRight');
  await expect(manifest.getByRole('tab', { name: /已跳过/ })).toHaveAttribute('aria-selected', 'true'); await expect(manifest).toContainText('manifest.json');
  await capture(page, 'source-detail-1280-dark');
  await manifest.getByRole('button', { name: '返回源码仓库' }).click(); await expect(page).not.toHaveURL(/sourceView=details/);
  await page.goBack(); await expect(manifest.getByRole('tab', { name: /已跳过/ })).toHaveAttribute('aria-selected', 'true');
});

test('real resource overview/navigation, database help and diagnosis evidence/relations do zero model calls', async ({ page }) => {
  await login(page); await page.goto(`${env.url}/dashboard`);
  await expect(page.locator('dashboard-page')).toContainText('合成资源');
  const names = await page.locator('.nav-item').allTextContents();
  const positions = ['资源概览', '网络设备', '服务器', '数据库'].map(name => names.findIndex(item => item.trim() === name));
  expect(positions.every(index => index >= 0)).toBe(true); expect(positions).toEqual([...positions].sort((a, b) => a - b));
  await expect(page.getByRole('link', { name: '对话', exact: true })).toBeVisible();
  await capture(page, 'navigation-overview-1280-dark');
  await page.goto(`${env.url}/instances-db`); const metrics = page.locator('resource-metrics-table');
  await expect(metrics).toContainText('合成资源');
  const help = metrics.getByRole('button', { name: /数据库大小.*说明/ }); await help.click();
  await expect(metrics.locator('app-dialog[title="数据库大小：支持范围与统计口径"]')).toContainText('Redis 内存不计为磁盘大小');
  await capture(page, 'database-help-1280-dark'); await page.keyboard.press('Escape'); await expect(help).toBeFocused();
  await capture(page, 'database-1280-dark');
  await page.goto(`${env.url}/resource-diagnosis?resourceType=instance&resourceId=101`);
  const view = page.locator('resource-diagnosis-page');
  await expect(view).toContainText('92.4'); await capture(page, 'diagnosis-1280-dark');
  await view.getByRole('tab', { name: '当前证据' }).focus(); await page.keyboard.press('ArrowRight');
  await expect(view.getByRole('tab', { name: '规则评估' })).toHaveAttribute('aria-selected', 'true');
  await view.getByRole('button', { name: /获取关联证据/ }).click(); await expect(view.getByRole('link', { name: '切换诊断 →' })).toBeVisible();
  await capture(page, 'diagnosis-relations-1280-dark');
  await view.getByRole('link', { name: '切换诊断 →' }).click(); await expect(page).toHaveURL(/resourceType=server/);
  await view.getByRole('button', { name: /返回 合成资源/ }).click(); await expect(page).toHaveURL(/resourceType=instance/);
  expect(env.counts()).toEqual({ toolCalls: 0, providerCalls: 0 });
});

test('live reader permissions filter resources, retain evidence browsing and revoke Profile detail', async ({ page }) => {
  await login(page, 'light', reader); await page.goto(`${env.url}/dashboard`);
  await expect(page.getByRole('link', { name: '数据库', exact: true })).toHaveCount(0);
  await expect(page.locator('dashboard-page')).not.toContainText('合成资源');
  await expect(page.locator('dashboard-page')).toContainText('服务器受控夹具');
  await page.reload(); await expect(page.getByRole('link', { name: '资源概览', exact: true })).toHaveClass(/active/);
  await page.goto(`${env.url}/attention`); await expect(page.locator('attention-page').locator('dashboard-page')).toHaveCount(0);
  await page.goBack(); await expect(page.locator('dashboard-page')).toBeVisible();
  await page.goto(`${env.url}/resource-diagnosis?resourceType=server&resourceId=101`);
  const view = page.locator('resource-diagnosis-page');
  await expect(view).toContainText('服务器受控夹具'); await expect(view.getByRole('button', { name: '开始只读诊断' })).toHaveCount(0);
  await expect(view.getByRole('tab', { name: '当前证据' })).toBeVisible(); await capture(page, 'diagnosis-readonly-1280-light');
  await page.goto(`${env.url}/settings/ai/profiles`); const profiles = page.locator('investigation-profiles-page');
  await profiles.getByRole('button', { name: '查看资源调查预置详情 →' }).click();
  await expect(profiles.locator('app-dialog')).toContainText('执行限制'); await page.keyboard.press('Escape');
  await env.pool.query("DELETE rp FROM role_permissions rp JOIN permissions p ON p.id=rp.permission_id WHERE rp.role_id=103 AND p.code='ai:view'");
  try {
    const rejected = page.waitForResponse(r => r.url().endsWith('/api/investigation-profiles') && r.status() === 403);
    await profiles.getByRole('button', { name: '刷新 Profiles' }).click(); await rejected;
    await expect(profiles.getByRole('alert')).toContainText('无权访问'); await expect(profiles.locator('app-data-table')).toHaveCount(0);
  } finally { await env.pool.query("INSERT INTO role_permissions (role_id,permission_id) SELECT 103,id FROM permissions WHERE code='ai:view'"); }
});

for (const width of [1280, 390]) for (const theme of ['dark', 'light']) test(`real profiles/governance/source/diagnosis pages ${width}px ${theme}`, async ({ page }) => {
  await login(page, theme); await page.setViewportSize({ width, height: 950 });
  for (const [name, path, selector] of [
    ['profiles', '/settings/ai/profiles', 'investigation-profiles-page'], ['policies', '/settings/ai/policies', 'investigation-governance-page'],
    ['budget', '/settings/ai/budget', 'investigation-governance-page'], ['usage', '/settings/ai/usage', 'investigation-governance-page'],
    ['source', '/settings/platform/source', 'source-manifest'], ['diagnosis', '/resource-diagnosis?resourceType=instance&resourceId=101', 'resource-diagnosis-page'],
  ]) {
    await page.goto(env.url + path); await expect(page.locator('html')).toHaveAttribute('data-theme-mode', theme);
    await expect.poll(() => page.locator(selector).evaluate((e: any) => e.loading)).toBe(false);
    await expect(page.locator(selector).getByRole('alert')).toHaveCount(0);
    await capture(page, `${name}-${width}-${theme}`);
  }
});
