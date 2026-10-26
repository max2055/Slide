#!/usr/bin/env node
/* MAX-241 原型验证脚本（零依赖，直接用 Chrome DevTools Protocol）。
   用法：
     node docs/slide/development/MAX-241/verify/run-checks.mjs <原型URL根> <截图输出目录>
   例：
     (cd docs/slide/development/MAX-241/prototype && python3 -m http.server 8971 --bind 127.0.0.1)
     node docs/slide/development/MAX-241/verify/run-checks.mjs http://127.0.0.1:8971 /Users/max/Coding/40-Slide/outputs/MAX-241-2026-10-26/screenshots
   脚本只读取原型页面与截图，不修改产品代码，不访问后端。
*/
import { spawn } from 'node:child_process';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const BASE = process.argv[2] ?? 'http://127.0.0.1:8971';
const OUT = process.argv[3] ?? './screenshots';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9333;
const PROFILE = '/tmp/max241-cdp-profile';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.events = new Map(); }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    const cdp = new Cdp(ws);
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && cdp.pending.has(msg.id)) {
        const { resolve, reject } = cdp.pending.get(msg.id);
        cdp.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      } else if (msg.method) {
        const list = cdp.events.get(msg.method) ?? [];
        list.forEach((resolve) => resolve(msg.params));
        cdp.events.delete(msg.method);
      }
    };
    return cdp;
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  once(method) { return new Promise((resolve) => this.events.set(method, [...(this.events.get(method) ?? []), resolve])); }
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text ?? 'evaluate failed');
    return result.result.value;
  }
}

async function waitForChrome() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const targets = await res.json();
      const page = targets.find((t) => t.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch { /* not ready */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('Chrome DevTools endpoint not ready');
}

async function main() {
  if (!existsSync(CHROME)) throw new Error(`Chrome not found: ${CHROME}`);
  await mkdir(OUT, { recursive: true });
  await rm(PROFILE, { recursive: true, force: true });
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--hide-scrollbars',
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`, '--window-size=1440,900',
    'about:blank'
  ], { stdio: 'ignore' });
  const wsUrl = await waitForChrome();
  const cdp = await Cdp.connect(wsUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  async function open(query, width, height) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    const loaded = cdp.once('Page.loadEventFired');
    await cdp.send('Page.navigate', { url: `${BASE}/index.html?${query}` });
    await loaded;
    await new Promise((r) => setTimeout(r, 250));
  }

  async function shot(name, fullPage = false) {
    let clip;
    if (fullPage) {
      const metrics = await cdp.send('Page.getLayoutMetrics');
      const size = metrics.cssContentSize ?? metrics.contentSize;
      clip = { x: 0, y: 0, width: size.width, height: Math.min(size.height, 4000), scale: 1 };
    }
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: fullPage, ...(clip ? { clip } : {}) });
    await writeFile(path.join(OUT, `${name}.png`), Buffer.from(data, 'base64'));
  }

  const SIZES = { '1440x900': [1440, 900], '1366x768': [1366, 768], '1920x1080': [1920, 1080] };

  // ---------- 1. 列表：八列、四操作、局部横滚、无整页溢出 ----------
  const EXPECTED = {
    db: ['序号', '实例', '地址', '版本', '观测健康', '采集状态', '最近成功采集', '操作'],
    server: ['序号', '主机名称', '地址', '系统版本', '观测健康', '采集状态', '最近成功采集', '操作'],
    network: ['序号', '设备', '地址', '型号', '观测健康', '采集状态', '最近成功采集', '操作']
  };
  for (const cls of ['db', 'server', 'network']) {
    await open(`class=${cls}&view=list&state=normal`, 1440, 900);
    const headers = await cdp.evaluate(`[...document.querySelectorAll('.data-table thead th')].map(th => th.textContent.trim())`);
    const business = headers.filter((h) => h !== '选择');
    check(`[${cls}] 列表业务列为八列`, business.length === 8, business.join(' / '));
    check(`[${cls}] 八列名称符合要求`, EXPECTED[cls].every((label, i) => business[i] === label), business.join(' / '));
    const actionCount = await cdp.evaluate(`document.querySelector('.data-table tbody tr').querySelectorAll('.actions button').length`);
    check(`[${cls}] 行内四操作完整展示`, actionCount === 4, `buttons=${actionCount}`);
    const noPageOverflow = await cdp.evaluate(`document.documentElement.scrollWidth <= window.innerWidth`);
    check(`[${cls}] 1440×900 无整页横向溢出`, noPageOverflow === true);
    const localScroll = await cdp.evaluate(`(() => { const s = document.querySelector('.table-scroll'); return { scrollable: s.scrollWidth > s.clientWidth, region: s.getAttribute('role'), label: s.getAttribute('aria-label') }; })()`);
    check(`[${cls}] 表格具备局部横滚容器`, localScroll.region === 'region' && Boolean(localScroll.label), `scrollable@1440=${localScroll.scrollable}`);
    await shot(`${cls}-list-1440x900`);
  }

  // ---------- 2. 详情页签集合与顺序 ----------
  const TABS = {
    db: ['概览', '监控配置', '指标与趋势', '健康评分', '慢查询', '会话', '容量', '表结构', '索引', 'SQL 审核', '日志', '查询分析', 'AI 诊断'],
    server: ['概览', '监控配置', '指标与趋势', '配置', '诊断', '网络', '进程', '服务', '日志', '关联资源'],
    network: ['概览', '指标与趋势', '接口', '关联资源', '配置备份', '监控配置']
  };
  for (const cls of ['db', 'server', 'network']) {
    await open(`class=${cls}&view=detail&tab=overview`, 1440, 900);
    const tabs = await cdp.evaluate(`[...document.querySelectorAll('.tab')].map(t => t.textContent.replace(/\\d+$/, '').trim())`);
    check(`[${cls}] 详情页签集合与顺序`, JSON.stringify(tabs) === JSON.stringify(TABS[cls]), tabs.join(' / '));
    const hasInvestigation = await cdp.evaluate(`!!document.querySelector('.links-row')`);
    check(`[${cls}] 详情保留关联调查/事件/审计联动行`, hasInvestigation === true);
    await shot(`${cls}-detail-overview-1440x900`);
  }

  // ---------- 3. 键盘：页签方向键与焦点环 ----------
  await open('class=db&view=detail&tab=overview', 1440, 900);
  await cdp.evaluate(`document.getElementById('tab-overview').focus()`);
  const key = (type) => cdp.send('Input.dispatchKeyEvent', { type, key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39, nativeVirtualKeyCode: 39 });
  await key('keyDown'); await key('keyUp');
  await new Promise((r) => setTimeout(r, 120));
  const afterRight = await cdp.evaluate(`({ id: document.activeElement.id, selected: [...document.querySelectorAll('.tab')].find(t => t.getAttribute('aria-selected') === 'true')?.id })`);
  check('页签 ArrowRight 切换到下一项并保持焦点', afterRight.id === 'tab-collection' && afterRight.selected === 'tab-collection', JSON.stringify(afterRight));
  const focusRing = await cdp.evaluate(`getComputedStyle(document.getElementById('tab-collection')).outlineStyle`);
  check('页签可获得可见焦点环', focusRing !== 'none', `outline-style=${focusRing}`);
  await shot('db-detail-focus-1440x900');

  // ---------- 4. 弹窗焦点管理与 Esc（列表行内“测试”） ----------
  await open('class=db&view=list&state=normal', 1440, 900);
  await cdp.evaluate(`(() => { const btn = document.querySelector('button[data-action="test"]'); btn.focus(); btn.click(); })()`);
  await new Promise((r) => setTimeout(r, 120));
  const dialogOpen = await cdp.evaluate(`({ open: !!document.querySelector('[role="dialog"]'), focused: document.activeElement?.tagName, inside: !!document.activeElement?.closest('[role="dialog"]') })`);
  check('测试连接弹窗打开且焦点进入弹窗', dialogOpen.open === true && dialogOpen.inside === true, JSON.stringify(dialogOpen));
  await shot('db-list-test-dialog-1440x900');
  const esc = (type) => cdp.send('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
  await esc('keyDown'); await esc('keyUp');
  await new Promise((r) => setTimeout(r, 120));
  const afterEsc = await cdp.evaluate(`({ open: !!document.querySelector('[role="dialog"]'), focused: document.activeElement?.dataset?.action ?? null })`);
  check('Esc 关闭弹窗并返回触发按钮焦点', afterEsc.open === false && afterEsc.focused === 'test', JSON.stringify(afterEsc));

  // ---------- 5. 状态：正常 / 无数据 / 加载 / 失败 / 部分失败 / 无权限 ----------
  for (const state of ['empty', 'loading', 'error', 'partial', 'forbidden']) {
    await open(`class=db&view=detail&tab=collection&state=${state}`, 1440, 900);
    const probe = await cdp.evaluate(`(() => { const panel = document.getElementById('tab-panel'); return { alert: !!panel.querySelector('[role="alert"]'), status: !!panel.querySelector('[role="status"]'), skeleton: !!panel.querySelector('.skeleton'), text: panel.innerText.slice(0, 80) }; })()`);
    const ok = state === 'loading' ? probe.skeleton
      : state === 'partial' ? (probe.text.includes('部分成功'))
        : state === 'empty' ? probe.text.includes('暂无可用数据')
          : probe.alert;
    check(`状态「${state}」有明确呈现`, Boolean(ok), probe.text.replace(/\s+/g, ' ').slice(0, 60));
    await shot(`db-detail-state-${state}-1440x900`);
  }
  const forbidden = await cdp.evaluate(`document.getElementById('tab-panel').innerText`);
  check('无权限状态不显示采集数据', !forbidden.includes('MySQL 基础采集') && forbidden.includes('无权读取'), forbidden.replace(/\s+/g, ' ').slice(0, 48));

  // ---------- 6. 三档宽度与长名称 ----------
  for (const [label, [w, h]] of Object.entries(SIZES)) {
    await open('class=db&view=list&state=normal', w, h);
    const overflow = await cdp.evaluate(`({ page: document.documentElement.scrollWidth <= window.innerWidth, scrollable: (() => { const s = document.querySelector('.table-scroll'); return s.scrollWidth > s.clientWidth; })(), actionsVisible: (() => { const btn = document.querySelector('.data-table tbody tr .actions button:last-child'); const r = btn.getBoundingClientRect(); return r.right <= window.innerWidth && r.bottom <= window.innerHeight; })() })`);
    check(`列表 ${label} 无整页溢出`, overflow.page === true, `localScroll=${overflow.scrollable}`);
    check(`列表 ${label} 主操作可达`, overflow.actionsVisible === true);
    await shot(`db-list-${label}`);

    await open('class=server&view=detail&tab=diagnostics', w, h);
    const detailOverflow = await cdp.evaluate(`document.documentElement.scrollWidth <= window.innerWidth`);
    const primary = await cdp.evaluate(`(() => { const btn = [...document.querySelectorAll('.detail-actions .btn')].pop(); const r = btn.getBoundingClientRect(); return r.right <= window.innerWidth && r.bottom <= window.innerHeight; })()`);
    check(`服务器详情 ${label} 无整页溢出且主操作可达`, detailOverflow === true && primary === true);
    await shot(`server-detail-diagnostics-${label}`);

    await open('class=network&view=detail&tab=backups', w, h);
    const networkOverflow = await cdp.evaluate(`document.documentElement.scrollWidth <= window.innerWidth`);
    check(`网络设备详情 ${label} 无整页溢出`, networkOverflow === true);
    await shot(`network-detail-backups-${label}`);
  }

  await open('class=db&view=detail&tab=overview&long=1', 1366, 768);
  const longName = await cdp.evaluate(`(() => { const h1 = document.querySelector('.detail-title'); const r = h1.getBoundingClientRect(); return { wrapped: r.height > 40, overflow: document.documentElement.scrollWidth <= window.innerWidth, text: h1.textContent.length }; })()`);
  check('长名称换行且不产生整页溢出', longName.wrapped === true && longName.overflow === true, `height>40=${longName.wrapped}`);
  await shot('db-detail-long-name-1366x768');

  // ---------- 6b. 窄于验收范围时的降级：只在表格内横滚 ----------
  await open('class=db&view=list&state=normal', 1100, 800);
  const narrow = await cdp.evaluate(`(() => { const s = document.querySelector('.table-scroll'); return { page: document.documentElement.scrollWidth <= window.innerWidth, localScroll: s.scrollWidth > s.clientWidth, hint: !!document.getElementById('scroll-help') }; })()`);
  check('窄窗口降级为表格内横滚且无整页溢出', narrow.page === true && narrow.localScroll === true && narrow.hint === true, JSON.stringify(narrow));
  await shot('db-list-narrow-1100x800');

  // ---------- 7. 全页快照（供评审查看完整内容；?full=1 让整页可滚动） ----------
  for (const [cls, tab] of [['db', 'collection'], ['db', 'topsql'], ['db', 'capacity'], ['server', 'diagnostics'], ['server', 'related'], ['network', 'interfaces'], ['network', 'backups']]) {
    await open(`class=${cls}&view=detail&tab=${tab}&full=1`, 1440, 900);
    await shot(`${cls}-detail-${tab}-full-1440x900`, true);
  }

  const failed = results.filter((r) => !r.ok);
  await writeFile(path.join(OUT, '..', 'checks.json'), JSON.stringify({ generatedAt: new Date().toISOString(), base: BASE, results }, null, 2));
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  cdp.ws.close();
  chrome.kill('SIGTERM');
  if (failed.length) { console.error('FAILED:', failed.map((f) => f.name).join('; ')); process.exit(1); }
}

main().catch(async (error) => {
  console.error(error);
  process.exit(2);
});
