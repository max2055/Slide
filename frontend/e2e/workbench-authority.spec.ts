import { test, expect } from '@playwright/test';
import { startInvestigationServer } from './fixtures/investigation-server.ts';

// Full application + password/JWT/live SQL authority. The action-list payload is
// deliberately empty and controlled: this tests login timing, not real operations.
let env: Awaited<ReturnType<typeof startInvestigationServer>>;
test.beforeAll(async () => {
  env = await startInvestigationServer();
  await env.pool.query('DELETE FROM role_permissions WHERE role_id=101');
  await env.pool.query("INSERT INTO role_permissions(role_id,permission_id) SELECT 101,id FROM permissions WHERE code='operations:actions:view'");
});
test.afterAll(async () => {
  if (env) try { expect(env.counts()).toEqual({toolCalls:0,providerCalls:0}); } finally { await env.close(); }
});
for (const context of ['', '?investigation=exact&version=7', '?entry=exact']) test(`first password login and uncached refresh with delayed authority ${context || 'plain'}`, async ({page}) => {
  await page.addInitScript(() => {
    localStorage.setItem('slide.i18n.locale','zh-CN');
    localStorage.setItem('slide.control.settings.v1:default',JSON.stringify({locale:'zh-CN',defaultHomeTab:'investigations'}));
    localStorage.removeItem('permissions');
  });
  const writes:string[]=[];
  page.on('request',request=>{ if(request.method()!=='GET' && /\/api\/(investigations|operations)\//.test(request.url())) writes.push(request.url()); });
  await page.route('**/api/operations/actions/plans*',route=>route.fulfill({json:{items:[],partial:false,nextCursor:null}}));
  let release!:()=>void;
  let gate=new Promise<void>(resolve=>release=resolve);
  await page.route('**/api/auth/permissions',async route=>{
    const response=await route.fetch();
    expect(response.status()).toBe(200); expect(await response.json()).toEqual(['operations:actions:view']);
    await gate; await route.fulfill({response});
  });
  try {
    await page.goto(`${env.url}/workbench${context}`);
    await page.getByLabel('用户名',{exact:true}).fill('t06-owner');
    await page.getByLabel('密码',{exact:true}).fill(env.ownerPassword);
    const logged=page.waitForResponse(r=>r.url().endsWith('/api/auth/login'));
    await page.getByRole('button',{name:'登录',exact:true}).click();
    expect((await logged).status()).toBe(200);
    release();
    for(const refresh of [false,true]) {
      if(refresh) {
        gate=new Promise<void>(resolve=>release=resolve);
        await page.goto(`${env.url}/workbench${context}`); await page.reload(); release();
      }
      await expect(page.locator('workbench-page')).toBeVisible();
      if(context) {
        await expect(page.locator('workbench-page operations-actions')).toHaveCount(0);
        await expect(page.locator('workbench-page')).toContainText('无访问权限');
        expect(new URL(page.url()).search).toBe(context);
      } else {
        await expect(page.locator('operations-actions')).toBeVisible();
        await expect(page).toHaveURL(/\/workbench\?workspaceTab=actions$/);
      }
    }
    expect(writes).toEqual([]);
  } finally { release(); }
});
