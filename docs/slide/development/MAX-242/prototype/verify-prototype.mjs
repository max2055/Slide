#!/usr/bin/env node
/* MAX-242 原型交互检查：用本机 Chrome 无头模式 + CDP 走一遍主故事。
 * 只验证原型交互与文案，不连接产品后端、不调用模型。
 * 用法：node verify-prototype.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9337;
const here = resolve('.');
const pageUrl = `file://${join(here, 'index.html')}`;
const profile = mkdtempSync(join(tmpdir(), 'max242-proto-'));
const results = [];
const consoleErrors = [];

function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let chrome;
try {
  if (!existsSync(CHROME)) throw new Error(`缺少 Chrome：${CHROME}`);
  chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
    '--window-size=1440,900', 'about:blank'
  ], { stdio: 'ignore' });

  // wait for devtools endpoint
  let version;
  for (let i = 0; i < 60; i++) {
    try { version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); break; }
    catch { await sleep(150); }
  }
  if (!version) throw new Error('Chrome DevTools 未就绪');

  const target = await (await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(pageUrl)}`, { method: 'PUT' })).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });

  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); return; }
    if (msg.method === 'Runtime.exceptionThrown') consoleErrors.push(msg.params.exceptionDetails?.text ?? 'exception');
    if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') consoleErrors.push(msg.params.entry.text);
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      consoleErrors.push(msg.params.args.map(a => a.value ?? a.description ?? '').join(' '));
    }
  });
  const send = (method, params = {}) => new Promise((res, rej) => {
    const mid = ++id;
    pending.set(mid, (msg) => msg.error ? rej(new Error(`${method}: ${msg.error.message}`)) : res(msg.result));
    ws.send(JSON.stringify({ id: mid, method, params }));
    setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); rej(new Error(`${method} timeout`)); } }, 15000);
  });
  const evaluate = async (expression) => {
    const out = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (out.exceptionDetails) throw new Error(out.exceptionDetails.text + ' ' + (out.exceptionDetails.exception?.description ?? ''));
    return out.result?.value;
  };
  const text = () => evaluate('document.body.innerText');
  const goto = async (hash) => {
    await evaluate(`location.hash = ${JSON.stringify(hash)}`);
    await sleep(320);
  };
  /** 带查询串强制重新加载，使 stage/role 启动参数生效（纯 hash 变化不会重载）。 */
  const reload = async (hash, tag) => {
    await send('Page.navigate', { url: 'about:blank' });
    await sleep(150);
    await send('Page.navigate', { url: `${pageUrl}?case=${tag}${hash}` });
    await sleep(800);
  };
  const click = async (selector) => {
    const ok = await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.click(); return true; })()`);
    if (!ok) throw new Error(`找不到元素 ${selector}`);
    await sleep(260);
  };
  const choose = async (selector) => {
    const ok = await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.click(); return true; })()`);
    if (!ok) throw new Error(`找不到单选项 ${selector}`);
    await sleep(260);
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.navigate', { url: `${pageUrl}#/home` });
  await sleep(700);

  // 1. 首页
  let body = await text();
  check('首页展示演示标识', body.includes('演示数据') && body.includes('未接真实后端'));
  check('首页有发起区与需要你处理', body.includes('开始一项新调查') && body.includes('需要你处理'));
  check('常见路径说明 0 必填自由文本', body.includes('必填自由文本 0 项'));

  // 2. 启动确认
  await goto('#/start');
  body = await text();
  check('启动确认展示四项能力检查', body.includes('启动前能力检查') && body.includes('数据') && body.includes('模型') && body.includes('执行范围'));
  check('启动确认显示绝对时间与时区', body.includes('2026-10-26 10:16:04 +08:00') && body.includes('+08:00'));

  // 3. 开始只读排查（模拟进度）
  await click('[data-action="start-run"]');
  await sleep(2600);
  body = await text();
  check('启动后进入调查详情并结束执行', body.includes('本轮分析已结束') && body.includes('分析结束'));
  check('详情三状态并列', body.includes('本次执行') && body.includes('调查进度') && body.includes('业务问题'));
  check('详情显示当前判断与一个下一步', body.includes('当前判断') && body.includes('下一步') && body.includes('其他合理路径'));
  check('证据带对象/窗口/来源', body.includes('证据 EV-1') && body.includes('观察窗口'));

  // 4. 结构化补充（含“不清楚”分支）
  await goto('#/supplement');
  await click('[data-action="toggle-pool-unknown"]');
  body = await text();
  check('“不清楚”禁用数值输入', await evaluate(`document.getElementById('pool-value')?.disabled === true`));
  await click('[data-action="submit-supplement"]');
  await sleep(400);
  body = await text();
  check('补充后生成新结果版本并保留缺口', body.includes('连接池上限：用户选择“不清楚”') && body.includes('证据不足'));

  // 5. 行动草案 → 提交审批
  await goto('#/action');
  body = await text();
  check('行动草案绑定来源结果版本', body.includes('来源调查') && body.includes('已绑定') && body.includes('结果版本 V'));
  await click('[data-action="submit-approval"]');
  body = await text();
  check('提交审批后自动绑定审批记录', body.includes('APP-331') && body.includes('等待处理'));

  // 6. 作者不能自批；切换审批人后可以批准
  check('作者角色看到不能自批提示', body.includes('不能自批'));
  await evaluate(`(() => { const el = document.getElementById('role'); el.value = 'approver'; el.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await sleep(300);
  body = await text();
  check('审批人角色看到批准按钮', body.includes('批准当前版本') && body.includes('审批人账号'));
  await click('[data-action="approve"]');
  body = await text();
  check('批准后计划状态为已批准', body.includes('已批准'));

  // 7. 显式执行
  await click('[data-action="confirm-execute"]');
  body = await text();
  check('执行前出现确认对话框', body.includes('确认执行当前批准版本') && body.includes('确认执行一次'));
  await click('[data-action="confirm-dialog"]');
  await sleep(1900);
  body = await text();
  check('执行成功但恢复未自动确认', body.includes('执行成功') && body.includes('仍需人工确认复测结论'), body.includes('仍需人工确认复测结论') ? '' : body.slice(0, 200).replace(/\n/g, ' / '));

  // 8. 复测三类结论
  await goto('#/verify');
  body = await text();
  check('复测页展示观察窗口与前后观测', body.includes('10:48:04') && body.includes('92%') && body.includes('61%') && body.includes('副作用'));
  await choose('input[name="verdict"][value="recovered"]');
  await click('[data-action="submit-verdict"]');
  body = await text();
  check('复测恢复结论写入并可追溯', body.includes('复测支持恢复') && body.includes('窗口 10:48:04 — 10:53:04'));

  // 9. 未改善分支
  await reload('#/verify?stage=retested-not-improved', 'not-improved');
  body = await text();
  check('未改善分支提供回同一调查继续', body.includes('未改善') && body.includes('回同一调查继续'));

  // 10. 未知提交与断线
  await reload('#/detail?stage=after-v2', 'detail-v2');
  await click('[data-action="simulate-unknown"]');
  body = await text();
  check('未知提交锁定并可核对原请求', body.includes('结果未知') && body.includes('核对原请求') && body.includes('不重发'));
  await click('[data-action="resolve-unknown"]');
  body = await text();
  check('核对原请求后恢复且未重复创建', body.includes('该请求已被接受，未重复创建'));

  await click('[data-action="simulate-disconnect"]');
  body = await text();
  check('断线隐藏内容并可从服务端恢复', body.includes('连接中断') && body.includes('不使用本地缓存'));
  await click('[data-action="reconnect"]');
  body = await text();
  check('重连后内容恢复', body.includes('当前判断'));

  // 11. 交接与旧入口
  await goto('#/handoff');
  body = await text();
  check('交接摘要标明来源且需人工确认', body.includes('从记录生成，不调用模型') && body.includes('分享前确认') && body.includes('我已核对缺口'));
  await goto('#/compat');
  body = await text();
  check('旧入口兼容表包含关键入口', body.includes('跨资源诊断') && body.includes('关注事项') && body.includes('事件中心') && body.includes('行动中心'));

  check('无浏览器控制台错误', consoleErrors.length === 0, consoleErrors.join(' | ').slice(0, 300));

  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  if (failed.length) process.exitCode = 1;
  ws.close();
} catch (error) {
  console.error('检查失败：', error.message);
  process.exitCode = 1;
} finally {
  chrome?.kill();
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* best effort */ }
}
