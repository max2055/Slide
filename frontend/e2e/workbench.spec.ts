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
    await expect(page.getByRole('heading',{name:'行动计划',exact:true})).toBeVisible();
    await expect(page.getByRole('button',{name:'调查列表',exact:true})).toBeDisabled();
    const action=page.getByRole('button',{name:'行动列表',exact:true});
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

for (const [width,height] of [[1366,768],[1440,900],[1920,1080]]) {
  test(`event workbench ${width}×${height} opens exact investigation and evidence`, async ({page}) => {
    const event = {id:22899,title:'模板事件：linux.filesystem.discovered_used_bytes',source_type:'template-trigger',
      status:'resolved',severity:'warning',created_at:'2026-11-20T00:58:45.000Z',alerts:[]};
    const current = {id:22900,title:'数据库连接数异常',status:'open',severity:'warning',created_at:'2026-11-20T01:00:00.000Z'};
    const investigation = {id:'31fb0e16-9b71-4fd5-a2f6-135ab1e84fc4',title:'事件只读调查',state:'completed',
      conclusion:'当时的正式样本确认事件恢复。',recommendation:'补采最新数据。',updatedAt:'2026-11-20T01:57:00Z',version:1};
    const running = {...investigation,id:'a68990d9-6647-4622-a797-997fb1b3a389',state:'running',conclusion:null,recommendation:null};
    let batchDenied = false;
    let exactRunning = false;
    let exactDenied = false;
    await page.setViewportSize({width,height});
    await page.route('**/api/**',route => {
      const url = new URL(route.request().url());
      const path = url.pathname;
      if (!path.startsWith('/api/')) return route.fallback();
      if (path === '/api/alerts/events/investigations') {
        if (batchDenied) return route.fulfill({status:403,json:{error:'FORBIDDEN'}});
        const ids = url.searchParams.get('ids')!.split(',').map(Number);
        return route.fulfill({json:{items:ids.map(eventId => ({eventId,investigation:eventId === event.id ? investigation : running}))}});
      }
      if (path === '/api/alerts/events') return route.fulfill({json:{items:[event,current]}});
      if (path === '/api/alerts/events/22899') return route.fulfill({json:event});
      if (path.endsWith('/logs')) return route.fulfill({json:[]});
      if (path.endsWith('/investigation')) return exactDenied ? route.fulfill({status:404,json:{error:'NOT_FOUND'}})
        : route.fulfill({json:{investigation:exactRunning ? running : investigation}});
      if (path === '/api/metrics/template-events/22899') return route.fulfill({json:{
        episode:{rule_id:'test',resource:{type:'server',id:5},state:'closed',opened:{at:event.created_at,value:7926996992},
          closed_at:'2026-11-20T00:59:02Z',last:{at:'2026-11-20T00:59:02Z',value:7910219776,quality:'good'}},
        snapshot:{configuration:{rules:[{rule_id:'test',metric:{id:'linux.filesystem.discovered_used_bytes',semantic_version:'1.0.0'},
          unit:'By',problem:{node:'compare',operator:'>=',threshold:{value:7918608384}},recovery:{node:'compare',operator:'<=',threshold:{value:7914414080}}}]},
          opening:{sample_ids:['formal-trigger']}},
        evaluation:{state:'stopped'},
      }});
      return route.fulfill({status:404,json:{error:'NOT_FOUND'}});
    });
    // Load the same Lit views as production with controlled authenticated HTTP responses.
    const fixture = (tag:string) => `<!doctype html><html lang="zh-CN"><body><script type="module">
      import '/src/app/styles.css'; import '/src/app/ui/views/${tag === 'workbench-page' ? 'workbench' : 'event-center'}.ts';
      const view=document.createElement('${tag}'); view.permissions=new Set(['chat:view','alert:view']); document.body.append(view);
    </script></body></html>`;
    await page.route('**/workbench*', route => !route.request().isNavigationRequest() ? route.fallback()
      : route.fulfill({contentType:'text/html',body:fixture('workbench-page')}));
    await page.route('**/events?**', route => !route.request().isNavigationRequest() ? route.fallback()
      : route.fulfill({contentType:'text/html',body:fixture('event-center-page')}));
    await page.goto('/workbench');
    const queue = page.getByRole('region',{name:'事件队列'});
    const panel = page.getByRole('region',{name:'所选事件'});
    await expect(panel.getByText('本次告警已恢复，资源现时健康待确认')).toBeVisible();
    const evidence = panel.getByRole('button',{name:/恢复样本/});
    await expect(evidence).toBeInViewport();
    await evidence.click();
    const drawer = page.getByRole('dialog',{name:'恢复样本'});
    await expect(drawer).toBeVisible();
    await expect(panel.locator('app-dialog .drawer-facts dd').filter({hasText:'7,910,219,776 字节'})).toBeVisible();
    await expect(panel.locator('app-dialog .drawer-facts dd').filter({hasText:'≤ 7,914,414,080'})).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(evidence).toBeFocused();
    await queue.getByRole('button',{name:/#22899/}).focus();
    await page.keyboard.press('ArrowDown');
    await expect(panel.getByRole('heading',{name:'数据库连接数异常'})).toBeVisible();
    await queue.getByRole('button',{name:'调查中',exact:true}).click();
    await expect(queue.getByRole('button',{name:/#22899/})).toHaveCount(0);
    await queue.getByRole('button',{name:'全部',exact:true}).click();
    await queue.getByRole('searchbox',{name:'搜索事件'}).fill('#22899');
    await expect(queue.getByRole('button',{name:/#22900/})).toHaveCount(0);
    await panel.getByRole('link',{name:'打开事件详情'}).click();
    await expect(page.getByRole('link',{name:'打开原调查'})).toHaveAttribute('href',new RegExp(investigation.id));
    await expect(page.getByRole('link',{name:'返回工作台'})).toBeVisible();
    await expect(page.getByText('补采最新数据。')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('slide-permissions-loaded',{detail:{permissions:[]}})));
    await expect(page.getByText('无访问权限',{exact:true})).toBeVisible();
    await expect(page.getByText('补采最新数据。')).toHaveCount(0);
    if (width === 1440) {
      batchDenied = true;
      await page.goto('/workbench');
      await expect(page.getByRole('alert')).toHaveText('访问权限已变更。');
      await expect(page.getByRole('button',{name:/#22899/})).toHaveCount(0);
      exactRunning = true;
      await page.goto('/events?view=aggregate&eventId=22899');
      await expect(page.getByText('正在调查',{exact:true})).toBeVisible();
      await page.getByRole('button',{name:/恢复样本/}).click();
      await expect(page.getByRole('dialog',{name:'恢复样本'})).toBeVisible();
      exactDenied = true;
      await expect(page.getByRole('alert')).toHaveText('事件不可访问或已不存在。',{timeout:8000});
      await expect(page.getByRole('dialog',{name:'恢复样本'})).toHaveCount(0);
      await expect(page.getByRole('button',{name:/触发样本/})).toHaveCount(0);
    }
  });
}
