import {test,expect} from '@playwright/test';
import {startInvestigationServer} from './fixtures/investigation-server.ts';

// MAX-683 independent review: recreate authorized pages after a detail refresh.
// Actual SQL/JWT/HTTP/full shell, synthetic records; no model or target calls.
test('investigation page two survives detail refresh and missing row has visible fallback focus',async({page})=>{
  const env=await startInvestigationServer();
  try {
    const ids:string[]=[];
    for(let i=0;i<25;i++) {
      const created=await env.bridge.create(env.owner,{title:`MAX683返回矩阵 ${i}`,goal:'只读导航验收',profileId:'ops',profileVersion:1,
        resources:[{type:'instance',id:101,role:'primary'}],context:{subject:{kind:'resource',resource:{type:'instance',id:101}}},idempotencyKey:crypto.randomUUID()});
      ids.push(created.investigation.id);
    }
    await page.addInitScript(({token,actor})=>{
      localStorage.setItem('token',token);localStorage.setItem('user',JSON.stringify({id:actor.userId,username:actor.username}));
      localStorage.setItem('permissions',JSON.stringify(actor.permissions));
      localStorage.setItem('slide.control.settings.v1:default',JSON.stringify({locale:'zh-CN',navCollapsed:true}));
    },{token:env.token(env.owner),actor:env.owner});
    await page.goto(`${env.url}/workbench?workspaceTab=investigations&query=MAX683返回矩阵&state=open`);
    await expect(page.locator('button[data-investigation]')).toHaveCount(20);
    await page.getByRole('button',{name:'加载更多调查',exact:true}).click();
    await expect(page.locator('button[data-investigation]')).toHaveCount(25);
    const row=page.locator('button[data-investigation]').last();const id=await row.getAttribute('data-investigation');
    await row.click();await expect(page.locator('.investigation-detail-title')).toBeVisible();
    await page.reload();await expect(page.locator('.investigation-detail-title')).toBeVisible();
    await page.getByRole('link',{name:'返回来源页面',exact:true}).click();
    await expect(page.locator('button[data-investigation]')).toHaveCount(25);
    await expect(page.locator(`button[data-investigation="${id}"]`)).toBeFocused();
    expect(new URL(page.url()).searchParams.get('query')).toBe('MAX683返回矩阵');
    await page.locator(`button[data-investigation="${id}"]`).click();await expect(page.locator('.investigation-detail-title')).toBeVisible();
    await env.pool.query("UPDATE investigations SET lifecycle='closed' WHERE id=?",[id]);
    await page.reload();await expect(page.locator('.investigation-detail-title')).toBeVisible();
    await page.getByRole('link',{name:'返回来源页面',exact:true}).click();
    await expect(page.locator('button[data-investigation]')).toHaveCount(24);
    await expect(page.locator(`button[data-investigation="${id}"]`)).toHaveCount(0);
    await expect.poll(()=>page.evaluate(()=>document.activeElement?.tagName)).not.toBe('BODY');
    expect(await page.evaluate(()=>{const r=document.activeElement!.getBoundingClientRect();return r.height>0&&r.bottom>0&&r.top<innerHeight;})).toBe(true);
    await page.screenshot({path:test.info().outputPath('missing-row-focus.png')});
    expect(env.counts()).toEqual({toolCalls:0,providerCalls:0});
  } finally {await page.close();await env.close();}
});
