import { test, expect } from '@playwright/test';
for (const context of ['', '?investigation=exact&version=7', '?entry=exact', '?workspaceTab=investigations']) {
  test(`asynchronous initial authority on entry and refresh preserves context ${context || 'plain'}`, async ({page}) => {
    const calls:string[]=[];
    await page.route('**/api/**', route => {
      if(!new URL(route.request().url()).pathname.startsWith('/api/')) return route.fallback();
      calls.push(`${route.request().method()} ${new URL(route.request().url()).pathname}`);
      return route.fulfill({json:{items:[],partial:false,nextCursor:null}});
    });
    await page.route('**/workbench*', route => !route.request().isNavigationRequest() ? route.fallback() : route.fulfill({contentType:'text/html',body:`<!doctype html><html lang="zh-CN"><body><script type="module">
      import '/src/app/ui/views/workbench.ts';
      const view=document.createElement('workbench-page');document.body.append(view);
      window.deliverAuthority=()=>window.dispatchEvent(new CustomEvent('slide-permissions-loaded',{detail:{permissions:['operations:actions:view']}}));
    </script></body></html>`}));
    await page.goto(`/workbench${context}`);
    for (const refresh of [false,true]) {
      if(refresh) { await page.goto(`/workbench${context}`); await page.reload(); }
      await page.waitForFunction(()=>typeof (window as any).deliverAuthority === 'function');
      await expect(page.locator('operations-actions')).toHaveCount(0);
      await page.evaluate(()=> (window as any).deliverAuthority());
      if(context) {
        await expect(page.locator('operations-actions')).toHaveCount(0);
        await expect(page.getByText('无访问权限',{exact:true})).toBeVisible();
        expect(new URL(page.url()).search).toBe(context);
      } else {
        await expect(page.locator('operations-actions')).toHaveCount(1);
        await expect(page).toHaveURL(/workspaceTab=actions/);
      }
      expect(calls.every(c=>c.startsWith('GET ')&&!c.includes('/api/investigations'))).toBe(true);
    }
  });
}
// UI fixture only. Does not substitute for real-login approval/execution acceptance.
for(const [width,height] of [[1440,900],[1366,768],[1920,1080]]) {
  test(`MAX-683 action-only workspace ${width}x${height}: names, focus, paging, revocation`,async({page},testInfo)=>{
    await page.setViewportSize({width,height});
    const calls:string[]=[];
    await page.route('**/api/**',route=>{
      if(!new URL(route.request().url()).pathname.startsWith('/api/')) return route.fallback();
      calls.push(`${route.request().method()} ${new URL(route.request().url()).pathname}`);
      return route.fulfill({json:{items:[],partial:false,nextCursor:null,authorizedCounts:{total:0}}});
    });
    await page.route('**/workbench?**',route=>route.fulfill({contentType:'text/html',body:`<!doctype html><html lang="zh-CN"><body><script type="module">
      import '/src/app/styles.css';import '/src/app/ui/views/workbench.ts';
      const view=document.createElement('workbench-page');view.permissions=new Set(['operations:actions:view']);document.body.append(view);
      </script></body></html>`}));
    await page.goto('/workbench?workspaceTab=actions');
    await expect(page.getByRole('heading',{name:'AI 工作台',exact:true})).toBeVisible();
    await expect(page.getByRole('button',{name:'调查',exact:true})).toBeDisabled();
    const action=page.getByRole('button',{name:'行动计划',exact:true});
    await action.focus();await expect(action).toBeFocused();await page.keyboard.press('Tab');
    await expect(page.getByText('没有匹配计划',{exact:true})).toBeVisible();
    expect(calls.every(c=>c.startsWith('GET ')&&!c.includes('/api/investigations'))).toBe(true);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await page.screenshot({path:testInfo.outputPath('workbench.png'),fullPage:true});
    await page.evaluate(()=>window.dispatchEvent(new CustomEvent('slide-permissions-loaded',{detail:{permissions:[]}})));
    await expect(page.locator('operations-actions')).toHaveCount(0);
    await expect(page.getByText('无访问权限',{exact:true})).toBeVisible();
  });
}
