import { expect, test, type Page } from '@playwright/test';

const at = '2026-11-21T00:00:00.000Z';
const template = { template_id:'tpl-linux', name:'Linux 服务器', revision:1, current_published_version:1 };
const item = { item_id:'uptime', version:1, display_name:'系统运行时长', canonical_metric:{id:'linux.uptime.seconds',semantic_version:'1.0.0'}, unit:'s', dimensions:{} };
const aggregate = {
  items:[{item_id:'uptime',version:1}], parameters:{defaults:{interval_ms:20000},schema:{}}, triggers:[],
  discovery_rules:[{rule_id:'filesystems',name:'挂载点发现',item_ids:['uptime'],max_instances:10,lost_after_ms:60000,retire_after_ms:3600000}],
};
const current = { template_id:'tpl-linux', version:1, published_at:at, aggregate, items:[item] };

async function setup(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('token', `fixture.${btoa(JSON.stringify({ userId:1,sessionVersion:1 }))}.fixture`);
    localStorage.setItem('permissions', '["*"]');
    localStorage.setItem('slide.i18n.locale', 'zh-CN');
  });
  await page.routeWebSocket('**/agent-ws', socket => socket.onMessage(message => {
    if (JSON.parse(String(message)).type === 'auth') socket.send(JSON.stringify({type:'auth_ok'}));
  }));
  await page.route('**/__slide/control-ui-config.json', route => route.fulfill({json:{}}));
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (!path.startsWith('/api/')) return route.fallback();
    if (path === '/api/auth/permissions') return route.fulfill({json:['*']});
    if (path.endsWith('/library')) return route.fulfill({json:{ can_manage:true,templates:[
      {template,builtin:false,resource_types:['server'],item_count:1,trigger_count:0,discovery_count:1},
      {template:{...template,template_id:'tpl-mysql',name:'MySQL 数据库'},builtin:true,resource_types:['instance'],
        item_count:1,trigger_count:0,discovery_count:0},
    ] }});
    if (path.endsWith('/editor')) return route.fulfill({json:{template,current,can_manage:true,builtin:false,
      items:[item],versions:[current],draft:{revision:1,aggregate},
      retention:{mode:'apply',history_ms:2592000000,trends_ms:31536000000,by_value_type:[]}}});
    return route.fulfill({json:{}});
  });
}

for (const [width,height] of [[1366,768],[1440,900],[1920,1080]]) {
  test(`template list and detail at ${width} × ${height}`, async ({page}) => {
    await page.setViewportSize({width,height});
    await setup(page);
    await page.goto('/settings/monitoring/metrics?view=policies');
    await expect(page).toHaveURL(/\/settings\/monitoring\/metrics$/);
    const templates = page.locator('template-library');
    await expect(templates.getByRole('heading',{name:'监控模板',exact:true})).toBeVisible();
    await expect(templates.getByRole('button',{name:'新建模板'})).toBeInViewport();
    await expect(page.getByRole('tab',{name:/指标目录|采集策略|变更审计/})).toHaveCount(0);
    await expect(templates.locator('template-governance')).toHaveCount(0);

    await templates.getByLabel('资源类型').selectOption('server');
    await expect(templates.getByRole('button',{name:'MySQL 数据库'})).toHaveCount(0);
    await templates.getByRole('button',{name:'Linux 服务器 自动发现'}).click();
    await expect(templates.getByRole('heading',{name:'Linux 服务器'})).toBeVisible();
    await expect(templates.getByRole('tab',{name:'自动发现 1'})).toHaveAttribute('aria-selected','true');
    await expect(templates.getByText('挂载点发现',{exact:true})).toBeVisible();
    await expect(templates.getByText('20 秒',{exact:true})).toBeVisible();
    await expect(templates.getByText('30 天',{exact:true})).toBeVisible();
    await expect(templates.getByText('365 天',{exact:true})).toBeVisible();
    await expect(templates.getByRole('button',{name:'克隆',exact:true})).toBeInViewport();
    await expect(templates.getByLabel('模板名称',{exact:true})).toHaveCount(0);

    await templates.getByRole('button',{name:'编辑',exact:true}).click();
    await templates.getByLabel('采集周期（秒）').fill('30');
    await templates.getByRole('button',{name:'‹ 返回监控模板',exact:true}).click();
    await expect(templates.getByRole('dialog',{name:'放弃未保存修改？'})).toBeVisible();
    await templates.getByRole('button',{name:'放弃修改',exact:true}).click();
    await expect(templates.getByRole('button',{name:'Linux 服务器',exact:true})).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}
