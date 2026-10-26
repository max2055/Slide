#!/usr/bin/env node
/* 记录本次浏览器检查实际使用的浏览器身份（Browser.getVersion），
   证明 Chrome 与 Microsoft Edge 是各自真实运行的浏览器，不是伪装 User-Agent。

   用法：
     node docs/slide/development/MAX-241/verify/browser-version.mjs <浏览器可执行文件> [CDP端口] [输出JSON]
*/
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const [binary, portArg, outPath] = process.argv.slice(2);
if (!binary) {
  console.error('用法: node browser-version.mjs <浏览器可执行文件> [CDP端口] [输出JSON]');
  process.exit(2);
}
const port = Number(portArg ?? 9355);
const profile = `/tmp/max241-browser-version-${process.pid}`;
const chrome = spawn(binary, [
  '--headless=new', '--disable-gpu', '--no-first-run', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
], { stdio: 'ignore' });

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let wsUrl = null;
for (let i = 0; i < 80 && !wsUrl; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    wsUrl = list.webSocketDebuggerUrl;
  } catch { await wait(200); }
}
if (!wsUrl) { chrome.kill('SIGTERM'); throw new Error('浏览器 DevTools 端点未就绪'); }

const ws = new WebSocket(wsUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
const version = await new Promise((resolve) => {
  ws.onmessage = (event) => resolve(JSON.parse(event.data).result);
  ws.send(JSON.stringify({ id: 1, method: 'Browser.getVersion', params: {} }));
});
ws.close();
chrome.kill('SIGTERM');

const out = { binary, ...version, capturedAt: new Date().toISOString() };
if (outPath) {
  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(out, null, 2));
}
console.log(JSON.stringify(out, null, 2));
