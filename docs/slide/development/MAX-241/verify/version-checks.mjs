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

/* 默认读取工作树原型源码；MAX241_APP_SRC 供 RED 对照指向修复前的同一文件副本，
   用例与判定逻辑不变。 */
const SRC = process.env.MAX241_APP_SRC ?? fileURLToPath(new URL('../prototype/app.js', import.meta.url));
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
  { name: 'CentOS 版本未知 × Linux 模板 → 不宣称兼容', cls: 'server', template: 'linux-basic', row: { os: 'CentOS unknown' }, expect: false },
  { name: 'Linux 仅有系统名无版本 × Linux 最小模板 → 不宣称兼容', cls: 'server', template: 'linux-minimal', row: { os: 'Linux' }, expect: false },
  { name: 'Kylin 版本缺失 × Linux 模板 → 不宣称兼容', cls: 'server', template: 'linux-basic', row: { os: 'Kylin OS' }, expect: false },
  /* review5 反例：架构/内核/构建号不是系统版本；两个 Linux 模板分别验证。 */
  { name: 'CentOS unknown (x86_64) × Linux 模板 → 架构数字不是版本', cls: 'server', template: 'linux-basic', row: { os: 'CentOS unknown (x86_64)' }, expect: false },
  { name: 'CentOS unknown (x86_64) × Linux 最小模板 → 架构数字不是版本', cls: 'server', template: 'linux-minimal', row: { os: 'CentOS unknown (x86_64)' }, expect: false },
  { name: 'Kylin OS unknown (aarch64) × Linux 模板 → 架构数字不是版本', cls: 'server', template: 'linux-basic', row: { os: 'Kylin OS unknown (aarch64)' }, expect: false },
  { name: 'Kylin OS unknown (aarch64) × Linux 最小模板 → 架构数字不是版本', cls: 'server', template: 'linux-minimal', row: { os: 'Kylin OS unknown (aarch64)' }, expect: false },
  { name: 'Linux x86_64 无系统版本 × Linux 模板 → 只有架构不宣称兼容', cls: 'server', template: 'linux-basic', row: { os: 'Linux x86_64' }, expect: false },
  { name: 'Linux x86_64 无系统版本 × Linux 最小模板 → 只有架构不宣称兼容', cls: 'server', template: 'linux-minimal', row: { os: 'Linux x86_64' }, expect: false },
  { name: 'CentOS 只有架构括号无版本 × Linux 模板 → 不宣称兼容', cls: 'server', template: 'linux-basic', row: { os: 'CentOS (x86_64)' }, expect: false },
  { name: 'Linux 内核号 × Linux 模板 → 内核号不是系统版本', cls: 'server', template: 'linux-basic', row: { os: 'Linux kernel 5.14' }, expect: false },
  { name: 'CentOS 构建号 × Linux 最小模板 → 构建号不是系统版本', cls: 'server', template: 'linux-minimal', row: { os: 'CentOS build 19042' }, expect: false },
  { name: 'CentOS 7.9 (x86_64) × Linux 模板 → 合法版本带架构仍兼容', cls: 'server', template: 'linux-basic', row: { os: 'CentOS 7.9 (x86_64)' }, expect: true },
  { name: 'Kylin OS V10 SP3 (aarch64) × Linux 最小模板 → 合法版本带架构仍兼容', cls: 'server', template: 'linux-minimal', row: { os: 'Kylin OS V10 SP3 (aarch64)' }, expect: true },
  { name: 'Ubuntu 22.04 amd64 × Linux 模板 → 合法版本带架构仍兼容', cls: 'server', template: 'linux-basic', row: { os: 'Ubuntu 22.04 amd64' }, expect: true },
  { name: 'Red Hat Enterprise Linux 9.4 (x86_64) × Linux 最小模板 → 合法版本带架构仍兼容', cls: 'server', template: 'linux-minimal', row: { os: 'Red Hat Enterprise Linux 9.4 (x86_64)' }, expect: true },
  { name: 'Linux 6.1 (x86_64) × Linux 模板 → 合法版本带架构仍兼容', cls: 'server', template: 'linux-basic', row: { os: 'Linux 6.1 (x86_64)' }, expect: true },
  { name: 'CentOS Linux 7 (Core) × Linux 模板 → 括号代号不误判版本', cls: 'server', template: 'linux-basic', row: { os: 'CentOS Linux 7 (Core)' }, expect: true },
  { name: 'Ubuntu 22.04.3 LTS (Jammy) × Linux 最小模板 → 括号代号不干扰版本', cls: 'server', template: 'linux-minimal', row: { os: 'Ubuntu 22.04.3 LTS (Jammy)' }, expect: true },
  { name: 'Windows Server 2019 (x86_64) × Linux 模板 → 操作系统不符', cls: 'server', template: 'linux-basic', row: { os: 'Windows Server 2019 (x86_64)' }, expect: false },
  { name: 'Windows Server 2019 amd64 × Linux 最小模板 → 操作系统不符', cls: 'server', template: 'linux-minimal', row: { os: 'Windows Server 2019 amd64' }, expect: false },
  /* review7 反例：元数据 span 必须整体剔除；只含元数据的描述没有系统版本。
     同一组输入分别在两个 Linux 模板上验证（模板约束不同，判定逻辑相同）。 */
  ...['linux-basic', 'linux-minimal'].flatMap((template) => [
    { name: `Linux kernel=6.1 × ${template} → 等号内核元数据不是系统版本`, cls: 'server', template, row: { os: 'Linux kernel=6.1' }, expect: false, expectLabel: null },
    { name: `Linux kernel release 5.14.0 × ${template} → release 修饰内核元数据不是系统版本`, cls: 'server', template, row: { os: 'Linux kernel release 5.14.0' }, expect: false, expectLabel: null },
    { name: `Linux 64 bit × ${template} → 位数不是系统版本`, cls: 'server', template, row: { os: 'Linux 64 bit' }, expect: false, expectLabel: null },
    { name: `Linux x86 × ${template} → 裸架构不是系统版本`, cls: 'server', template, row: { os: 'Linux x86' }, expect: false, expectLabel: null },
    { name: `Linux kernel 5.14.0-427.13.1.el9 × ${template} → 完整内核号后缀不残留为系统版本`, cls: 'server', template, row: { os: 'Linux kernel 5.14.0-427.13.1.el9' }, expect: false, expectLabel: null },
  ]),
  /* 合法系统版本与完整内核元数据并存：只取显式系统版本，不吃内核号也不被后缀污染。 */
  { name: 'CentOS 7.9 kernel 5.14.0-427.13.1.el9 × Linux 模板 → 取 7.9 而非 9', cls: 'server', template: 'linux-basic', row: { os: 'CentOS 7.9 kernel 5.14.0-427.13.1.el9' }, expect: true, expectLabel: '7.9' },
  { name: 'CentOS 7.9 kernel 5.14.0-427.13.1.el9 × Linux 最小模板 → 取 7.9 而非 9', cls: 'server', template: 'linux-minimal', row: { os: 'CentOS 7.9 kernel 5.14.0-427.13.1.el9' }, expect: true, expectLabel: '7.9' },
  { name: 'Ubuntu 22.04 kernel 6.5 × Linux 模板 → 取 22.04 而非内核号 6.5', cls: 'server', template: 'linux-basic', row: { os: 'Ubuntu 22.04 kernel 6.5' }, expect: true, expectLabel: '22.04' },
  { name: 'Linux 6.1 × Linux 模板 → 既有合法基线仍可用', cls: 'server', template: 'linux-basic', row: { os: 'Linux 6.1' }, expect: true, expectLabel: '6.1' },
  { name: 'Linux kernel 6.1 × Linux 模板 → 缺显式系统版本，不取内核号', cls: 'server', template: 'linux-basic', row: { os: 'Linux kernel 6.1' }, expect: false, expectLabel: null },
];

const results = cases.map((c) => {
  const context = vm.createContext({ ui: { cls: c.cls }, cfg: { templateId: c.template }, fixture: c.row });
  const actual = vm.runInContext(`${templates}
function ensureConfig() { return cfg; }
${funcs}
({ compat: compatResult(fixture), resource: resourceEngine(fixture) })`, context);
  const label = actual.resource?.versionLabel ?? null;
  const labelOk = c.expectLabel === undefined ? true : label === c.expectLabel;
  return {
    name: c.name, cls: c.cls, template: c.template, row: c.row, expect: c.expect,
    ok: actual.compat.ok, reason: actual.compat.reason ?? null, versionLabel: label,
    ...(c.expectLabel === undefined ? {} : { expectLabel: c.expectLabel }),
    pass: actual.compat.ok === c.expect && labelOk,
  };
});

const failed = results.filter((r) => !r.pass);
const out = {
  generatedAt: new Date().toISOString(),
  source: SRC,
  method: '原型源码的 templateById/compatResult/resourceEngine 在隔离 VM 中执行；合成输入，不代表真实数据库/设备验收',
  total: results.length,
  passed: results.length - failed.length,
  results,
};
const outPath = process.argv[2];
if (outPath) writeFileSync(outPath, JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
console.log(`\n${out.passed}/${out.total} version checks passed`);
if (failed.length) process.exit(1);
