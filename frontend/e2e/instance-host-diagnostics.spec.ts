import { expect, test, type Page, type TestInfo } from '@playwright/test';
import type {
  InstanceHostEvidenceResponse,
  InstanceHostsResponse,
  ReplaceInstanceHostsResponse,
} from '../src/api/generated/public-api.js';

const ADMIN_PASSWORD = process.env.QUALIFICATION_ADMIN_PASSWORD ?? 'Tpam1234';
const HOST_KEY_FINGERPRINT = 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

interface AuthContext {
  headers: { Authorization: string };
}

interface ExpectedHttpFailure {
  method: string;
  pathname: string;
  status: number;
}

function responsePath(url: string): string {
  return new URL(url).pathname;
}

async function authenticate(page: Page): Promise<AuthContext> {
  const login = await page.request.post('/api/auth/login', {
    data: { username: 'admin', password: ADMIN_PASSWORD },
  });
  expect(login.status()).toBe(200);
  const auth = await login.json() as { token: string; refreshToken: string };
  const headers = { Authorization: `Bearer ${auth.token}` };
  const permissionResponse = await page.request.get('/api/auth/permissions', { headers });
  expect(permissionResponse.status()).toBe(200);
  const permissions = await permissionResponse.json() as string[];
  expect(permissions).toEqual(expect.arrayContaining(['servers:view', 'servers:manage']));

  await page.addInitScript(({ token, refreshToken, permissions }) => {
    localStorage.setItem('token', token);
    localStorage.setItem('refreshToken', refreshToken);
    localStorage.setItem('permissions', JSON.stringify(permissions));
    localStorage.setItem('slide.control.session_token.v1', token);
    localStorage.setItem('slide.control.settings.v1:default', JSON.stringify({ locale: 'zh-CN' }));
  }, { ...auth, permissions });

  return { headers };
}

function startBrowserAudit(
  page: Page,
  isExpectedFailure: (failure: ExpectedHttpFailure) => boolean = () => false,
) {
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  const responseErrors: string[] = [];
  const requestFailures: string[] = [];
  const trackedApi = /^\/api\/(?:database\/instances(?:\/|$)|servers(?:\/|$)|ai\/analysis(?:\/|$))/;

  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const text = message.text();
    if (/uncaught|typeerror|referenceerror|syntaxerror|failed to load module|cannot read .* of undefined|is not defined/i.test(text)) {
      consoleErrors.push(text);
    }
  });
  page.on('response', (response) => {
    if (response.status() < 400) return;
    const pathname = responsePath(response.url());
    if (!trackedApi.test(pathname)) return;
    const failure = {
      method: response.request().method(),
      pathname,
      status: response.status(),
    };
    if (!isExpectedFailure(failure)) {
      responseErrors.push(`${failure.status} ${failure.method} ${failure.pathname}`);
    }
  });
  page.on('requestfailed', (request) => {
    const pathname = responsePath(request.url());
    if (trackedApi.test(pathname)) {
      requestFailures.push(`${request.method()} ${pathname}: ${request.failure()?.errorText ?? 'unknown failure'}`);
    }
  });

  return {
    assertClean() {
      expect(pageErrors, 'uncaught page errors').toEqual([]);
      expect(consoleErrors, 'critical browser console errors').toEqual([]);
      expect(responseErrors, 'unexpected target API responses').toEqual([]);
      expect(requestFailures, 'failed target API requests').toEqual([]);
    },
  };
}

function uniqueResourceNames(testInfo: TestInfo, viewport: string) {
  const now = Date.now();
  const suffix = `${now}-w${testInfo.workerIndex}`;
  const instanceName = (`e2e-${viewport}-${suffix}-` + 'instance-host-diagnostics-'.repeat(3)).slice(0, 98);
  const serverLabel = `e2e-${viewport}-${suffix}-${'linux-host-with-an-intentionally-long-label-'.repeat(3)}`;
  const thirdOctet = ((Math.floor(now / 251) + testInfo.workerIndex) % 240) + 1;
  const fourthOctet = (now % 240) + 1;
  return {
    instanceName,
    serverLabel,
    serverHost: `10.248.${thirdOctet}.${fourthOctet}`,
  };
}

function hostEvidencePayload(
  instanceId: number,
  serverId: number,
  instanceName: string,
  serverHost: string,
  serverLabel: string,
) {
  const longMount = `/srv/mysql/${'production-data-segment/'.repeat(7)}mount`;
  const longPhysicalPath = `${longMount}/${'nested-database-directory/'.repeat(6)}ibdata1`;
  const longStoragePath = `/var/lib/mysql/${'tablespace-with-a-long-operational-name/'.repeat(6)}primary.ibd`;
  const longJournal = `mysqld checkpoint warning: ${'deterministic journal detail for responsive layout validation '.repeat(8)}`;
  const collectedAt = '2026-08-10T08:00:00.000Z';
  const filesystem = {
    mount: longMount,
    device: `/dev/mapper/${'database-volume-group-'.repeat(5)}logical-volume`,
    fsType: 'xfs',
    sizeBytes: 1_099_511_627_776,
    usedBytes: 824_633_720_832,
    availableBytes: 274_877_906_944,
    usagePercent: 75,
    inodeTotal: 8_000_000,
    inodeUsed: 2_000_000,
    inodeAvailable: 6_000_000,
    inodeUsagePercent: 25,
  };
  const payload: InstanceHostEvidenceResponse = {
    schemaVersion: 1,
    subject: { type: 'instance', id: instanceId },
    collectedAt,
    database: {
      instance: { id: instanceId, name: instanceName, db_type: 'mysql' },
      realtimeMetrics: { connections: 17, qps: 42 },
      metricHistory: [{ metric_name: 'connections', metric_value: 17, recorded_at: collectedAt }],
      alerts: [],
      logs: [],
      slowQueries: [],
    },
    storage: [{
      path: longStoragePath,
      kind: 'datafile',
      source: 'mysql.innodb_data_file_path',
      hostInspectable: true,
      objectName: 'primary-operational-tablespace',
      logicalBytes: 536_870_912,
    }],
    hosts: [{
      server: {
        serverId,
        role: 'primary',
        notes: 'managed E2E primary host',
        host: serverHost,
        port: 22,
        label: serverLabel,
        osType: 'Linux',
        status: 'offline',
        collectionEnabled: true,
        validFrom: collectedAt,
      },
      evidence: {
        schemaVersion: 1,
        serverId,
        collectedAt,
        expiresAt: '2099-01-01T00:00:00.000Z',
        quality: 'partial',
        truncated: false,
        metrics: {
          source: ['server_metrics'],
          collectedAt,
          quality: 'good',
          values: { cpu_usage: 42.5, memory_usage: 73.2, load_1min: 1.25 },
        },
        filesystems: {
          source: ['df', 'findmnt'],
          collectedAt,
          quality: 'good',
          items: [filesystem],
        },
        systemLogs: {
          source: ['journalctl:mysqld.service'],
          collectedAt,
          quality: 'partial',
          reason: 'JOURNAL_WINDOW_PARTIAL',
          entries: [{
            timestamp: collectedAt,
            severity: 'warning',
            unit: 'mysqld.service',
            identifier: 'mysqld',
            pid: '4242',
            message: longJournal,
          }],
        },
        physicalFiles: {
          source: ['stat', 'df'],
          collectedAt,
          quality: 'good',
          items: [{
            path: longPhysicalPath,
            quality: 'good',
            type: 'regular file',
            sizeBytes: 8_589_934_592,
            allocatedBytes: 8_589_934_592,
            modifiedAt: collectedAt,
            mode: '660',
            owner: 'mysql',
            group: 'mysql',
            filesystem,
          }],
        },
        gaps: [{ section: 'systemLogs', reason: 'JOURNAL_WINDOW_PARTIAL' }],
      },
    }],
    gaps: [{
      scope: 'host',
      section: 'hostEvidence',
      code: 'HOST_EVIDENCE_PARTIAL_TEST',
      resource: { type: 'server', id: serverId },
      source: 'journalctl',
    }],
  };
  return { payload, longJournal, longMount, longPhysicalPath, longStoragePath };
}

async function expectNoDocumentOverflow(page: Page, label: string) {
  const dimensions = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(dimensions.scrollWidth, `${label} document width ${JSON.stringify(dimensions)}`).toBeLessThanOrEqual(dimensions.innerWidth);
}

async function expectElementsWithinViewport(page: Page, selector: string, label: string) {
  const measurements = await page.locator(selector).evaluateAll((elements) => elements
    .filter((element) => {
      const style = window.getComputedStyle(element);
      return style.display !== 'none' && style.visibility !== 'hidden';
    })
    .map((element) => {
      const htmlElement = element as HTMLElement;
      const rect = htmlElement.getBoundingClientRect();
      return {
        text: htmlElement.textContent?.trim() ?? '',
        left: rect.left,
        right: rect.right,
        clientWidth: htmlElement.clientWidth,
        scrollWidth: htmlElement.scrollWidth,
        viewportWidth: window.innerWidth,
      };
    }));

  expect(measurements.length, `${label} matched elements`).toBeGreaterThan(0);
  for (const measurement of measurements) {
    expect(measurement.left, `${label} left edge ${JSON.stringify(measurement)}`).toBeGreaterThanOrEqual(0);
    expect(measurement.right, `${label} right edge ${JSON.stringify(measurement)}`).toBeLessThanOrEqual(measurement.viewportWidth);
    expect(measurement.scrollWidth, `${label} content width ${JSON.stringify(measurement)}`).toBeLessThanOrEqual(measurement.clientWidth + 1);
  }
}

async function cleanupManagedResources(
  page: Page,
  headers: AuthContext['headers'],
  instanceId?: number,
  serverId?: number,
) {
  if (instanceId && serverId) {
    await page.request.delete(`/api/database/instances/${instanceId}/hosts/${serverId}`, { headers }).catch(() => undefined);
  }
  if (instanceId) {
    await page.request.delete(`/api/database/instances/${instanceId}`, { headers }).catch(() => undefined);
  }
  if (serverId) {
    await page.request.delete(`/api/servers/${serverId}`, { headers }).catch(() => undefined);
  }
}

const managedViewports = [
  { name: 'desktop-1440', width: 1440, height: 900 },
  { name: 'mobile-390x844', width: 390, height: 844 },
] as const;

for (const viewport of managedViewports) {
  test(`managed instance host diagnostics render and navigate at ${viewport.name}`, async ({ page }, testInfo) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    const auth = await authenticate(page);
    const names = uniqueResourceNames(testInfo, viewport.name);
    let serverId: number | undefined;
    let instanceId: number | undefined;

    try {
      const createdServer = await page.request.post('/api/servers', {
        headers: auth.headers,
        data: {
          host: names.serverHost,
          port: 22,
          label: names.serverLabel,
          os_type: 'Linux',
          credential_type: 'password',
          credential_username: 'qualification-e2e',
          credential_value: 'not-used-by-this-test',
          host_key_fingerprint: HOST_KEY_FINGERPRINT,
        },
      });
      const serverBody = await createdServer.json();
      expect(createdServer.status(), JSON.stringify(serverBody)).toBe(200);
      serverId = Number(serverBody.id);
      expect(serverId).toBeGreaterThan(0);

      const createdInstance = await page.request.post('/api/database/instances', {
        headers: auth.headers,
        data: {
          name: names.instanceName,
          environment: 'testing',
          db_type: 'mysql',
          host: names.serverHost,
          port: 3306,
          username: 'qualification_e2e',
          password: 'not-used-by-this-test',
          database_name: 'db_ops_ai_qualification',
          description: `Responsive host diagnostics fixture ${'with long descriptive context '.repeat(5)}`,
        },
      });
      const instanceBody = await createdInstance.json();
      expect(createdInstance.status(), JSON.stringify(instanceBody)).toBe(200);
      instanceId = Number(instanceBody.id);
      expect(instanceId).toBeGreaterThan(0);

      const expectedOfflineInstanceFailure = ({ method, pathname, status }: ExpectedHttpFailure) => (
        method === 'GET'
        && status >= 400
        && (pathname === `/api/database/instances/${instanceId}/metrics`
          || pathname === `/api/database/instances/${instanceId}/topsql`)
      );
      const audit = startBrowserAudit(page, expectedOfflineInstanceFailure);
      const evidence = hostEvidencePayload(instanceId, serverId, names.instanceName, names.serverHost, names.serverLabel);
      await page.route(`**/api/database/instances/${instanceId}/host-evidence`, async (route) => {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(evidence.payload) });
      });

      const analysisId = 900_000 + testInfo.workerIndex;
      let diagnosisBody: Record<string, unknown> | null = null;
      let diagnosisPolls = 0;
      await page.route('**/api/ai/analysis', async (route) => {
        if (route.request().method() !== 'POST') return route.fallback();
        diagnosisBody = route.request().postDataJSON() as Record<string, unknown>;
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ id: analysisId, status: 'running', session_key: `diagnosis-${analysisId}` }),
        });
      });
      await page.route('**/api/ai/analysis/status/*', async (route) => {
        diagnosisPolls += 1;
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            ok: true,
            record: {
              id: analysisId,
              analysis_type: 'fault_diagnosis',
              instance_id: instanceId,
              status: 'completed',
              created_at: '2026-08-10T08:00:00.000Z',
              updated_at: '2026-08-10T08:00:02.000Z',
              result: '## 确定性诊断结果\n\n主机证据链完整，未调用真实 LLM。',
              error_message: null,
              duration_ms: 2_000,
            },
          }),
        });
      });

      const mutationOrder: string[] = [];
      page.on('request', (request) => {
        const pathname = responsePath(request.url());
        if (request.method() === 'PUT' && (
          pathname === `/api/database/instances/${instanceId}`
          || pathname === `/api/database/instances/${instanceId}/hosts`
        )) mutationOrder.push(pathname);
      });

      await page.goto('/instances-db');
      const instancesPage = page.locator('instances-page');
      await expect(instancesPage).toBeVisible({ timeout: 15_000 });
      const instanceRow = instancesPage.locator('.instance-row').filter({ hasText: names.instanceName });
      await expect(instanceRow).toBeVisible({ timeout: 15_000 });

      const relationRead = page.waitForResponse((response) => (
        response.request().method() === 'GET'
        && responsePath(response.url()) === `/api/database/instances/${instanceId}/hosts`
      ));
      await instanceRow.getByRole('button', { name: '编辑', exact: true }).click();
      expect((await relationRead).status()).toBe(200);
      const editDialog = instancesPage.locator('app-dialog[title="编辑数据库实例"]');
      await expect(editDialog.locator('[role="dialog"]')).toBeVisible();
      const hostOption = editDialog.locator('instance-host-field .host-option').filter({ hasText: names.serverLabel });
      await expect(hostOption).toBeVisible({ timeout: 10_000 });
      await hostOption.locator('input[type="checkbox"]').check();
      await hostOption.locator(`select[data-server-id="${serverId}"]`).selectOption('primary');

      const baseWrite = page.waitForResponse((response) => (
        response.request().method() === 'PUT'
        && responsePath(response.url()) === `/api/database/instances/${instanceId}`
      ));
      const hostWrite = page.waitForResponse((response) => (
        response.request().method() === 'PUT'
        && responsePath(response.url()) === `/api/database/instances/${instanceId}/hosts`
      ));
      await editDialog.getByRole('button', { name: '保存修改', exact: true }).click();
      expect((await baseWrite).status()).toBe(200);
      const hostWriteResponse = await hostWrite;
      expect(hostWriteResponse.status()).toBe(200);
      expect(hostWriteResponse.request().postDataJSON()).toEqual({ hosts: [{ serverId, role: 'primary' }] });
      const hostWriteBody = await hostWriteResponse.json() as ReplaceInstanceHostsResponse;
      expect(hostWriteBody).toMatchObject({
        ok: true,
        hosts: [{ serverId, role: 'primary' }],
      });
      expect(mutationOrder).toEqual([
        `/api/database/instances/${instanceId}`,
        `/api/database/instances/${instanceId}/hosts`,
      ]);
      await expect(editDialog).toBeHidden();

      const detailHostsRead = page.waitForResponse((response) => (
        response.request().method() === 'GET'
        && responsePath(response.url()) === `/api/database/instances/${instanceId}/hosts`
      ));
      const evidenceRead = page.waitForResponse((response) => (
        response.request().method() === 'GET'
        && responsePath(response.url()) === `/api/database/instances/${instanceId}/host-evidence`
      ));
      await instanceRow.getByRole('button', { name: '详情', exact: true }).click();
      const detailHostsResponse = await detailHostsRead;
      expect(detailHostsResponse.status()).toBe(200);
      const detailHostsBody = await detailHostsResponse.json() as InstanceHostsResponse;
      expect(detailHostsBody).toMatchObject({ hosts: [{ serverId, role: 'primary' }] });
      expect((await evidenceRead).status()).toBe(200);

      const instanceDetail = page.locator('instance-detail-page');
      await expect(instanceDetail.locator('.instance-title')).toHaveText(names.instanceName, { timeout: 15_000 });
      const hostSummary = instanceDetail.locator('instance-host-summary');
      await expect(hostSummary).toContainText(names.serverLabel);
      await expect(hostSummary.locator('[data-freshness="fresh"]')).toContainText('证据新鲜');
      await expect(hostSummary).toContainText('主节点');
      await expect(hostSummary).toContainText('42.5%');
      await expect(hostSummary).toContainText('73.2%');
      await expect(hostSummary).toContainText('1.25');
      await expect(hostSummary).toContainText('文件系统');
      await expect(hostSummary).toContainText(evidence.longMount);
      await expect(hostSummary).toContainText('mysqld.service');
      await expect(hostSummary).toContainText(evidence.longJournal);
      await expect(hostSummary).toContainText('物理数据文件');
      await expect(hostSummary).toContainText(evidence.longPhysicalPath);
      await expect(hostSummary).toContainText('数据库物理路径');
      await expect(hostSummary).toContainText(evidence.longStoragePath);
      await expect(hostSummary).toContainText('JOURNAL_WINDOW_PARTIAL');
      await expect(hostSummary).toContainText('HOST_EVIDENCE_PARTIAL_TEST');
      await expectNoDocumentOverflow(page, `${viewport.name} instance detail`);
      await expectElementsWithinViewport(
        page,
        'instance-detail-page .header .instance-title, instance-detail-page .header button',
        `${viewport.name} instance header`,
      );
      const instanceScreenshot = testInfo.outputPath(`instance-host-diagnostics-${viewport.name}-instance-detail.png`);
      await page.screenshot({ path: instanceScreenshot, fullPage: true });

      await page.goto('/servers');
      const serversPage = page.locator('servers-page');
      await expect(serversPage).toBeVisible({ timeout: 15_000 });
      const serverRow = serversPage.locator('app-data-table tbody tr').filter({ hasText: names.serverHost });
      await expect(serverRow).toBeVisible({ timeout: 15_000 });
      const reverseRead = page.waitForResponse((response) => (
        response.request().method() === 'GET'
        && responsePath(response.url()) === `/api/servers/${serverId}/instances`
      ));
      await serverRow.getByRole('button', { name: '详情', exact: true }).click();
      expect((await reverseRead).status()).toBe(200);

      const serverDetail = page.locator('server-detail');
      await expect(serverDetail.locator('.server-title')).toHaveText(names.serverHost, { timeout: 15_000 });
      const hostedInstance = serverDetail.locator('.hosted-instance').filter({ hasText: names.instanceName });
      await expect(hostedInstance).toBeVisible();
      await expect(hostedInstance).toContainText('主节点');
      await expectNoDocumentOverflow(page, `${viewport.name} server detail`);
      const serverScreenshot = testInfo.outputPath(`instance-host-diagnostics-${viewport.name}-server-detail.png`);
      await page.screenshot({ path: serverScreenshot, fullPage: true });

      await hostedInstance.locator(`[data-instance-id="${instanceId}"]`).click();
      await expect(page).toHaveURL((url) => (
        url.pathname === '/instance-detail'
        && url.searchParams.get('id') === String(instanceId)
      ));
      await expect(page.locator('instance-detail-page .instance-title')).toHaveText(names.instanceName, { timeout: 15_000 });

      const diagnosisPost = page.waitForResponse((response) => (
        response.request().method() === 'POST'
        && responsePath(response.url()) === '/api/ai/analysis'
      ));
      await page.locator('instance-detail-page').getByRole('button', { name: '一键诊断', exact: true }).click();
      expect((await diagnosisPost).status()).toBe(200);
      expect(diagnosisBody).toEqual({
        analysis_type: 'fault_diagnosis',
        instance_id: instanceId,
        trigger_type: 'manual',
      });
      const diagnosisModal = page.locator('instance-diagnosis-modal');
      await expect(diagnosisModal.getByText('AI 诊断分析中...', { exact: true })).toBeVisible({ timeout: 1_500 });
      const diagnosisResult = diagnosisModal.locator('ai-analysis-result[status="completed"]');
      await expect(diagnosisResult).toBeVisible({ timeout: 5_000 });
      await expect(diagnosisResult).toContainText('AI 诊断结果');
      await expect(diagnosisResult).toContainText('确定性诊断结果');
      expect(diagnosisPolls).toBeGreaterThan(0);

      audit.assertClean();
    } finally {
      await cleanupManagedResources(page, auth.headers, instanceId, serverId);
    }
  });
}

test('partial create locks base fields and retries only the host relation', async ({ page }, testInfo) => {
  test.setTimeout(45_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await authenticate(page);
  const suffix = `${Date.now()}-w${testInfo.workerIndex}`;
  const instanceName = `e2e-partial-${suffix}`;
  const serverLabel = `e2e-partial-host-${suffix}`;
  const fakeServerId = 70_000 + testInfo.workerIndex;
  const fakeInstanceId = 80_000 + testInfo.workerIndex;
  const sequence: string[] = [];
  const postBodies: unknown[] = [];
  const relationBodies: unknown[] = [];
  let relationWrites = 0;

  const audit = startBrowserAudit(page, ({ method, pathname, status }) => (
    method === 'PUT'
    && pathname === `/api/database/instances/${fakeInstanceId}/hosts`
    && status === 500
  ));

  await page.route('**/api/database/instances', async (route) => {
    const method = route.request().method();
    if (method === 'GET') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
    }
    if (method === 'POST') {
      sequence.push('POST');
      postBodies.push(route.request().postDataJSON());
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ id: fakeInstanceId, message: 'created' }),
      });
    }
    return route.fallback();
  });
  await page.route('**/api/servers', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{
        id: fakeServerId,
        host: '10.248.200.200',
        port: 22,
        label: serverLabel,
        os_type: 'Linux',
        status: 'online',
        collection_enabled: 1,
      }]),
    });
  });
  await page.route(`**/api/database/instances/${fakeInstanceId}/hosts`, async (route) => {
    if (route.request().method() !== 'PUT') return route.fallback();
    relationWrites += 1;
    sequence.push('PUT');
    relationBodies.push(route.request().postDataJSON());
    if (relationWrites === 1) {
      return route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'RELATION_WRITE_FAILED' }),
      });
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        hosts: [{
          serverId: fakeServerId,
          role: 'primary',
          host: '10.248.200.200',
          port: 22,
          label: serverLabel,
          osType: 'Linux',
          status: 'online',
          collectionEnabled: true,
          validFrom: '2026-08-10T08:00:00.000Z',
        }],
      }),
    });
  });

  await page.goto('/instances-db');
  const instancesPage = page.locator('instances-page');
  await expect(instancesPage).toBeVisible({ timeout: 15_000 });
  await instancesPage.getByRole('button', { name: '+ 添加实例', exact: true }).click();
  const dialog = instancesPage.locator('app-dialog[title="添加数据库实例"]');
  await expect(dialog.locator('[role="dialog"]')).toBeVisible();
  await dialog.locator('app-form-field[label="实例名称"] input').fill(instanceName);
  await dialog.locator('app-form-field[label="环境"] select').selectOption('testing');
  await dialog.locator('app-form-field[label="主机地址"] input').fill('10.248.200.201');
  await dialog.locator('app-form-field[label="用户名"] input').fill('qualification_e2e');
  await dialog.locator('app-form-field[label="密码"] input').fill('not-used-by-this-test');
  await dialog.locator('app-form-field[label="数据库名"] input').fill('db_ops_ai_qualification');
  const hostOption = dialog.locator('instance-host-field .host-option').filter({ hasText: serverLabel });
  await expect(hostOption).toBeVisible();
  await hostOption.locator('input[type="checkbox"]').check();
  await hostOption.locator(`select[data-server-id="${fakeServerId}"]`).selectOption('primary');

  await dialog.getByRole('button', { name: '添加实例', exact: true }).click();
  const retryButton = dialog.getByRole('button', { name: '重试关联', exact: true });
  await expect(retryButton).toBeVisible();
  expect(postBodies).toHaveLength(1);
  expect(relationBodies).toHaveLength(1);
  expect(sequence).toEqual(['POST', 'PUT']);
  expect(relationBodies[0]).toEqual({ hosts: [{ serverId: fakeServerId, role: 'primary' }] });

  const baseFields = dialog.locator('input.form-input, select.form-select, textarea.form-textarea');
  await expect.poll(async () => baseFields.evaluateAll((fields) => (
    fields.length > 0 && fields.every((field) => (field as HTMLInputElement).disabled)
  ))).toBe(true);
  await expect(dialog.getByRole('button', { name: '测试连接', exact: true })).toBeDisabled();

  await retryButton.click();
  await expect(dialog).toBeHidden();
  expect(postBodies).toHaveLength(1);
  expect(relationBodies).toHaveLength(2);
  expect(sequence).toEqual(['POST', 'PUT', 'PUT']);
  expect(relationBodies[1]).toEqual({ hosts: [{ serverId: fakeServerId, role: 'primary' }] });
  expect(postBodies[0]).toMatchObject({
    name: instanceName,
    environment: 'testing',
    db_type: 'mysql',
    host: '10.248.200.201',
    username: 'qualification_e2e',
  });

  audit.assertClean();
});
