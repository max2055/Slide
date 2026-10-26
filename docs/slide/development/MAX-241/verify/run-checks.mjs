#!/usr/bin/env node
/* MAX-241 原型验证脚本（零第三方依赖，直接使用 Chrome DevTools Protocol）。

   前置：原型通过 Vite 提供服务（共享组件只读复用 frontend/src）：
     frontend/node_modules/.bin/vite --config docs/slide/development/MAX-241/prototype/vite.config.mjs
   然后：
     node docs/slide/development/MAX-241/verify/run-checks.mjs \
       http://127.0.0.1:8971/docs/slide/development/MAX-241/prototype \
       /Users/max/Coding/40-Slide/outputs/MAX-241-2026-10-26/repair/screenshots

   反例模式（用于 RED/GREEN 证据；只跑 11 项反例检查）：
     node .../run-checks.mjs <base> <out> --counterexamples --label old

   脚本只读取原型页面并截图，不修改产品代码，不访问后端、不调用模型。
*/
import { spawn } from 'node:child_process';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const BASE = (args[0] ?? 'http://127.0.0.1:8971/docs/slide/development/MAX-241/prototype').replace(/\/$/, '');
const OUT = args[1] ?? './screenshots';
const MODE = args.includes('--counterexamples') ? 'counterexamples' : 'full';
const LABEL = args.includes('--label') ? args[args.indexOf('--label') + 1] : 'current';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9333;
const PROFILE = `/tmp/max241-cdp-${process.pid}`;
const INDEX = `${BASE}/index.html`;

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail });
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
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'evaluate failed');
    return result.result.value;
  }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForChrome() {
  for (let i = 0; i < 80; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const targets = await res.json();
      const page = targets.find((t) => t.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch { /* not ready */ }
    await wait(200);
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
    'about:blank',
  ], { stdio: 'ignore' });
  const wsUrl = await waitForChrome();
  const cdp = await Cdp.connect(wsUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  async function open(query, width = 1440, height = 900) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    const loaded = cdp.once('Page.loadEventFired');
    await cdp.send('Page.navigate', { url: `${INDEX}?${query}` });
    await loaded;
    await wait(450);
  }

  async function shot(name, fullPage = false) {
    let clip;
    if (fullPage) {
      const metrics = await cdp.send('Page.getLayoutMetrics');
      const size = metrics.cssContentSize ?? metrics.contentSize;
      clip = { x: 0, y: 0, width: size.width, height: Math.min(size.height, 5000), scale: 1 };
    }
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: fullPage, ...(clip ? { clip } : {}) });
    await writeFile(path.join(OUT, `${name}.png`), Buffer.from(data, 'base64'));
  }

  const evaluate = (expression) => cdp.evaluate(expression);
  const bodyText = () => evaluate('document.body.innerText');
  const clickButtonByText = (text) => evaluate(`(() => {
    const btn = [...document.querySelectorAll('button')].find((b) => !b.disabled && b.textContent.includes(${JSON.stringify(text)}));
    if (!btn) return false;
    btn.click();
    return true;
  })()`);

  async function dialogProbe() {
    return evaluate(`(() => {
      const host = document.querySelector('app-dialog');
      const shadow = host?.shadowRoot;
      const native = shadow?.querySelector('dialog');
      const legacy = document.querySelector('[role="dialog"], .dialog');
      const root = native ?? legacy;
      let active = document.activeElement;
      while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
      return {
        open: Boolean(native?.open || legacy),
        activeTag: active?.tagName ?? null,
        activeText: active?.textContent?.trim().slice(0, 30) ?? '',
        inside: Boolean(root && active && (root.contains(active) || host?.contains(active))),
      };
    })()`);
  }

  const key = (name, code, vk) => async (type) => cdp.send('Input.dispatchKeyEvent', {
    type, key: name, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk,
  });
  const pressEscape = async () => { const f = key('Escape', 'Escape', 27); await f('keyDown'); await f('keyUp'); await wait(150); };

  /* ---------------- R2/R3/R4 反例：11 项（RED/GREEN） ---------------- */

  async function ctSecondRow(clsName, rowIndex, expectedName, firstRowName, expectedAddress) {
    await open(`class=${clsName}&view=list&state=normal&perm=full`, 1440, 900);
    const clicked = await evaluate(`(() => {
      const rows = [...document.querySelectorAll('tbody tr')].filter((r) => r.querySelector('.actions [data-action="open-detail"]'));
      const btn = rows[${rowIndex}]?.querySelector('.actions [data-action="open-detail"]');
      if (!btn) return false;
      btn.click();
      return true;
    })()`);
    await wait(350);
    const info = await evaluate(`(() => ({
      title: document.querySelector('.detail-title')?.textContent?.trim() ?? '',
      meta: document.querySelector('[data-testid="detail-meta"]')?.textContent ?? document.querySelector('.detail-meta')?.textContent ?? '',
      resId: document.querySelector('[data-testid="detail-title"]')?.dataset.resId ?? null,
    }))()`);
    const ok = clicked && info.title.includes(expectedName) && !info.title.includes(firstRowName) && info.meta.includes(expectedAddress);
    check(`反例 [${clsName}] 点击第二行详情显示该行身份/地址（非首行）`, ok, `${info.title} · ${info.meta}`);
    await shot(`counter-${clsName}-second-row`);
    return ok;
  }

  async function ctForbidden(clsName, name, address) {
    await open(`class=${clsName}&view=detail&tab=overview&state=forbidden&perm=none`, 1440, 900);
    const info = await evaluate(`(() => {
      const text = document.body.innerText;
      return {
        hasName: text.includes(${JSON.stringify(name)}),
        hasAddress: text.includes(${JSON.stringify(address)}),
        links: Boolean(document.querySelector('.links-row')),
        actions: document.querySelectorAll('.detail-actions button').length,
        tabs: document.querySelectorAll('.tab').length,
        alert: Boolean(document.querySelector('[role="alert"]')),
        message: text.includes('无权读取'),
      };
    })()`);
    const ok = !info.hasName && !info.hasAddress && !info.links && info.actions === 0 && info.tabs === 0 && info.alert && info.message;
    check(`反例 [${clsName}] 页面级无权限清空名称/地址/联动/操作/页签`, ok, JSON.stringify(info));
    await shot(`counter-${clsName}-page-forbidden`);
    return ok;
  }

  async function ctConfigEdit(clsName, id) {
    await open(`class=${clsName}&view=detail&id=${id}&tab=collection&state=normal&perm=full`, 1440, 900);
    const clicked = await clickButtonByText('修改模板与参数');
    await wait(350);
    const info = await evaluate(`(() => ({
      editor: Boolean(document.querySelector('[data-testid="config-editor"]')),
      template: Boolean(document.querySelector('[data-testid="config-template"]')),
      params: document.querySelectorAll('[data-param]').length,
    }))()`);
    const ok = clicked && info.editor && info.template && info.params > 0;
    check(`反例 [${clsName}] “修改模板与参数”可打开可编辑配置`, ok, JSON.stringify(info));
    await shot(`counter-${clsName}-config-editable`);
    return ok;
  }

  async function ctNonDbFlow(clsName) {
    await open(`class=${clsName}&view=detail&tab=collection&state=normal&perm=full`, 1440, 900);
    const clicked = await evaluate(`(() => {
      const btn = [...document.querySelectorAll('button')].find((b) => /检查并启用|检查兼容性与权限/.test(b.textContent));
      if (!btn) return false;
      btn.click();
      return true;
    })()`);
    await wait(350);
    const text = await bodyText();
    const ok = clicked && !text.includes('MySQL') && !text.includes('mysql');
    check(`反例 [${clsName}] 检查/启用流程不硬编码 MySQL 模板`, ok, ok ? '未出现 MySQL' : '页面/流程仍出现 MySQL');
    await shot(`counter-${clsName}-template-flow`);
    return ok;
  }

  async function counterexamples() {
    const all = [];
    all.push(await ctSecondRow('db', 1, 'mysql-report-readonly', 'mysql-order-prod', '10.20.1.18:3306'));
    all.push(await ctSecondRow('server', 1, 'app-prod-02', 'app-prod-01', '10.20.1.22:22'));
    all.push(await ctSecondRow('network', 1, 'sw-agg-02', 'sw-core-01', '10.20.1.2:161'));
    all.push(await ctForbidden('db', 'mysql-order-prod', '10.20.1.15:3306'));
    all.push(await ctForbidden('server', 'app-prod-01', '10.20.1.21:22'));
    all.push(await ctForbidden('network', 'sw-core-01', '10.20.1.1:161'));
    all.push(await ctConfigEdit('db', 9));
    all.push(await ctConfigEdit('server', 18));
    all.push(await ctConfigEdit('network', 30));
    all.push(await ctNonDbFlow('server'));
    all.push(await ctNonDbFlow('network'));
    return all;
  }

  if (MODE === 'counterexamples') {
    await counterexamples();
    const failed = results.filter((r) => !r.ok);
    await writeFile(path.join(OUT, `counterexamples-${LABEL}.json`), JSON.stringify({
      generatedAt: new Date().toISOString(), base: BASE, mode: MODE, label: LABEL, results,
    }, null, 2));
    console.log(`\n${results.length - failed.length}/${results.length} counterexample checks passed (${LABEL})`);
    cdp.ws.close();
    chrome.kill('SIGTERM');
    process.exit(failed.length ? 1 : 0);
  }

  /* ---------------- 完整检查 ---------------- */

  const EXPECTED = {
    db: ['序号', '实例', '地址', '版本', '观测健康', '采集状态', '最近成功采集', '操作'],
    server: ['序号', '主机名称', '地址', '系统版本', '观测健康', '采集状态', '最近成功采集', '操作'],
    network: ['序号', '设备', '地址', '型号', '观测健康', '采集状态', '最近成功采集', '操作'],
  };
  const TABS = {
    db: ['概览', '监控配置', '指标与趋势', '健康评分', '慢查询', '会话', '容量', '表结构', '索引', 'SQL 审核', '日志', '查询分析', 'AI 诊断'],
    server: ['概览', '监控配置', '指标与趋势', '配置', '诊断', '网络', '进程', '服务', '日志', '关联资源'],
    network: ['概览', '指标与趋势', '接口', '关联资源', '配置备份', '监控配置'],
  };
  const SIZES = { '1440x900': [1440, 900], '1366x768': [1366, 768], '1920x1080': [1920, 1080] };

  // 1. 共享组件复用（R5）
  await open('class=db&view=detail&tab=collection&state=normal&perm=full', 1440, 900);
  const shared = await evaluate(`(() => ({
    cards: document.querySelectorAll('app-card').length,
    badges: document.querySelectorAll('app-badge').length,
    tables: document.querySelectorAll('app-data-table').length,
    emptyStates: document.querySelectorAll('app-empty-state').length,
    legacyCard: document.querySelectorAll('.card, .badge, .dialog, .modal-overlay').length,
    unstyledButtons: [...document.querySelectorAll('.content button')].filter((b) => !b.classList.contains('tab') && !/\\b(btn|btn-primary|btn-ghost|btn-sm|btn-xs)\\b/.test(b.className)).length,
  }))()`);
  check('复用共享卡片组件 app-card', shared.cards > 0, `cards=${shared.cards}`);
  check('复用共享徽章组件 app-badge', shared.badges > 0, `badges=${shared.badges}`);
  check('复用共享表格组件 app-data-table', shared.tables > 0, `tables=${shared.tables}`);
  check('未保留重复的 .card/.badge/.dialog 样式类', shared.legacyCard === 0, `legacy=${shared.legacyCard}`);
  check('按钮使用共享按钮契约类', shared.unstyledButtons === 0, `unstyled=${shared.unstyledButtons}`);

  // 2. 列表：八列、四操作、局部横滚、无整页溢出
  for (const clsName of ['db', 'server', 'network']) {
    await open(`class=${clsName}&view=list&state=normal&perm=full`, 1440, 900);
    const headers = await evaluate(`[...document.querySelectorAll('.list-table app-data-table thead th')].map((th) => th.textContent.trim())`);
    const business = headers.filter((h) => h !== '选择');
    check(`[${clsName}] 列表业务列为八列`, business.length === 8, business.join(' / '));
    check(`[${clsName}] 八列名称符合要求`, EXPECTED[clsName].every((label, i) => business[i] === label), business.join(' / '));
    const actionCount = await evaluate(`document.querySelectorAll('.list-table tbody tr')[0].querySelectorAll('.actions button').length`);
    check(`[${clsName}] 行内四操作完整展示`, actionCount === 4, `buttons=${actionCount}`);
    const noPageOverflow = await evaluate('document.documentElement.scrollWidth <= window.innerWidth');
    check(`[${clsName}] 1440×900 无整页横向溢出`, noPageOverflow === true);
    const localScroll = await evaluate(`(() => { const s = document.querySelector('.list-table'); return { region: s.getAttribute('role'), label: s.getAttribute('aria-label') }; })()`);
    check(`[${clsName}] 表格具备局部横滚容器`, localScroll.region === 'region' && Boolean(localScroll.label), JSON.stringify(localScroll));
    await shot(`${clsName}-list-1440x900`);
  }

  // 3. 详情页签集合与顺序 + 联动行
  for (const clsName of ['db', 'server', 'network']) {
    await open(`class=${clsName}&view=detail&tab=overview&state=normal&perm=full`, 1440, 900);
    const tabs = await evaluate(`[...document.querySelectorAll('.tab')].map((t) => t.textContent.replace(/\\d+$/, '').trim())`);
    check(`[${clsName}] 详情页签集合与顺序`, JSON.stringify(tabs) === JSON.stringify(TABS[clsName]), tabs.join(' / '));
    const hasLinks = await evaluate(`Boolean(document.querySelector('.links-row'))`);
    check(`[${clsName}] 详情保留关联调查/事件/审计联动行`, hasLinks === true);
    await shot(`${clsName}-detail-overview-1440x900`);
  }

  // 4. 键盘：页签方向键与焦点环
  await open('class=db&view=detail&tab=overview&state=normal&perm=full', 1440, 900);
  await evaluate(`document.getElementById('tab-overview').focus()`);
  const arrowRight = key('ArrowRight', 'ArrowRight', 39);
  await arrowRight('keyDown'); await arrowRight('keyUp'); await wait(200);
  const afterRight = await evaluate(`({
    id: document.activeElement.id,
    selected: [...document.querySelectorAll('.tab')].find((t) => t.getAttribute('aria-selected') === 'true')?.id,
  })`);
  check('页签 ArrowRight 切换到下一项并保持焦点', afterRight.id === 'tab-collection' && afterRight.selected === 'tab-collection', JSON.stringify(afterRight));
  const focusRing = await evaluate(`getComputedStyle(document.getElementById('tab-collection')).outlineStyle`);
  check('页签可获得可见焦点环', focusRing !== 'none', `outline-style=${focusRing}`);
  await shot('db-detail-focus-1440x900');

  // 5. 共享弹窗焦点管理与 Esc
  await open('class=db&view=list&state=normal&perm=full', 1440, 900);
  await evaluate(`(() => { const btn = document.querySelector('.list-table [data-action="test"]'); btn.focus(); btn.click(); })()`);
  await wait(350);
  const dialogOpen = await dialogProbe();
  check('测试连接弹窗打开且焦点进入弹窗', dialogOpen.open === true && dialogOpen.inside === true, JSON.stringify(dialogOpen));
  await shot('db-list-test-dialog-1440x900');
  await pressEscape();
  const afterEsc = await evaluate(`({ open: Boolean(document.querySelector('app-dialog')?.shadowRoot?.querySelector('dialog[open]')), focused: document.activeElement?.dataset?.action ?? null })`);
  check('Esc 关闭弹窗并返回触发按钮焦点', afterEsc.open === false && afterEsc.focused === 'test', JSON.stringify(afterEsc));

  // 6. 状态：正常 / 无数据 / 加载 / 失败 / 部分失败 / 页面 403 / 模块 403
  for (const state of ['empty', 'loading', 'error', 'partial']) {
    await open(`class=db&view=detail&tab=collection&state=${state}&perm=full`, 1440, 900);
    const probe = await evaluate(`(() => {
      const panel = document.getElementById('tab-panel') ?? document.querySelector('.content-inner');
      return { alert: Boolean(panel.querySelector('[role="alert"]')), skeleton: Boolean(panel.querySelector('.skeleton')), text: panel.innerText.slice(0, 80) };
    })()`);
    const ok = state === 'loading' ? probe.skeleton
      : state === 'partial' ? probe.text.includes('部分成功')
        : state === 'empty' ? probe.text.includes('暂无可用数据')
          : probe.alert;
    check(`状态「${state}」有明确呈现`, Boolean(ok), probe.text.replace(/\s+/g, ' ').slice(0, 60));
    await shot(`db-detail-state-${state}-1440x900`);
  }
  await open('class=db&view=detail&tab=collection&state=forbidden&perm=full', 1440, 900);
  const forbiddenText = await evaluate(`document.body.innerText`);
  check('页面 403 有明确无权限呈现', forbiddenText.includes('无权读取') && Boolean(await evaluate(`Boolean(document.querySelector('[role="alert"]'))`)), forbiddenText.replace(/\s+/g, ' ').slice(0, 48));
  check('页面 403 不显示采集数据与资源身份', !forbiddenText.includes('MySQL 基础采集') && !forbiddenText.includes('mysql-order-prod'), forbiddenText.replace(/\s+/g, ' ').slice(0, 48));
  await shot('db-detail-state-forbidden-1440x900');

  await open('class=server&view=detail&tab=diagnostics&state=module403&perm=full', 1440, 900);
  const module403 = await evaluate(`(() => ({
    identity: document.querySelector('.detail-title')?.textContent?.includes('app-prod-01') ?? false,
    message: document.getElementById('tab-panel').innerText.includes('无权读取该模块'),
    actions: document.querySelectorAll('.detail-actions button').length,
  }))()`);
  check('模块 403 保留页面身份、仅该页签无权限', module403.identity && module403.message && module403.actions > 0, JSON.stringify(module403));

  // 7. 权限分层：只读 / 管理无备份 / 备份写
  await open('class=db&view=list&state=normal&perm=view', 1440, 900);
  const viewOnly = await evaluate(`(() => {
    const row = document.querySelector('.list-table tbody tr');
    return ['edit', 'test', 'delete'].map((a) => row.querySelector('[data-action="' + a + '"]').disabled);
  })()`);
  check('只读权限下编辑/测试/删除均禁用（详情可用）', viewOnly.every(Boolean), JSON.stringify(viewOnly));
  await open('class=db&view=detail&id=9&tab=collection&state=normal&perm=view', 1440, 900);
  const readOnlyConfig = await evaluate(`(() => ({
    notice: Boolean(document.querySelector('[data-testid="config-readonly"]')),
    editDisabled: document.querySelector('[data-action="edit-config"]').disabled,
    editor: Boolean(document.querySelector('[data-testid="config-editor"]')),
  }))()`);
  check('只读权限下监控配置不可编辑且有原因', readOnlyConfig.notice && readOnlyConfig.editDisabled && !readOnlyConfig.editor, JSON.stringify(readOnlyConfig));

  await open('class=db&view=list&state=normal&perm=manager', 1440, 900);
  const managerDb = await evaluate(`(() => {
    const row = document.querySelector('.list-table tbody tr');
    return { edit: row.querySelector('[data-action="edit"]').disabled, remove: row.querySelector('[data-action="delete"]').disabled, test: row.querySelector('[data-action="test"]').disabled };
  })()`);
  check('数据库管理权限不含 update/delete 时编辑与删除禁用', managerDb.edit === true && managerDb.remove === true, JSON.stringify(managerDb));
  await open('class=db&view=detail&id=9&tab=collection&state=normal&perm=manager', 1440, 900);
  const managerConfig = await evaluate(`document.querySelector('[data-action="edit-config"]').disabled`);
  check('数据库管理权限仍可编辑监控配置（can_manage 独立）', managerConfig === false);

  await open('class=network&view=detail&id=31&tab=backups&state=normal&perm=manager', 1440, 900);
  const backupNoWrite = await evaluate(`(() => ({
    saveDisabled: [...document.querySelectorAll('button')].find((b) => b.textContent.includes('保存定时设置'))?.disabled,
    rows: document.querySelectorAll('app-data-table tbody tr').length,
    reason: [...document.querySelectorAll('button')].find((b) => b.textContent.includes('保存定时设置'))?.title ?? '',
  }))()`);
  check('无 backup 权限时备份写操作禁用、备份读取仍可见', backupNoWrite.saveDisabled === true && backupNoWrite.rows > 0 && backupNoWrite.reason.includes('network_devices:backup'), JSON.stringify(backupNoWrite));
  await open('class=network&view=detail&id=31&tab=backups&state=normal&perm=backup', 1440, 900);
  const backupWrite = await evaluate(`(() => ({
    saveDisabled: [...document.querySelectorAll('button')].find((b) => b.textContent.includes('保存定时设置'))?.disabled,
    editDisabled: null,
  }))()`);
  check('拥有 backup 权限时可保存定时设置', backupWrite.saveDisabled === false, JSON.stringify(backupWrite));
  await shot('network-backups-backup-permission-1440x900');

  // 8. R2/R3/R4 反例在完整模式下同样必须通过（GREEN）
  await counterexamples();

  // 9. 配置可编辑行为：修改参数 → 最终值更新、流程重置、试采/发布/等待正式样本
  await open('class=db&view=detail&id=9&tab=collection&state=normal&perm=full', 1440, 900);
  await clickButtonByText('修改模板与参数'); await wait(300);
  const beforeEdit = await evaluate(`document.querySelector('[data-testid="final-interval"]')?.textContent?.trim() ?? ''`);
  await evaluate(`(() => { const input = document.querySelector('[data-param="interval"]'); input.value = '30s'; input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await wait(250);
  const afterEdit = await evaluate(`(() => ({
    final: document.querySelector('[data-testid="final-interval"]')?.textContent?.trim() ?? '',
    flow: document.querySelector('[data-testid="flow-state"]')?.textContent ?? '',
    step0: !document.querySelector('[data-testid="compat-result"]'),
  }))()`);
  check('修改参数后最终值与来源更新', beforeEdit === '120s' && afterEdit.final === '30s' && afterEdit.final !== beforeEdit, `${beforeEdit} → ${afterEdit.final}`);
  check('修改参数后流程重置为未检查', afterEdit.step0 && afterEdit.flow.includes('草稿已修改'), afterEdit.flow);
  await clickButtonByText('检查兼容性与权限'); await wait(250);
  const compat = await evaluate(`Boolean(document.querySelector('[data-testid="compat-result"]'))`);
  check('检查兼容性与权限产生检查结果', compat === true);
  await evaluate(`document.querySelector('[data-action="run-trial"]').click()`); await wait(250);
  const trial = await evaluate(`document.querySelector('[data-testid="flow-state"]')?.textContent ?? ''`);
  check('执行试采（不写正式历史）', trial.includes('试采完成') && trial.includes('不写正式历史'), trial);
  await evaluate(`document.querySelector('[data-action="publish"]').click()`); await wait(250);
  const published = await evaluate(`document.querySelector('[data-testid="apply-state"]')?.textContent ?? ''`);
  check('发布后等待应用，不宣称全部指标可用', published.includes('等待应用') && published.includes('不表示已开始正式采集'), published);
  await evaluate(`document.querySelector('[data-action="refresh-apply"]').click()`); await wait(250);
  const applied = await evaluate(`document.querySelector('[data-testid="apply-state"]')?.textContent ?? ''`);
  check('应用后等待正式样本，不伪造健康', applied.includes('等待首个正式样本') && applied.includes('不代表已健康'), applied);
  await shot('db-config-edited-flow-1440x900', true);

  await open('class=db&view=detail&id=9&tab=collection&state=normal&perm=full', 1440, 900);
  const perRowConfig = await evaluate(`(() => ({
    name: document.querySelector('[data-testid="config-template-name"]')?.textContent?.trim() ?? '',
    group: document.querySelector('[data-testid="config-group"]')?.textContent?.trim() ?? '',
  }))()`);
  check('监控配置绑定随所选资源变化（第二行模板非首行）', perRowConfig.name.includes('MySQL 只读副本采集') && perRowConfig.group.includes('只读副本标准'), JSON.stringify(perRowConfig));

  // 10. 详情内指标使用所选资源 id（R2 上下文）
  await open('class=db&view=detail&id=9&tab=metrics&state=normal&perm=full', 1440, 900);
  const metricContext = await evaluate(`(() => {
    const text = document.getElementById('tab-panel').innerText;
    return { hasId: text.includes('#9'), hasOther: text.includes('10.20.1.15') };
  })()`);
  check('指标页带入选中所选资源 id 与来源', metricContext.hasId === true && metricContext.hasOther === false, JSON.stringify(metricContext));

  // 11. 返回列表保留筛选与位置
  await open('class=db&view=list&state=normal&perm=full', 1100, 800);
  await evaluate(`(() => { const f = [...document.querySelectorAll('[data-action="filter"]')].find((b) => b.dataset.filter === 'warning'); f.click(); })()`);
  await wait(200);
  const scrollBefore = await evaluate(`(() => { const s = document.querySelector('.list-table'); s.scrollLeft = Math.min(120, s.scrollWidth - s.clientWidth); return { left: s.scrollLeft, filter: document.querySelector('[data-filter="warning"]').getAttribute('aria-pressed') }; })()`);
  await evaluate(`document.querySelector('.list-table tbody tr .actions [data-action="open-detail"]').click()`);
  await wait(300);
  await evaluate(`document.querySelector('[data-action="back-list"]').click()`);
  await wait(1500);
  const restored = await evaluate(`(() => { const s = document.querySelector('.list-table'); return { left: s.scrollLeft, filter: document.querySelector('[data-filter="warning"]').getAttribute('aria-pressed'), title: document.querySelector('h1')?.textContent, focused: document.activeElement?.dataset?.action ?? null }; })()`);
  check('返回列表恢复筛选与横向位置', restored.filter === 'true' && Math.abs(restored.left - scrollBefore.left) <= 1, JSON.stringify({ scrollBefore, restored }));
  check('返回后焦点回到来源行操作', restored.focused === 'open-detail', JSON.stringify(restored));

  // 12. 旧深链接兼容（不改变参数名）
  await open('tab=instance-detail&id=9', 1440, 900);
  const legacy = await evaluate(`document.querySelector('.detail-title')?.textContent?.trim() ?? ''`);
  check('旧深链接 tab=instance-detail&id= 仍可打开对应资源', legacy.includes('mysql-report-readonly'), legacy);

  // 13. 三档宽度与长名称
  for (const [label, [w, h]] of Object.entries(SIZES)) {
    await open('class=db&view=list&state=normal&perm=full', w, h);
    const overflow = await evaluate(`(() => {
      const s = document.querySelector('.list-table');
      s.scrollLeft = s.scrollWidth;
      const btn = document.querySelector('.list-table tbody tr .actions button:last-child');
      const r = btn.getBoundingClientRect();
      return {
        page: document.documentElement.scrollWidth <= window.innerWidth,
        scrollable: s.scrollWidth > s.clientWidth,
        actionsVisible: r.right <= window.innerWidth && r.bottom <= window.innerHeight,
      };
    })()`);
    check(`列表 ${label} 无整页溢出`, overflow.page === true, `localScroll=${overflow.scrollable}`);
    check(`列表 ${label} 滚动后主操作可达`, overflow.actionsVisible === true);
    await shot(`db-list-${label}`);

    await open('class=server&view=detail&tab=diagnostics&state=normal&perm=full', w, h);
    const detailOverflow = await evaluate('document.documentElement.scrollWidth <= window.innerWidth');
    const primary = await evaluate(`(() => { const btn = [...document.querySelectorAll('.detail-actions .btn')].pop(); const r = btn.getBoundingClientRect(); return r.right <= window.innerWidth && r.bottom <= window.innerHeight; })()`);
    check(`服务器详情 ${label} 无整页溢出且主操作可达`, detailOverflow === true && primary === true);
    await shot(`server-detail-diagnostics-${label}`);

    await open('class=network&view=detail&tab=backups&state=normal&perm=full', w, h);
    const networkOverflow = await evaluate('document.documentElement.scrollWidth <= window.innerWidth');
    const backupAction = await evaluate(`(() => { const btn = [...document.querySelectorAll('.detail-actions .btn')].find((b) => b.textContent.includes('立即备份')); const r = btn.getBoundingClientRect(); return r.right <= window.innerWidth && r.bottom <= window.innerHeight; })()`);
    check(`网络设备详情 ${label} 无整页溢出且备份主操作可达`, networkOverflow === true && backupAction === true);
    await shot(`network-detail-backups-${label}`);
  }

  await open('class=db&view=detail&tab=overview&long=1&state=normal&perm=full', 1366, 768);
  const longName = await evaluate(`(() => { const h1 = document.querySelector('.detail-title'); const r = h1.getBoundingClientRect(); return { wrapped: r.height > 40, overflow: document.documentElement.scrollWidth <= window.innerWidth, text: h1.textContent.length }; })()`);
  check('长名称换行且不产生整页溢出', longName.wrapped === true && longName.overflow === true, `height>40=${longName.wrapped}`);
  await shot('db-detail-long-name-1366x768');

  await open('class=db&view=list&state=normal&perm=full', 1100, 800);
  const narrow = await evaluate(`(() => { const s = document.querySelector('.list-table'); return { page: document.documentElement.scrollWidth <= window.innerWidth, localScroll: s.scrollWidth > s.clientWidth, hint: Boolean(document.getElementById('scroll-help')) }; })()`);
  check('窄窗口降级为表格内横滚且无整页溢出', narrow.page === true && narrow.localScroll === true && narrow.hint === true, JSON.stringify(narrow));
  await shot('db-list-narrow-1100x800');

  // 14. 全页快照（评审用）
  for (const [clsName, tab] of [['db', 'collection'], ['db', 'topsql'], ['db', 'capacity'], ['server', 'diagnostics'], ['server', 'related'], ['network', 'interfaces'], ['network', 'backups']]) {
    await open(`class=${clsName}&view=detail&tab=${tab}&state=normal&perm=full&full=1`, 1440, 900);
    await shot(`${clsName}-detail-${tab}-full-1440x900`, true);
  }

  const failed = results.filter((r) => !r.ok);
  await writeFile(path.join(OUT, 'checks.json'), JSON.stringify({
    generatedAt: new Date().toISOString(), base: BASE, mode: MODE, results,
  }, null, 2));
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  cdp.ws.close();
  chrome.kill('SIGTERM');
  if (failed.length) { console.error('FAILED:', failed.map((f) => f.name).join('; ')); process.exit(1); }
}

main().catch((error) => {
  console.error(error);
  process.exit(2);
});
