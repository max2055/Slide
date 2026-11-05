import { expect, test } from '@playwright/test';
import { generateKeyPairSync, createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import {
  parseNetworkDeviceCreateInput, parseNetworkDeviceUpdateInput, validateSshCredential,
} from '../../apps/db-ops-api/src/resources/network-device-types';

const { utils: { parseKey } } = createRequire(import.meta.url)('ssh2');
// Generated for this isolated test run only. Never log or attach the key.
const { privateKey: pem } = generateKeyPairSync('ec', {
  namedCurve: 'prime256v1', privateKeyEncoding: { type: 'sec1', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

for (const [width, height] of [[1440, 900], [1366, 768], [1920, 1080]]) {
  test(`MAX-312: masked PEM, keyboard and parsed HTTP payload at ${width}x${height}`, async ({ page }, testInfo) => {
    const writes: { method: string; path: string; value: string; type: string }[] = [];
    let failNext = false;
    const device = { id: 7, name: '合成交换机', host: '192.0.2.7', vendor: 'huawei', snmp_port: 161, ssh_port: 22, collection_enabled: false };
    // Isolated HTTP receiver uses the application's actual backend parsers.
    // Storage, authentication and SSH transport are deliberately not represented.
    const server = createServer(async (request, response) => {
      response.setHeader('Content-Type', 'application/json');
      if (request.method === 'GET') { response.end(JSON.stringify(request.url === '/api/network-devices' ? [device] : {})); return; }
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString());
        const ssh = request.url?.endsWith('/test-connection') ? validateSshCredential(body.ssh)
          : (request.method === 'PUT' ? parseNetworkDeviceUpdateInput(body) : parseNetworkDeviceCreateInput(body)).ssh!;
        writes.push({ method: request.method!, path: request.url!, value: ssh.credentialValue, type: ssh.credentialType });
        if (failNext) { failNext = false; response.statusCode = 400; response.end(JSON.stringify({ error: '合成保存失败，请重试' })); return; }
        response.end(JSON.stringify({ id: 7, success: true }));
      } catch {
        response.statusCode = 400; response.end(JSON.stringify({ error: 'SYNTHETIC_INPUT_INVALID' }));
      }
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = (server.address() as { port: number }).port;
    try {
      await page.setViewportSize({ width, height });
      await page.addInitScript(() => localStorage.setItem('permissions', JSON.stringify(['network_devices:view', 'network_devices:manage'])));
      await page.route(url => url.pathname.startsWith('/api/'), async route => {
        const result = await route.fetch({ url: `http://127.0.0.1:${port}${new URL(route.request().url()).pathname}` });
        await route.fulfill({ response: result });
      });
      await page.route('**/private-key-fixture', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>合成网络设备测试</title></head><body>
        <network-devices-page></network-devices-page><script type="module">import '/src/app/styles.css'; import '/src/app/ui/views/network-devices-page.ts';</script></body></html>` }));
      await page.goto('/private-key-fixture');
      const add = page.getByRole('button', { name: '添加设备', exact: true });
      await add.click();
      await expect(page.getByRole('heading', { name: '添加网络设备' })).toBeFocused();
      await page.getByRole('textbox', { name: '名称', exact: true }).fill('合成交换机');
      await page.getByRole('textbox', { name: '主机', exact: true }).fill('192.0.2.7');
      await page.getByLabel('Community', { exact: true }).fill('synthetic-community');
      await page.getByLabel('SSH 用户名', { exact: true }).fill('ops');
      await page.getByRole('radio', { name: 'SSH 密钥', exact: true }).check();
      const field = page.getByRole('textbox', { name: 'SSH 私钥', exact: true });
      await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
      await page.evaluate(value => navigator.clipboard.writeText(value), pem);
      await field.focus();
      await field.press('ControlOrMeta+V');
      await expect(field).toHaveValue(pem);
      await expect(field).toHaveCSS('-webkit-text-security', 'disc');
      await field.press('Tab');
      const show = page.getByRole('button', { name: '显示私钥', exact: true });
      await expect(show).toBeFocused();
      await show.press('Enter');
      await expect(field).toHaveCSS('-webkit-text-security', 'none');
      const hide = page.getByRole('button', { name: '隐藏私钥', exact: true });
      await expect(hide).toBeFocused();
      await expect(hide).toHaveAttribute('aria-pressed', 'true');
      await hide.press('Space');
      await expect(field).toHaveCSS('-webkit-text-security', 'disc');
      await expect(field).toHaveValue(pem);
      for (const name of ['测试 SSH', '测试 SNMPv2c']) {
        await page.getByRole('button', { name, exact: true }).click();
        await expect.poll(() => writes.length).toBe(name === '测试 SSH' ? 1 : 2);
      }
      const save = page.getByRole('button', { name: '保存', exact: true });
      await save.scrollIntoViewIfNeeded();
      await expect(save).toBeInViewport();
      await expect(show).toBeInViewport();
      await page.screenshot({ path: testInfo.outputPath(`masked-${width}.png`), fullPage: true });
      failNext = true;
      await save.click();
      // Existing editor leave handling selects collection before saving.
      // Return to the connection panel to inspect its error and retained input.
      await page.getByRole('tab', { name: '基本信息', exact: true }).click();
      await expect(page.getByRole('alert')).toContainText('合成保存失败，请重试');
      await expect(field).toHaveValue(pem);
      await expect(field).toHaveCSS('-webkit-text-security', 'disc');
      await save.click();
      await expect(add).toBeFocused();
      expect(writes).toHaveLength(4);
      for (const write of writes) {
        expect(write.type).toBe('key');
        expect(write.value).toBe(pem);
        expect(parseKey(write.value)).not.toBeInstanceOf(Error);
      }
      // Updating an existing device uses the same multiline control and parser.
      await page.getByRole('button', { name: '编辑', exact: true }).click();
      await expect(page.getByRole('heading', { name: '编辑网络设备' })).toBeFocused();
      await page.getByRole('radio', { name: 'SSH 密钥', exact: true }).check();
      await expect(field).toHaveValue('');
      await expect(field).toHaveCSS('-webkit-text-security', 'disc');
      await field.focus();
      await field.press('ControlOrMeta+V');
      await page.getByLabel('SSH 用户名', { exact: true }).fill('ops');
      await save.click();
      await expect.poll(() => writes.length).toBe(5);
      expect(writes[4]).toMatchObject({ method: 'PUT', type: 'key', value: pem });
      expect(parseKey(writes[4].value)).not.toBeInstanceOf(Error);
      // Password remains a native masked input, including leading/trailing spaces.
      await page.getByRole('button', { name: '编辑', exact: true }).click();
      const password = page.getByLabel('SSH 密码', { exact: true });
      await expect(password).toHaveAttribute('type', 'password');
      await expect(password).toHaveValue('');
      await password.fill('  synthetic password  ');
      await page.getByLabel('SSH 用户名', { exact: true }).fill('ops');
      await save.click();
      await expect.poll(() => writes.length).toBe(6);
      expect(writes[5]).toMatchObject({ method: 'PUT', type: 'password', value: '  synthetic password  ' });
      // A fresh editor and auth switch cannot inherit a prior reveal state.
      await add.click();
      await page.getByRole('radio', { name: 'SSH 密钥', exact: true }).check();
      await expect(field).toHaveValue('');
      await expect(field).toHaveCSS('-webkit-text-security', 'disc');
      await show.click();
      await page.getByRole('radio', { name: '密码', exact: true }).check();
      await page.getByRole('radio', { name: 'SSH 密钥', exact: true }).check();
      await expect(field).toHaveCSS('-webkit-text-security', 'disc');
      await page.getByRole('button', { name: '取消', exact: true }).click();
      await expect(add).toBeFocused();
      await testInfo.attach('parsed-payload-summary', { contentType: 'application/json', body: JSON.stringify({
        viewport: { width, height }, browser: await page.context().browser()!.version(),
        requests: writes.map(({ method, path, type, value }) => ({ method, path, type, bytes: Buffer.byteLength(value), sha256: createHash('sha256').update(value).digest('hex') })),
        pemExact: true, ssh2ParseKey: true, storage: 'isolated receiver; no database or SSH transport',
      }, null, 2) });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });
}
