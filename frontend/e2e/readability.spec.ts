import { expect, test, type Locator, type Page } from '@playwright/test';

// Composite real computed colors, including nested opacity and Shadow DOM hosts.
async function contrast(locator: Locator, pseudo: string | null = null) {
  return locator.evaluate((node, pseudo) => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const ctx = canvas.getContext('2d')!;
    const rgba = (color: string) => {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = color; ctx.fillRect(0, 0, 1, 1);
      const p = [...ctx.getImageData(0, 0, 1, 1).data];
      return [p[0], p[1], p[2], p[3] / 255];
    };
    const over = (a: number[], b: number[]) => {
      const alpha = a[3] + b[3] * (1 - a[3]);
      return [...[0, 1, 2].map(i => alpha ? (a[i] * a[3] + b[i] * b[3] * (1 - a[3])) / alpha : 0), alpha];
    };
    let foreground = rgba(getComputedStyle(node, pseudo).color);
    let background = [0, 0, 0, 0];
    let element: Element | null = node;
    while (element) {
      const style = getComputedStyle(element);
      const surface = rgba(style.backgroundColor);
      foreground = over(foreground, surface);
      background = over(background, surface);
      foreground[3] *= Number(style.opacity);
      background[3] *= Number(style.opacity);
      element = element.parentElement ?? (element.getRootNode() as ShadowRoot).host ?? null;
    }
    foreground = over(foreground, [255, 255, 255, 1]);
    background = over(background, [255, 255, 255, 1]);
    const luminance = (rgb: number[]) => rgb.slice(0, 3).reduce((sum, value, i) => {
      const c = value / 255;
      return sum + (c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4) * [.2126, .7152, .0722][i];
    }, 0);
    const a = luminance(foreground), b = luminance(background);
    return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
  }, pseudo);
}

async function fixture(page: Page, mode: string) {
  await page.emulateMedia({ colorScheme: mode as 'light' | 'dark' });
  await page.addInitScript(mode => {
    localStorage.setItem('token', 'fixture-token');
    localStorage.setItem('permissions', '["*"]');
    localStorage.setItem('slide.i18n.locale', 'zh-CN');
    localStorage.setItem('slide.control.session_token.v1', 'fixture-token');
    localStorage.setItem('slide.control.settings.v1:default', JSON.stringify({ locale: 'zh-CN', themeMode: mode }));
  }, mode);
  await page.routeWebSocket('**/agent-ws', socket => socket.onMessage(message => {
    if (JSON.parse(String(message)).type === 'auth') socket.send(JSON.stringify({ type: 'auth_ok' }));
  }));
  await page.route('**/__slide/control-ui-config.json', route => route.fulfill({ json: {} }));
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (!path.startsWith('/api/')) return route.fallback();
    const body = path === '/api/auth/permissions' ? ['*']
      : path === '/api/user/preferences' ? { preferences: { locale: 'zh-CN', themeMode: mode } }
      : path === '/api/resources/overview' ? { collectedAt: new Date().toISOString(), items: [], dataQuality: 'good', truncated: false }
      : {};
    return route.fulfill({ json: body });
  });
}

for (const mode of ['light', 'dark']) {
  test(`navigation readability and states: ${mode}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await fixture(page, mode);
    await page.goto('/dashboard');
    const nav = page.locator('.nav-item[href="/instances-db"]').first();
    await expect(nav).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('data-theme-mode', mode);
    for (const state of ['default', 'hover', 'focus']) {
      if (state === 'hover') await nav.hover();
      if (state === 'focus') { await page.mouse.move(900, 0); await nav.focus(); }
      await expect.poll(() => contrast(nav.locator('.nav-item__text')), { message: state }).toBeGreaterThanOrEqual(4.5);
      expect(await contrast(nav.locator('.nav-item__icon')), state).toBeGreaterThanOrEqual(3);
    }
    expect(await contrast(page.locator('.nav-item--active .nav-item__icon').first())).toBeGreaterThanOrEqual(3);
    await expect(nav).toBeFocused();
    expect(await nav.evaluate(e => getComputedStyle(e).boxShadow)).not.toBe('none');
    await page.locator('.sidebar-nav').evaluate(e => { e.scrollTop = 0; });
    await page.screenshot({ path: testInfo.outputPath(`navigation-${mode}.png`), fullPage: true });
    // Desktop icon rail and mobile drawer use the same actual shell controls.
    await page.locator('.sidebar .nav-collapse-toggle').click();
    await expect(page.locator('.sidebar')).toHaveClass(/sidebar--collapsed/);
    expect(await contrast(nav.locator('.nav-item__icon'))).toBeGreaterThanOrEqual(3);
    await page.setViewportSize({ width: 390, height: 844 });
    // Keyboard activation also checks the drawer remains accessible at narrow widths.
    await page.locator('.topbar-nav-toggle').focus();
    await page.keyboard.press('Enter');
    await expect(nav).toBeVisible();
    expect(await contrast(nav.locator('.nav-item__icon'))).toBeGreaterThanOrEqual(3);
    await page.screenshot({ path: testInfo.outputPath(`navigation-mobile-${mode}.png`), fullPage: true });
  });

  test(`shared content contrast and live chart theme: ${mode}`, async ({ page }, testInfo) => {
    // Component gallery contains explicitly labelled sample data and real production components/styles.
    await page.route('**/readability-fixture', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head></head><body></body></html>' }));
    await page.goto('/readability-fixture');
    await page.evaluate(async mode => {
      await import('/src/app/styles.css');
      await Promise.all(['app-card', 'app-form-field', 'app-data-table', 'app-badge', 'metric-chart'].map(name => import(`/src/app/ui/components/${name}.ts`)));
      const { sharedResourceToolbarCssText } = await import('/src/app/styles/shared-resource-toolbar-styles.ts');
      document.documentElement.dataset.themeMode = mode;
      document.body.innerHTML = `<style>${sharedResourceToolbarCssText}
        body { padding:24px; overflow:auto; } main { max-width:1000px; margin:auto; display:grid; gap:16px; }
        .samples { display:flex; gap:12px; flex-wrap:wrap; padding:16px; }
      </style><main><h1>可读性验证 · 样例数据</h1>
      <app-card><span slot="header">资源与操作</span><div class="resource-toolbar"><div class="search-box"><span class="search-icon">⌕</span><input class="search-input" placeholder="搜索资源" aria-label="搜索资源"></div><button class="btn-primary">添加资源</button><button class="btn-ghost">查看详情</button><button class="btn" disabled>不可用操作</button></div>
      <app-form-field label="实例名称" hint="仅为可读性测试示例"><input class="cfg-input" placeholder="请输入名称" aria-label="实例名称"></app-form-field>
      <app-data-table></app-data-table><div class="samples">${['ok','warn','danger','info','muted'].map(v => `<app-badge variant="${v}">${v}</app-badge>`).join('')}</div></app-card>
      <app-card><span slot="header">聊天与设置</span><div class="samples"><span class="chat-group-timestamp">10:30</span><span class="chat-tool-card__summary-meta">执行耗时 2 秒</span><span class="slash-menu-args">资源名称</span><a href="#" style="color:var(--accent-text)">查看执行记录</a></div></app-card>
      <metric-chart title="指标趋势 · 样例" height="220px"></metric-chart></main>`;
      const table = document.querySelector('app-data-table') as any;
      table.columns = [{ key: 'name', label: '资源名称', sortable: true }, { key: 'status', label: '状态' }];
      table.rows = [{ name: '示例数据库', status: '在线' }];
      const chart = document.querySelector('metric-chart') as any;
      chart.timeData = ['10:00', '10:05', '10:10']; chart.series = [{ name: 'CPU', data: [25, 40, 35] }];
      await Promise.all([...document.querySelectorAll('*')].map((e: any) => e.updateComplete));
    }, mode);
    const selectors = ['.btn-primary', '.btn-ghost', '.form-hint', '.data-table th', '.data-table td', 'app-badge', '.chat-group-timestamp', '.chat-tool-card__summary-meta', '.slash-menu-args', 'a'];
    for (const selector of selectors) {
      for (const element of await page.locator(selector).all()) expect(await contrast(element), `${mode} ${selector} ${await element.getAttribute('variant') ?? ''}`).toBeGreaterThanOrEqual(4.5);
    }
    expect(await contrast(page.locator('.search-icon'))).toBeGreaterThanOrEqual(3);
    for (const selector of ['.cfg-input', '.search-input']) expect(await contrast(page.locator(selector), '::placeholder')).toBeGreaterThanOrEqual(4.5);
    for (const selector of ['.btn-primary', '.btn-ghost']) {
      await page.locator(selector).hover();
      await expect.poll(() => contrast(page.locator(selector))).toBeGreaterThanOrEqual(4.5);
    }
    // Verify neutral surfaces used by cards, forms, striped tables and hover states.
    await page.evaluate(() => {
      const matrix = document.createElement('div'); matrix.id = 'contrast-matrix';
      for (const surface of ['bg', 'card', 'bg-elevated', 'bg-muted', 'bg-hover', 'panel-hover']) {
        for (const color of ['text', 'text-strong', 'muted', 'accent-text']) {
          const sample = document.createElement('span');
          sample.textContent = `${surface}/${color}`;
          sample.style.cssText = `display:block;background:var(--${surface});color:var(--${color})`;
          matrix.append(sample);
        }
      }
      document.body.append(matrix);
    });
    const measurements: Record<string, number> = {};
    for (const sample of await page.locator('#contrast-matrix span').all()) {
      const label = (await sample.textContent())!;
      measurements[label] = await contrast(sample);
      expect(measurements[label], `${mode} ${label}`).toBeGreaterThanOrEqual(4.5);
    }
    await testInfo.attach(`contrast-${mode}.json`, { body: JSON.stringify(measurements, null, 2), contentType: 'application/json' });
    await page.locator('#contrast-matrix').evaluate(e => e.remove());
    await expect(page.getByRole('button', { name: '不可用操作' })).toBeDisabled();
    await expect(page.locator('metric-chart canvas')).toBeVisible();
    await expect.poll(() => page.locator('metric-chart').evaluate((e: any) => e._chart?.getOption().xAxis?.[0].axisLabel.color)).toBe(mode === 'light' ? '#606068' : '#a1a1aa');
    await page.screenshot({ path: testInfo.outputPath(`components-${mode}.png`), fullPage: true });
    await page.evaluate(mode => { document.documentElement.dataset.themeMode = mode === 'light' ? 'dark' : 'light'; }, mode);
    await expect.poll(() => page.locator('metric-chart').evaluate((e: any) => e._chart.getOption().xAxis[0].axisLabel.color)).toBe(mode === 'light' ? '#a1a1aa' : '#606068');
  });
}
