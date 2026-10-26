#!/usr/bin/env node
/* MAX-241 F1 版本/子类型判定检查。

   原型演示资源只覆盖 MySQL 8.0.34 / PostgreSQL 16.4 / Huawei V200 交换机 / Huawei V600 防火墙，
   无法在页面上构造"低于最低版本"等真实资源。本脚本在隔离 VM 中**只读取**原型源码的
   模板目录与兼容性判定函数，注入合成输入，验证版本下界/上界、引擎族、设备子类型、平台、
   操作系统与未知值的判定。合成输入不代表真实数据库或真实设备验收。

   用法：
     node docs/slide/development/MAX-241/verify/version-checks.mjs [输出JSON路径]
*/
import { readFileSync, writeFileSync } from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('../prototype/app.js', import.meta.url));
const src = readFileSync(SRC, 'utf8');

const templates = src.slice(src.indexOf('const TEMPLATES ='), src.indexOf('/* ---------------- 演示资源'));
const funcs = src.slice(src.indexOf('const ENGINE_FAMILIES ='), src.indexOf('function resetFlow()'));
if (!templates.includes('const templateById') || !funcs.includes('function compatResult')) {
  console.error('源码切片失效：未找到 TEMPLATES/templateById 或 compatResult');
  process.exit(2);
}

const cases = [
  { name: 'MySQL 8.0.34 × MySQL8.0模板 → 兼容', cls: 'db', template: 'mysql-basic', row: { dbType: 'MySQL', version: '8.0.34' }, expect: true },
  { name: 'MySQL 5.7.44 × MySQL8.0模板 → 低于最低版本', cls: 'db', template: 'mysql-basic', row: { dbType: 'MySQL', version: '5.7.44' }, expect: false },
  { name: 'MySQL 9.0.1 × MySQL8.0模板 → 超出主版本', cls: 'db', template: 'mysql-basic', row: { dbType: 'MySQL', version: '9.0.1' }, expect: false },
  { name: 'MySQL 版本未知 × MySQL8.0模板 → 拒绝', cls: 'db', template: 'mysql-basic', row: { dbType: 'MySQL', version: '' }, expect: false },
  { name: 'MySQL 8.0.34 × PostgreSQL模板 → 引擎族不符', cls: 'db', template: 'pg-basic', row: { dbType: 'MySQL', version: '8.0.34' }, expect: false },
  { name: 'PostgreSQL 16.4 × PG14+模板 → 兼容', cls: 'db', template: 'pg-basic', row: { dbType: 'PostgreSQL', version: '16.4' }, expect: true },
  { name: 'PostgreSQL 14.0 × PG14+模板 → 下界兼容', cls: 'db', template: 'pg-basic', row: { dbType: 'PostgreSQL', version: '14.0' }, expect: true },
  { name: 'PostgreSQL 13.12 × PG14+模板 → 低于最低版本', cls: 'db', template: 'pg-basic', row: { dbType: 'PostgreSQL', version: '13.12' }, expect: false },
  { name: '达梦 DM8 × 达梦模板 → 兼容', cls: 'db', template: 'dm-basic', row: { dbType: '达梦', version: 'DM8' }, expect: true },
  { name: '达梦 DM8 × MySQL模板 → 引擎族不符', cls: 'db', template: 'mysql-basic', row: { dbType: '达梦', version: 'DM8' }, expect: false },
  { name: 'Huawei V200 交换机 × VRP V200 交换机模板 → 兼容', cls: 'network', template: 'huawei-snmp', row: { vendor: 'Huawei V200R019C10', version: 'S5735-L48T4X' }, expect: true },
  { name: 'Huawei V600 防火墙 × VRP V200 交换机模板 → 子类型不符', cls: 'network', template: 'huawei-snmp', row: { vendor: 'Huawei V600R007', version: 'USG6550E' }, expect: false },
  { name: 'Huawei V600 防火墙 × USG 防火墙模板 → 兼容', cls: 'network', template: 'huawei-fw-snmp', row: { vendor: 'Huawei V600R007', version: 'USG6550E' }, expect: true },
  { name: 'Huawei V200 交换机 × USG 防火墙模板 → 子类型不符', cls: 'network', template: 'huawei-fw-snmp', row: { vendor: 'Huawei V200R019C10', version: 'S5735-L48T4X' }, expect: false },
  { name: '型号未知 × 交换机模板 → 不宣称兼容', cls: 'network', template: 'huawei-snmp', row: { vendor: 'Huawei V600R007' }, expect: false },
  { name: '厂商未知 × 交换机模板 → 不宣称兼容', cls: 'network', template: 'huawei-snmp', row: { vendor: 'UnknownDevice X1', version: 'S5700' }, expect: false },
  { name: 'Kylin V10 服务器 × Linux 模板 → 兼容', cls: 'server', template: 'linux-basic', row: { os: 'Kylin OS V10 SP3' }, expect: true },
  { name: 'CentOS 7.9 服务器 × Linux 最小模板 → 兼容', cls: 'server', template: 'linux-minimal', row: { os: 'CentOS 7.9' }, expect: true },
  { name: 'Windows Server 2019 × Linux 模板 → 操作系统不符', cls: 'server', template: 'linux-basic', row: { os: 'Windows Server 2019' }, expect: false },
  { name: '服务器系统未知 × Linux 模板 → 不宣称兼容', cls: 'server', template: 'linux-basic', row: { os: '' }, expect: false },
];

const results = cases.map((c) => {
  const context = vm.createContext({ ui: { cls: c.cls }, cfg: { templateId: c.template }, fixture: c.row });
  const actual = vm.runInContext(`${templates}
function ensureConfig() { return cfg; }
${funcs}
compatResult(fixture)`, context);
  return { name: c.name, cls: c.cls, template: c.template, row: c.row, expect: c.expect, ok: actual.ok, reason: actual.reason ?? null, pass: actual.ok === c.expect };
});

const failed = results.filter((r) => !r.pass);
const out = {
  generatedAt: new Date().toISOString(),
  source: SRC,
  method: '原型源码的 templateById/compatResult 在隔离 VM 中执行；合成输入，不代表真实数据库/设备验收',
  total: results.length,
  passed: results.length - failed.length,
  results,
};
const outPath = process.argv[2];
if (outPath) writeFileSync(outPath, JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
console.log(`\n${out.passed}/${out.total} version checks passed`);
if (failed.length) process.exit(1);
