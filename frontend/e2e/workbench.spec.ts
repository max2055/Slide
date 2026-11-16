import { test, expect } from '@playwright/test';
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
