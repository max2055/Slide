import {test,expect} from '@playwright/test';
import {writeFile} from 'node:fs/promises';
import {startInvestigationServer} from './fixtures/investigation-server.ts';

// MAX-683 independent review: recreate authorized pages after a detail refresh.
// Actual SQL/JWT/HTTP/full shell, synthetic records; no model or target calls.
for (const viewport of [{width:1366,height:768},{width:1440,height:900},{width:1920,height:1080}]) {
test(`investigation page two restores visible focus at ${viewport.width} and missing/revoked rows fall back`,async({page})=>{
  await page.setViewportSize(viewport);
  const env=await startInvestigationServer();
  try {
    for(let i=0;i<25;i++) {
      await env.bridge.create(env.owner,{title:`MAX683返回矩阵 ${i}`,goal:'只读导航验收',profileId:'ops',profileVersion:1,
        resources:[{type:'instance',id:101,role:'primary'}],context:{subject:{kind:'resource',resource:{type:'instance',id:101}}},idempotencyKey:crypto.randomUUID()});
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
    const pageIds=await page.locator('button[data-investigation]').evaluateAll(rows=>rows.map(row=>row.getAttribute('data-investigation')));
    const row=page.locator('button[data-investigation]').last();const id=await row.getAttribute('data-investigation');
    await row.click();await expect(page.locator('.investigation-detail-title')).toBeVisible();
    await page.reload();await expect(page.locator('.investigation-detail-title')).toBeVisible();
    await page.getByRole('link',{name:'返回来源页面',exact:true}).click();
    await expect(page.locator('button[data-investigation]')).toHaveCount(25);
    expect(await page.locator('button[data-investigation]').evaluateAll(rows=>rows.map(row=>row.getAttribute('data-investigation')))).toEqual(pageIds);
    await expect(page.locator(`button[data-investigation="${id}"]`)).toBeFocused();
    const assertFilters=async()=>{
      const query=new URL(page.url()).searchParams;
      expect(query.get('query')).toBe('MAX683返回矩阵');
      expect(query.get('state')).toBe('open');
      expect(query.get('workspaceTab')).toBe('investigations');
      await expect(page.getByRole('textbox',{name:'搜索调查',exact:true})).toHaveValue('MAX683返回矩阵');
      await expect(page.getByRole('combobox',{name:'调查状态',exact:true})).toHaveValue('open');
    };
    await assertFilters();
    await expect(page.locator(`button[data-investigation="${id}"]`)).toBeInViewport({ratio:1});
    await page.goForward();
    await expect(page.locator('.investigation-detail-title')).toBeVisible();
    await page.reload();
    await expect(page.locator('.investigation-detail-title')).toBeVisible();
    await page.getByRole('link',{name:'返回来源页面',exact:true}).click();
    await expect(page.locator('button[data-investigation]')).toHaveCount(25);
    await expect(page.locator(`button[data-investigation="${id}"]`)).toBeFocused();
    await expect(page.locator(`button[data-investigation="${id}"]`)).toBeInViewport({ratio:1});
    await assertFilters();
    const measure=async(name:string)=>{
      const geometry=await page.evaluate(()=>{
        const target=document.activeElement!;const rect=target.getBoundingClientRect();
        const main=document.querySelector('main.content')!;const container=main.getBoundingClientRect();
        return {tag:target.tagName,key:(target as HTMLElement).dataset.workbenchKey,top:rect.top,bottom:rect.bottom,
          height:innerHeight,windowY:scrollY,containerTop:container.top,containerBottom:container.bottom,containerScrollTop:main.scrollTop,
          visibleHeight:Math.max(0,Math.min(rect.bottom,container.bottom,innerHeight)-Math.max(rect.top,container.top,0))};
      });
      expect(geometry.visibleHeight).toBeCloseTo(geometry.bottom-geometry.top,1);
      await writeFile(test.info().outputPath(`${name}.json`),JSON.stringify({viewport,...geometry},null,2));
      await page.screenshot({path:test.info().outputPath(`${name}.png`)});
    };
    await measure('original-row');
    await page.locator(`button[data-investigation="${id}"]`).click();await expect(page.locator('.investigation-detail-title')).toBeVisible();
    await env.pool.query("UPDATE investigations SET lifecycle='closed' WHERE id=?",[id]);
    await page.reload();await expect(page.locator('.investigation-detail-title')).toBeVisible();
    await page.getByRole('link',{name:'返回来源页面',exact:true}).click();
    await expect(page.locator('button[data-investigation]')).toHaveCount(24);
    await expect(page.locator(`button[data-investigation="${id}"]`)).toHaveCount(0);
    await expect.poll(()=>page.evaluate(()=>document.activeElement?.tagName)).not.toBe('BODY');
    expect(await page.evaluate(()=>{const r=document.activeElement!.getBoundingClientRect();return r.height>0&&r.bottom>0&&r.top<innerHeight;})).toBe(true);
    await assertFilters();
    await measure('missing-row-focus');
    await page.locator('button[data-investigation]').last().click();
    await expect(page.locator('.investigation-detail-title')).toBeVisible();
    await env.pool.query('DELETE FROM instance_permissions WHERE user_id=101 AND instance_id=101');
    // Live revocation may remove the detail and its return link first.
    await page.goBack();
    await expect(page.locator('button[data-investigation]')).toHaveCount(0);
    await expect.poll(()=>page.evaluate(()=>document.activeElement?.tagName)).not.toBe('BODY');
    await assertFilters();
    await measure('revoked-row-focus');
    // MAX-684: losing this resource must clear rows, not invalidate the login.
    expect(await page.evaluate(() => Boolean(localStorage.getItem('token')))).toBe(true);
    const listStatus = await page.evaluate(async () => (await fetch('/api/investigations', {
      headers: { Authorization: `Bearer ${localStorage.getItem('token')}` },
    })).status);
    expect(listStatus).toBe(200);
    expect(env.counts()).toEqual({toolCalls:0,providerCalls:0});
  } finally {await page.close();await env.close();}
});

}
