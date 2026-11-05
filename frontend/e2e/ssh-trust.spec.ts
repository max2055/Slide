import { expect, test } from '@playwright/test';
import { parseNetworkDeviceUpdateInput } from '../../apps/db-ops-api/src/resources/network-device-types';

// Browser UI with intercepted HTTP; real SSH and MySQL have separate tests.
for (const [width, height] of [[1440, 900], [1366, 768], [1920, 1080]]) {
  test(`key migration without replacing the stored secret ${width}x${height}`, async ({ page }, info) => {
    const writes: unknown[] = [];
    await page.setViewportSize({ width, height });
    await page.addInitScript(() => localStorage.setItem('permissions', JSON.stringify(['network_devices:view', 'network_devices:manage'])));
    await page.route(url => url.pathname.startsWith('/api/'), async route => {
      if (route.request().method() === 'PUT') {
        const body = route.request().postDataJSON();
        const parsed = parseNetworkDeviceUpdateInput(body);
        expect(parsed.ssh).toBeUndefined();
        expect(parsed.sshTrust).toEqual({ mode: 'insecure', fingerprint: undefined });
        writes.push(body);
      }
      await route.fulfill({ json: route.request().method() === 'GET' ? [{
        id: 7, name: '迁移合成设备', host: '192.0.2.7', vendor: 'huawei', snmp_port: 161, ssh_port: 22,
        collection_enabled: false, sshCredentialType: 'key', sshTrustMode: null,
      }] : { success: true } });
    });
    await page.route('**/trust-fixture', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"></head><body><network-devices-page></network-devices-page><script type="module">import '/src/app/styles.css'; import '/src/app/ui/views/network-devices-page.ts';</script></body></html>` }));
    await page.goto('/trust-fixture');
    await page.getByRole('button', { name: '编辑', exact: true }).click();
    await expect(page.getByRole('heading', { name: '编辑网络设备' })).toBeFocused();
    const strategy = page.getByLabel('SSH 主机身份策略', { exact: true });
    await expect(strategy).toHaveValue('pending');
    await expect(page.getByLabel('SSH 私钥', { exact: true })).toHaveValue('');
    await strategy.selectOption('insecure');
    await expect(page.getByText('通过受信任渠道核验指纹。', { exact: false })).toBeVisible();
    await strategy.focus();
    await strategy.press('Tab');
    await expect(page.getByLabel('SSH 主机密钥指纹', { exact: true })).toBeFocused();
    await page.screenshot({ path: info.outputPath(`trust-${width}.png`), fullPage: true });
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await expect.poll(() => writes.length).toBe(1);
    await page.getByRole('button', { name: '添加设备', exact: true }).click();
    await expect(strategy).toHaveCount(0);
    await expect(page.getByLabel('SSH 密码', { exact: true })).toHaveAttribute('type', 'password');
  });
  test(`server key policy and password exclusion ${width}x${height}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height });
    await page.addInitScript(() => localStorage.setItem('permissions', JSON.stringify(['servers:view', 'servers:manage'])));
    await page.route(url => url.pathname.startsWith('/api/'), route => route.fulfill({ json: [] }));
    await page.route('**/server-trust-fixture', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"></head><body><servers-page></servers-page><script type="module">import '/src/app/styles.css'; import '/src/app/ui/views/servers-page.ts';</script></body></html>` }));
    await page.goto('/server-trust-fixture');
    await page.getByRole('button', { name: '添加服务器', exact: true }).click();
    const strategy = page.getByLabel('SSH 主机身份策略', { exact: true });
    await expect(strategy).toHaveCount(0);
    await page.getByRole('radio', { name: 'SSH 密钥', exact: true }).check();
    await expect(strategy).toHaveValue('pending');
    await strategy.selectOption('pinned');
    await page.getByLabel('SSH 主机密钥指纹', { exact: true }).fill('SHA256:' + 'A'.repeat(43));
    await strategy.selectOption('insecure');
    await expect(page.getByRole('status')).toContainText('未验证服务器身份');
    await page.screenshot({ path: info.outputPath(`server-trust-${width}.png`), fullPage: true });
    await page.getByRole('radio', { name: '密码', exact: true }).check();
    await expect(strategy).toHaveCount(0);
    await expect(page.getByLabel('SSH 密码', { exact: true })).toHaveAttribute('type', 'password');
  });
}
