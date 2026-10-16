import { expect, test } from '@playwright/test';

test('shared controls: document/shadow parity, appearance, density, focus and busy states', async ({ page }, testInfo) => {
  await page.route('**/button-gallery', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head></head><body></body></html>' }));
  await page.goto('/button-gallery');
  await page.evaluate(async () => {
    await import('/src/app/styles.css');
    const { sharedBtnStyles } = await import('/src/app/styles/shared-btn-styles.ts');
    await import('/src/app/ui/views/appearance-settings.ts');
    await import('/src/app/ui/components/app-select-field.ts');
    await import('/src/app/ui/components/app-badge.ts');
    await import('/src/components/stat-card.ts');
    document.body.innerHTML = `<style>body{padding:16px;overflow:auto}main{max-width:960px;margin:auto}section{padding:16px;margin-block:16px;background:var(--card);border:1px solid var(--border);border-radius:var(--radius-md)}.samples{display:flex;align-items:center;gap:8px;flex-wrap:wrap}h1{font-size:24px}h2{font-size:16px}#shadow{display:block}</style><main><h1>主要控件规范 · 样例数据</h1><p>相同场景同样式；行内操作使用紧凑尺寸。</p><section><h2>普通 DOM</h2><div class="samples" id="light"></div></section><section><h2>Shadow DOM</h2><div id="shadow"></div></section><app-select-field label="分页" id="select"></app-select-field><stat-card label="样例资源" value="12" hint="仅为样例，不代表健康"></stat-card><app-badge variant="warn">待确认</app-badge></main>`;
    const markup = `<button class="btn-primary">创建</button><button class="btn btn-refresh">刷新</button><button class="btn">取消</button><button class="btn-sm">编辑</button><button class="btn-ghost">查看证据</button><button class="btn-sm danger">删除</button><button class="btn btn-refresh" aria-busy="true" disabled>刷新中</button>`;
    document.querySelector('#light')!.innerHTML = markup;
    document.querySelector('#shadow')!.attachShadow({ mode: 'open' }).innerHTML = `<style>${sharedBtnStyles.cssText}.samples{display:flex;align-items:center;gap:8px;flex-wrap:wrap}</style><div class="samples">${markup}</div>`;
    (document.querySelector('#select') as any).options = [{ value: 20, label: '20 条' }];
  });
  const metrics: unknown[] = [];
  for (const width of [1440, 390]) for (const mode of ['light', 'dark']) for (const density of ['compact', 'standard', 'comfortable']) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(async ({ mode, density }) => {
      document.documentElement.dataset.themeMode = mode;
      const { applyDensity } = await import('/src/app/ui/density.ts'); applyDensity(density as any);
    }, { mode, density });
    const styles = await page.evaluate(() => {
      const read = (root: ParentNode) => [...root.querySelectorAll('button')].map(el => {
        const s = getComputedStyle(el), icon = getComputedStyle(el, '::before');
        return { height: el.getBoundingClientRect().height, font: s.fontSize, padding: s.padding, radius: s.borderRadius, color: s.color, bg: s.backgroundColor, border: s.borderColor, opacity: s.opacity, icon: icon.maskImage, iconSize: icon.width };
      });
      return { light: read(document.querySelector('#light')!), shadow: read(document.querySelector('#shadow')!.shadowRoot!) };
    });
    expect(styles.light).toEqual(styles.shadow);
    expect(styles.light[1].icon).toContain('data:image/svg+xml');
    expect(styles.light[1].iconSize).toBe('16px');
    expect(styles.light[0].height).toBe(styles.light[1].height);
    expect(styles.light[1].height).toBe(styles.light[2].height);
    expect(styles.light[3].height).toBeLessThanOrEqual(styles.light[1].height);
    expect(styles.light[6].opacity).toBe('0.45');
    if (width === 390) expect(styles.light.every(s => s.height >= 44)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    metrics.push({ width, mode, density, ...styles });
    await page.screenshot({ path: testInfo.outputPath(`controls-${width}-${mode}-${density}.png`), fullPage: true, animations: 'disabled' });
  }
  // A palette override must reach both DOM types, and hover must preserve primary text color.
  await page.evaluate(async () => {
    const { applyButtonPalette } = await import('/src/app/ui/btn-palette.ts');
    const { applyBorderRadius } = await import('/src/app/ui/app-settings.ts');
    applyButtonPalette({ primaryBg: '#245f99', primaryColor: '#ffffff', secondaryBg: '#293b48', secondaryColor: '#ffffff', secondaryBorder: '#64748b' });
    applyBorderRadius(0);
  });
  for (const root of [page.locator('#light'), page.locator('#shadow')]) {
    const button = root.locator('.btn-refresh').first();
    await expect(button).toHaveCSS('background-color', 'rgb(41, 59, 72)');
    await expect(button).toHaveCSS('color', 'rgb(255, 255, 255)');
    await expect(button).toHaveCSS('border-radius', '0px');
    await button.focus(); await expect(button).toBeFocused();
    expect(await button.evaluate(el => getComputedStyle(el).outlineStyle)).toBe('solid');
    const primary = root.locator('.btn-primary'); await primary.hover();
    await expect(primary).toHaveCSS('color', 'rgb(255, 255, 255)');
  }
  await page.emulateMedia({ reducedMotion: 'reduce', forcedColors: 'active' });
  expect(await page.locator('#shadow [aria-busy]').evaluate(el => getComputedStyle(el, '::before').animationName)).toBe('none');
  await testInfo.attach('computed-control-metrics.json', { body: JSON.stringify(metrics, null, 2), contentType: 'application/json' });
});
