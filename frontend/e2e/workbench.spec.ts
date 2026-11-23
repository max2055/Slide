import { test, expect } from '@playwright/test';
import type { LinkedInvestigation } from '../src/app/ui/controllers/event-investigation-api.ts';
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
    const investigation: LinkedInvestigation = {id:'31fb0e16-9b71-4fd5-a2f6-135ab1e84fc4',title:'事件只读调查',state:'completed',
      conclusion:'当时的正式样本确认事件恢复。',recommendation:'仅只读补查触发时刻附近的更窄窗口与采集状态字段（capability/attempt/coverage/freshness）。',updatedAt:'2026-11-20T01:57:00Z',version:1};
    const running: LinkedInvestigation = {...investigation,id:'a68990d9-6647-4622-a797-997fb1b3a389',state:'running',conclusion:null,recommendation:null};
    let batchDenied = false;
    let exactLink: LinkedInvestigation | null = investigation;
    let exactDenied = false;
    await page.setViewportSize({width,height});
    const writes: string[] = [];
    await page.route('**/api/**',route => {
      const url = new URL(route.request().url());
      const path = url.pathname;
      if (!path.startsWith('/api/')) return route.fallback();
      if (route.request().method() !== 'GET') writes.push(path);
      if (path === '/api/alerts/events/investigations') {
        if (batchDenied) return route.fulfill({status:403,json:{error:'FORBIDDEN'}});
        const ids = url.searchParams.get('ids')!.split(',').map(Number);
        return route.fulfill({json:{items:ids.map(eventId => ({eventId,investigation:eventId === event.id ? investigation : running}))}});
      }
      if (path === '/api/alerts/events') return route.fulfill({json:{items:[event,current]}});
      if (path === '/api/alerts/events/22899') return route.fulfill({json:event});
      if (path.endsWith('/logs')) return route.fulfill({json:[]});
      if (path.endsWith('/investigation')) return exactDenied ? route.fulfill({status:404,json:{error:'NOT_FOUND'}})
        : route.fulfill({json:{investigation:exactLink}});
      if (path === '/api/metrics/template-events/22899') return route.fulfill({json:{
        episode:{rule_id:'test',resource:{type:'server',id:5},state:'closed',opened:{at:event.created_at,value:7926996992},
          closed_at:'2026-11-20T00:59:02Z',last:{at:'2026-11-20T00:59:02Z',value:7910219776,quality:'good'}},
        snapshot:{configuration:{rules:[{rule_id:'test',metric:{id:'linux.filesystem.discovered_used_bytes',semantic_version:'1.0.0'},
          unit:'By',problem:{node:'compare',operator:'>=',threshold:{value:7918608384}},recovery:{node:'compare',operator:'<=',threshold:{value:7914414080}}}]},
          opening:{sample_ids:['formal-trigger'],samples:[{id:'formal-trigger',
            metric:{id:'linux.filesystem.discovered_used_bytes',semantic_version:'1.0.0'},
            value:{encoding:'uint64',value:'7926996992'},unit:'By',observed_at:event.created_at,
            window:{from:'2026-11-20T00:57:45.000Z',to:event.created_at}}]}},
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
    const record = page.locator('event-investigation-record');
    await expect(record.getByRole('region',{name:'告警事实与证据缺口'})).toContainText('现有记录未确认恢复后的资源状态');
    await expect(record.getByRole('complementary',{name:'建议下一步'})).toContainText('核对触发时的文件系统已用空间采集记录');
    await expect(record.getByText(investigation.recommendation!)).not.toBeVisible();
    const recommendation = record.getByRole('button',{name:'查看建议详情'});
    await recommendation.focus(); await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog',{name:'调查处理建议'})).toBeVisible();
    const advice = record.locator('app-dialog');
    await expect(advice.getByText('触发样本窗口')).toBeVisible();
    await expect(advice.getByText('文件系统已用空间',{exact:true})).toBeVisible();
    await advice.getByText('展开已保存的调查原文',{exact:true}).click();
    await expect(advice.getByText(investigation.recommendation!)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(recommendation).toBeFocused();
    await record.getByRole('button',{name:'时间线',exact:true}).click();
    await expect(record.getByText('当前评估已停止。',{exact:true})).toBeVisible();
    await expect(record.getByRole('list',{name:'事件时间线'})).not.toContainText('当前评估已停止');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('slide-permissions-loaded',{detail:{permissions:[]}})));
    await expect(page.getByText('无访问权限',{exact:true})).toBeVisible();
    await expect(page.getByText(investigation.recommendation!)).toHaveCount(0);
    if (width === 1440) {
      batchDenied = true;
      await page.goto('/workbench');
      await expect(page.getByRole('alert')).toHaveText('访问权限已变更。');
      await expect(page.getByRole('button',{name:/#22899/})).toHaveCount(0);
      exactLink = null;
      await page.goto('/events?view=aggregate&eventId=22899');
      await expect(page.getByText('暂无可见调查',{exact:true})).toBeVisible();
      await expect(record.getByRole('link',{name:'打开原调查'})).toHaveCount(0);
      exactLink = {...investigation,state:'insufficient'};
      await page.reload();
      await expect(page.getByText('证据不足',{exact:true})).toBeVisible();
      exactLink = running;
      await page.reload();
      await expect(page.getByText('正在调查',{exact:true})).toBeVisible();
      await page.getByRole('button',{name:/恢复样本/}).click();
      await expect(page.getByRole('dialog',{name:'恢复样本'})).toBeVisible();
      exactDenied = true;
      await expect(page.getByRole('alert')).toHaveText('事件不可访问或已不存在。',{timeout:8000});
      await expect(page.getByRole('dialog',{name:'恢复样本'})).toHaveCount(0);
      await expect(page.getByRole('button',{name:/触发样本/})).toHaveCount(0);
    }
    expect(writes).toEqual([]);
  });
}

test('authorized action source opens a draft without creating or executing a plan', async ({ page }) => {
  test.skip(!process.env.MAX202_MYSQL_PORT, 'Requires a task-owned isolated MySQL via MAX202_MYSQL_PORT');
  test.setTimeout(60_000);
  const { startOperationsServer } = await import('./fixtures/operations-server.ts');
  const env = await startOperationsServer();
  try {
    const writes: string[] = [];
    page.on('request', request => {
      const path = new URL(request.url()).pathname;
      if (request.method() !== 'GET' && /^\/api\/(investigations|operations)\b/.test(path)) writes.push(path);
    });
    await page.addInitScript(({ token, actor }) => {
      localStorage.setItem('token', token);
      localStorage.setItem('user', JSON.stringify({ id: actor.userId, username: actor.username }));
      localStorage.setItem('permissions', JSON.stringify(actor.permissions));
      localStorage.setItem('slide.control.settings.v1:default', JSON.stringify({ locale: 'zh-CN', navCollapsed: true }));
    }, { token: env.token(), actor: env.author });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${env.url}/workbench?investigation=${env.actionSource.inv.id}`);
    await page.getByRole('link', { name: '查看关联计划或整理当前结果草案' }).click();
    const actions = page.locator('operations-actions');
    await expect(actions.getByRole('region', { name: '行动计划表' })).toContainText('重启专用演练服务');
    await expect(actions.getByLabel('草案目标服务器')).toBeVisible();
    await expect(actions.getByLabel('打开计划', { exact: true })).not.toBeVisible();
    await actions.getByLabel('计划状态筛选').selectOption('approved');
    await expect(actions.getByText('没有匹配计划', { exact: true })).toBeVisible();
    await expect(actions.getByRole('link', { name: '返回来源调查', exact: true })).toHaveAttribute('href', `/workbench?investigation=${env.actionSource.inv.id}`);
    const advanced = actions.getByText('按计划标识打开（高级）', { exact: true });
    await advanced.focus();
    await page.keyboard.press('Enter');
    await expect(actions.getByLabel('打开计划', { exact: true })).toBeVisible();
    expect(writes).toEqual([]);
    expect(env.sends()).toBe(0);
    await page.screenshot({path:test.info().outputPath('action-source-1440.png')});
  } finally {
    await page.close();
    await env.close();
  }
});

test('recovered template event reads live evidence through the normal workbench menu', async ({ page }) => {
  test.skip(!process.env.T06_TEST_MYSQL_PORT, 'Requires a task-owned isolated MySQL via T06_TEST_MYSQL_PORT');
  test.setTimeout(60_000);
  const { startInvestigationServer } = await import('./fixtures/investigation-server.ts');
  const env = await startInvestigationServer({ attentionPilot: true });
  try {
    const triggerAt = '2026-11-20T00:58:45.000Z', recoveryAt = '2026-11-20T00:59:00.000Z';
    const metric = { id: 'mysql.processlist.count', semantic_version: '1.0.0' };
    const rule = { rule_id: 'max720-sample-rule', version: 1, body_hash: 'sha256:' + '1'.repeat(64), scope: 'item', metric, unit: 'count',
      problem: { node: 'compare', operator: '>', threshold: { value: 15 } }, recovery_mode: 'problem_expression' };
    const [event] = await env.pool.query(`INSERT INTO alert_events(event_id,instance_id,title,severity,status,source_type)
      VALUES(UUID(),101,?,'warning','resolved','template-trigger')`, [`模板事件：${metric.id}`]);
    const [alert] = await env.pool.query(`INSERT INTO alerts(instance_id,alert_type,level,title,message,status)
      VALUES(101,'performance','warning','合成指标事件','合成触发样本','resolved')`);
    const episode = {
      rule_id: rule.rule_id, version: rule.version, body_hash: rule.body_hash, scope: rule.scope,
      resource: { type: 'instance', id: '101' }, state: 'closed', recovery_count: 1, closed_at: recoveryAt,
      opened: { at: triggerAt, metric, value: 20 }, last: { at: recoveryAt, value: 10, quality: 'good', dimensions: {} },
    };
    const snapshot = { configuration: { rules: [rule] },
      opening: { dimensions: {}, sample_ids: ['synthetic-trigger'], samples: [
        { id: 'synthetic-trigger', metric, unit: 'count', value: { encoding: 'uint64', value: '20' },
          observed_at: triggerAt, window: { from: '2026-11-20T00:58:00.000Z', to: triggerAt } },
      ] } };
    await env.pool.query(`INSERT INTO metric_trigger_episodes(episode_id,identity_hash,resource_key,config_revision,event_id,alert_id,payload,snapshot)
      VALUES(?,?,'instance:101',1,?,?,?,?)`, ['sha256:' + 'a'.repeat(64), 'sha256:' + 'b'.repeat(64),
      event.insertId, alert.insertId, JSON.stringify(episode), JSON.stringify(snapshot)]);
    const writes: string[] = [];
    page.on('request', request => {
      const path = new URL(request.url()).pathname;
      if (request.method() !== 'GET' && /^\/api\/(alerts|metrics|investigations|operations)\b/.test(path)) writes.push(path);
    });
    await page.addInitScript(({ token, actor }) => {
      localStorage.setItem('token', token);
      localStorage.setItem('user', JSON.stringify({ id: actor.userId, username: actor.username }));
      localStorage.setItem('permissions', JSON.stringify(actor.permissions));
      localStorage.setItem('slide.control.settings.v1:default', JSON.stringify({ locale: 'zh-CN' }));
    }, { token: env.token(), actor: env.owner });
    await page.goto(env.url);
    await page.getByRole('link', { name: 'AI 工作台', exact: true }).click();
    const home = page.getByRole('navigation', { name: '工作台页签' }).getByRole('button', { name: '工作台', exact: true });
    if (await home.getAttribute('aria-pressed') !== 'true') await home.click();
    const record = page.locator('event-investigation-record');
    await expect(record.getByRole('heading', { name: '本次告警已恢复，资源现时健康待确认' })).toBeVisible();
    await expect(record.getByText('暂无可见调查', { exact: true })).toBeVisible();
    for (const [width,height] of [[1366,768],[1440,900],[1920,1080]]) {
      await page.setViewportSize({ width, height });
      await expect(record.getByRole('button', { name: '查看建议详情' })).toBeInViewport();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({path:test.info().outputPath(`recovered-${width}.png`)});
    }
    await record.getByRole('link', { name: '打开事件详情' }).click();
    await record.getByRole('button', { name: '查看建议详情' }).click();
    await expect(record.locator('app-dialog').getByText('触发样本窗口')).toBeVisible();
    await page.keyboard.press('Escape');
    await record.getByRole('button', { name: /^证据（/ }).click();
    await expect(record.getByRole('button', { name: /^恢复样本/ })).toBeVisible();
    const denied = await page.request.get(`${env.url}/api/metrics/template-events/${event.insertId}`);
    expect(denied.status()).toBe(401);
    expect(writes).toEqual([]);
    expect(env.counts()).toEqual({ toolCalls: 0, providerCalls: 0 });
  } finally {
    await page.close();
    await env.close();
  }
});
