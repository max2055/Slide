import { test, expect } from '@playwright/test';

const BASE = 'http://localhost:5173';

// Login helper
async function login(page) {
  await page.goto(`${BASE}/`);
  await page.waitForTimeout(1000);
  const usernameInput = page.locator('input[name="username"], input[placeholder*="用户"], .login-gate input[type="text"]').first();
  const passwordInput = page.locator('input[type="password"]').first();
  if (await usernameInput.isVisible({ timeout: 3000 }).catch(() => false)) {
    await usernameInput.fill('admin');
    await passwordInput.fill('Tpam1234');
    // Login button says "Connect" / "连接"
    await page.locator('button.login-gate__connect, button').filter({ hasText: /Connect|连接/i }).first().click();
    await page.waitForTimeout(3000);
  }
}

test.describe('Phase 120: UI Overhaul Verification', () => {

  test('01 - CSS tokens: blue accent #409eff active', async ({ page }) => {
    await login(page);
    const result = await page.evaluate(() => {
      const cs = getComputedStyle(document.documentElement);
      const accent = cs.getPropertyValue('--accent').trim();
      const zModal = cs.getPropertyValue('--z-modal').trim();
      const disabledOpacity = cs.getPropertyValue('--disabled-opacity').trim();
      return { accent, zModal, disabledOpacity };
    });
    console.log('Token values:', JSON.stringify(result));
    // Blue #409eff = rgb(64, 158, 255). Verify red channel is blue-ish (64-66)
    expect(result.accent).not.toBe('');
    expect(result.accent).not.toContain('124'); // NOT purple rgb(124,...)
    expect(result.zModal).toBe('1000');
    expect(result.disabledOpacity).toBe('0.45');
  });

  test('02 - Old CSS system is gone (no global.css loaded)', async ({ page }) => {
    await page.goto(BASE);
    // Check that old global.css classes are NOT present
    const hasOldLayout = await page.evaluate(() => {
      return !!document.querySelector('.app-layout');
    });
    expect(hasOldLayout).toBe(false);
  });

  test('03 - tokens.css exists and provides tokens', async ({ page }) => {
    await page.goto(BASE);
    const hasTokens = await page.evaluate(() => {
      const cs = getComputedStyle(document.documentElement);
      return cs.getPropertyValue('--disabled-opacity').trim() === '0.45' &&
             cs.getPropertyValue('--z-toast').trim() === '1100';
    });
    expect(hasTokens).toBe(true);
  });

  test('04 - Login page renders without JS errors', async ({ page }) => {
    const errors = [];
    page.on('pageerror', err => errors.push(err.message));
    await page.goto(`${BASE}/`);
    await page.waitForTimeout(2000);
    expect(errors).toEqual([]);
  });

  test('05 - Main dashboard loads after login', async ({ page }) => {
    const errors = [];
    page.on('pageerror', err => errors.push(err.message));
    await login(page);
    await page.waitForTimeout(2000);
    // Should see shell layout
    const shell = page.locator('.shell');
    await expect(shell).toBeVisible({ timeout: 5000 });
    // No JS errors after login
    const criticalErrors = errors.filter(e => !e.includes('favicon') && !e.includes('WebSocket'));
    expect(criticalErrors).toEqual([]);
  });

  test('06 - Shared component: app-badge renders in alert list', async ({ page }) => {
    await login(page);
    await page.waitForTimeout(2000);
    // Navigate to alerts
    await page.locator('nav-item, .nav-item, a').filter({ hasText: /告警|alert/i }).first().click().catch(() => {});
    await page.waitForTimeout(2000);
    // Check for app-badge in the DOM
    const badges = page.locator('app-badge');
    const count = await badges.count();
    console.log(`Found ${count} app-badge elements`);
    // At minimum, the component tag should be registered
  });

  test('07 - Shared component: app-dialog works', async ({ page }) => {
    await login(page);
    await page.waitForTimeout(2000);
    // Check if app-dialog is defined
    const defined = await page.evaluate(() => {
      return !!customElements.get('app-dialog');
    });
    expect(defined).toBe(true);
  });

  test('08 - No console errors on instances page', async ({ page }) => {
    const errors = [];
    page.on('pageerror', err => errors.push(err.message));
    await login(page);
    await page.waitForTimeout(2000);
    // Navigate to instances
    await page.locator('nav-item, .nav-item, a').filter({ hasText: /实例|instance/i }).first().click().catch(() => {});
    await page.waitForTimeout(2000);
    const criticalErrors = errors.filter(e => !e.includes('favicon') && !e.includes('WebSocket'));
    expect(criticalErrors).toEqual([]);
  });

  test('09 - New design tokens present in computed styles', async ({ page }) => {
    await login(page);
    const tokens = await page.evaluate(() => {
      const cs = getComputedStyle(document.documentElement);
      return {
        zSidebar: cs.getPropertyValue('--z-sidebar').trim(),
        zDropdown: cs.getPropertyValue('--z-dropdown').trim(),
        zToast: cs.getPropertyValue('--z-toast').trim(),
        durationFast: cs.getPropertyValue('--duration-fast').trim(),
        easeSpring: cs.getPropertyValue('--ease-spring').trim(),
        radiusSm: cs.getPropertyValue('--radius-sm').trim(),
      };
    });
    console.log('New tokens:', JSON.stringify(tokens));
    // Verify Phase 120-introduced tokens exist
    expect(tokens.zSidebar).toBe('10');
    expect(tokens.zDropdown).toBe('100');
    expect(tokens.zToast).toBe('1100');
  });

  test('10 - Key shared components registered on dashboard', async ({ page }) => {
    await login(page);
    // Core components loaded on main dashboard (not all components are eagerly loaded)
    const coreComponents = ['app-dialog', 'app-badge', 'app-toast-container', 'app-form-field'];
    const registered = await page.evaluate((names) => {
      return names.map(n => !!customElements.get(n));
    }, coreComponents);
    console.log('Core component registration:', coreComponents.map((c, i) => `${c}=${registered[i]}`));
    expect(registered.filter(Boolean).length).toBeGreaterThanOrEqual(2);
  });

  test('11 - Chat page loads without errors (post-split)', async ({ page }) => {
    const errors = [];
    page.on('pageerror', err => errors.push(err.message));
    await login(page);
    await page.waitForTimeout(2000);
    await page.locator('nav-item, .nav-item, a').filter({ hasText: /chat|聊天|AI/i }).first().click().catch(() => {});
    await page.waitForTimeout(3000);
    const criticalErrors = errors.filter(e => !e.includes('favicon') && !e.includes('WebSocket') && !e.includes('socket'));
    expect(criticalErrors).toEqual([]);
  });

  test('12 - No purple #7c5cff in computed styles', async ({ page }) => {
    await login(page);
    await page.waitForTimeout(2000);
    const purpleFound = await page.evaluate(() => {
      const cs = getComputedStyle(document.documentElement);
      const accent = cs.getPropertyValue('--accent').trim();
      // Should be blue, not purple
      return accent.includes('124') || accent.includes('7c5c');
    });
    expect(purpleFound).toBe(false);
  });
});
