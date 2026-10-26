# 原型浏览器验证记录（设计修复 R1–R6）

日期：2026-10-26｜验证提交：任务分支 `a4996163a`（R4/R6 再修复轮；发布分支为同内容的设计专用提交，见 PR）｜对象：[prototype/](prototype/) 独立原型（演示数据，不连后端）。生产详情页未修改。

## 1. 环境

| 项 | 值 |
|---|---|
| 系统 | macOS 27.0.1（Darwin 27.0.0），Apple Silicon |
| 浏览器 | Google Chrome 156.0.8078.48（headless new） |
| 驱动 | Node v24.18.0 + Chrome DevTools Protocol（零第三方依赖） |
| 原型服务 | Vite 5.4.21，`127.0.0.1:8971`，只读复用 `frontend/src` 共享组件 |
| 依赖 | `pnpm install --frozen-lockfile --offline`（使用本机 store） |
| 视口 | 1440×900（主验）、1366×768、1920×1080；另加 1100×800 降级与 1366×768 长名称 |
| 数据 | 全部演示数据；无 API、无模型、无真实资源，不写后端状态 |

## 2. 复现命令

```bash
# 1) 依赖（已有 node_modules 可跳过）
pnpm install --frozen-lockfile

# 2) 启动原型（仓库根目录）
frontend/node_modules/.bin/vite --config docs/slide/development/MAX-241/prototype/vite.config.mjs

# 3) 完整检查（另开终端）
node docs/slide/development/MAX-241/verify/run-checks.mjs \
  http://127.0.0.1:8971/docs/slide/development/MAX-241/prototype \
  /Users/max/Coding/40-Slide/outputs/MAX-241-2026-10-26/repair/screenshots

# 4) 只跑 11 项反例（RED/GREEN）
node docs/slide/development/MAX-241/verify/run-checks.mjs <base> <out> --counterexamples --label old|new
```

R4/R6 再修复轮另用 Chief 复审脚本（`chief-edge-checks.mjs`，外部附件、不入库）做独立复核：
修复前 20/23、修复后 23/23，同样只读原型、不连后端、不调用模型。

## 3. 完整检查：88/88 通过（R4/R6 再修复轮）

机器可读结果：`checks.json`（本轮输出目录），绑定提交见文末。本轮新增 9 项配置负例与试采单元格断言，沿用其余 79 项。

| 分组 | 检查 | 结果 |
|---|---|---|
| 共享组件（R5） | `app-card` / `app-badge` / `app-data-table` 正在使用；无 `.card/.badge/.dialog` 重复类；内容区按钮使用共享按钮契约 | 通过（5/5） |
| 列表 × 3 类 | 业务列恰好八列且名称符合 Issue；行内四操作完整；无整页横向溢出；`role=region` 局部横滚容器 | 通过（15/15） |
| 详情 × 3 类 | 页签集合与顺序（13/10/6）；保留关联调查/事件/审计联动行 | 通过（6/6） |
| 键盘 | `→` 切页签且焦点跟随；页签可见焦点环 | 通过（2/2） |
| 弹窗 | `app-dialog` 打开后焦点进入；`Esc` 关闭并返回触发按钮 | 通过（2/2） |
| 状态 | 无数据 / 加载中 / 加载失败 / 部分失败 / 页面 403 / 模块 403 明确呈现 | 通过（7/7） |
| 权限 | 只读禁用写操作；监控配置只读且有原因；数据库 `manage≠update/delete`；网络备份读/写分离 | 通过（6/6） |
| 反例（GREEN） | 选中行身份 ×3、页面 403 ×3、可编辑配置 ×3、非数据库模板流程 ×2 | 通过（11/11） |
| 配置流程 | 参数修改更新最终值并重置流程；检查→试采→发布→应用→等待正式样本；绑定随资源变化 | 通过（7/7） |
| 配置兼容性拒绝（R4） | MySQL 资源 × PostgreSQL 模板：第一步阻断、提示不兼容原因、试采/发布按钮禁用、点击不推进 | 通过（3/3） |
| 页头试采门控（R4） | 页头“试采”先执行兼容性检查；不兼容模板同样被拒绝，不产生“试采完成” | 通过（2/2） |
| 试采明细单元格（R6） | 三类各 3 行采集项/结果/说明非空；数据库含部分失败 + `ER_TABLEACCESS_DENIED` 与未全部成功汇总 | 通过（4/4） |
| 上下文 | 指标页使用所选资源 id；返回恢复筛选/横滚/焦点；旧深链接可用 | 通过（4/4） |
| 三档宽度 | 1440/1366/1920 列表与关键详情无整页溢出、主操作可达（含容器内滚动后） | 通过（12/12） |
| 长名称 / 窄窗口 | 1366×768 长名换行不溢出；1100×800 降级为表格内横滚 | 通过（2/2） |

## 4. 反例 RED → GREEN（20/20）

1–11 项为早期修复的断言，12–20 项为 R4/R6 再修复新增；同一脚本分别运行在修复前原型（RED）与本轮原型（GREEN）：

| # | 反例 | 修复前 | 修复后 |
|---|---|---|---|
| 1 | 数据库第二行“详情”显示 `mysql-report-readonly` / 10.20.1.18:3306 | 失败：显示首行 `mysql-order-prod` / 10.20.1.15:3306 | 通过 |
| 2 | 服务器第二行显示 `app-prod-02` / 10.20.1.22:22 | 失败：显示 `app-prod-01` | 通过 |
| 3 | 网络设备第二行显示 `sw-agg-02` / 10.20.1.2:161 | 失败：显示 `sw-core-01` | 通过 |
| 4 | 数据库页面 403 不含名称/地址/联动/操作/页签 | 失败：仍显示名称、地址、3 个页头操作、13 页签、联动行 | 通过（全部清空） |
| 5 | 服务器页面 403 同上 | 失败：同首行泄露 | 通过 |
| 6 | 网络设备页面 403 同上 | 失败：同首行泄露 | 通过 |
| 7 | 数据库“修改模板与参数”可编辑 | 失败：按钮为 `noop`，无模板/参数控件 | 通过（模板 + 4 参数） |
| 8 | 服务器可编辑配置 | 失败：无编辑控件 | 通过 |
| 9 | 网络设备可编辑配置 | 失败：无编辑控件 | 通过 |
| 10 | 服务器检查/启用流程不出现 MySQL | 失败：弹窗硬编码“MySQL 基础采集 v2.4.1” | 通过（无 MySQL） |
| 11 | 网络设备检查/启用流程不出现 MySQL | 失败：同上 | 通过 |

| 12 | 不兼容模板（MySQL 资源 × PostgreSQL 模板）检查未通过并阻止试采/发布 | 失败：提示“MySQL 8.0.34 与模板兼容”，试采/发布均可用 | 通过（首步标 ✕ 阻断，两按钮禁用） |
| 13 | 不兼容时展示最近试采明细（3 项非空、含部分失败与错误码）并标注已失效 | 失败：无试采表 | 通过（核心指标/慢查询/会话快照 + `ER_TABLEACCESS_DENIED`） |
| 14 | 不兼容状态下点击试采/发布均不推进、不进入已发布 | 失败：进入“已发布，等待应用” | 通过（状态停留在拒绝态） |
| 15 | 页头“试采”先完成兼容性检查再试采（不跳过前置检查） | 失败：直接置“试采完成”，无检查结果 | 通过（先检查后试采） |
| 16 | 页头“试采”对不兼容模板同样拒绝，不产生试采完成 | 失败：仍显示试采完成 | 通过（拒绝态 + 发布禁用） |
| 17 | 数据库试采表三项“采集项/结果/说明”均非空 | 失败：三行全空（数组被当对象字段读取） | 通过 |
| 18 | 数据库试采展示部分失败与错误码，并提示未全部成功 | 失败：无结果、无错误码 | 通过（部分失败 · `ER_TABLEACCESS_DENIED`） |
| 19 | 服务器试采表三项非空 | 失败：三行全空 | 通过（含“待验证”项） |
| 20 | 网络设备试采表三项非空 | 失败：三行全空 | 通过（含“模板未覆盖”项） |

RED 产物：`.../repair/red-old/counterexamples-old.json`（0/11，早期 11 项）；本轮新增 9 项 RED 为完整检查 79/88（旧原型 + 新脚本）。GREEN 产物：`.../repair/green-new/counterexamples-new.json`（11/11）与完整检查 88/88。Chief 独立脚本同一路径：20/23 → 23/23。

## 5. 权限与状态证据（原型级）

- 页面 403 不渲染资源身份；模块 403 保留身份、仅当前页签无权限。
- 只读：编辑/测试/删除禁用；监控配置显示“只读：缺少 …:manage”。
- 数据库 `manager` 预设：`instance:manage` 不含 `update/delete` → 编辑/删除禁用，监控配置仍可编辑（与 06 §1 一致）。
- 网络设备 `manager`：备份写禁用（原因 `network_devices:backup`）、备份列表仍可读；`backup` 预设下保存定时可用。
- 配置流程不伪造：试采“不写正式历史”，发布后“等待应用”，应用后“等待首个正式样本，不代表已健康”；P1 前不显示触发器数量。
- 配置兼容性：资源引擎族与模板引擎族不一致时（MySQL × PostgreSQL）明确拒绝，首步阻断、试采/发布禁用；页头“试采”与四步引用同一检查，不绕过。
- 试采明细：三类逐项显示成功 / 部分失败（含错误码）/ 待验证 / 模板未覆盖；部分失败旁给出“未全部成功”汇总，空白结果与“试采完成”不再并存。

## 6. 截图索引（`.../repair/screenshots/`，44 张）

| 文件 | 用途 |
|---|---|
| `db-list-1440x900.png` / `server-list-1440x900.png` / `network-list-1440x900.png` | 三类列表八列 + 四操作 + 局部横滚 |
| `db-list-1366x768.png` / `db-list-1920x1080.png` / `db-list-narrow-1100x800.png` | 三档与窄窗降级 |
| `db-detail-overview-1440x900.png` / `server-detail-overview-1440x900.png` / `network-detail-overview-1440x900.png` | 详情共享框架 |
| `db-detail-collection-full-1440x900.png` | 监控配置：绑定、有效参数、四步、触发器未接入、覆盖、事件 |
| `db-config-edited-flow-1440x900.png` | 参数修改后的检查/试采/发布/应用状态 |
| `db-config-incompatible-blocked-1440x900.png` | MySQL 资源选 PostgreSQL 模板：阻断、试采/发布禁用、最近试采标注已失效 |
| `{db,server,network}-config-trial-results-1440x900.png` | 三类试采明细单元格（含部分失败与错误码、待验证/未覆盖） |
| `server-detail-diagnostics-1440x900.png`（及 1366/1920） | 诊断证据条、分区部分失败、唯一采集操作 |
| `network-detail-backups-1440x900.png`（及 1366/1920） | 定时备份 + 备份列表 |
| `network-backups-backup-permission-1440x900.png` | `backup` 预设下写可用 |
| `counter-{db,server,network}-second-row.png` | 第二行身份（R2） |
| `counter-{db,server,network}-page-forbidden.png` | 页面 403 清空上下文（R3） |
| `counter-{db,server,network}-config-editable.png` | 可编辑配置（R4） |
| `counter-{server,network}-template-flow.png` | 非数据库模板流程（R4） |
| `db-detail-state-{empty,loading,error,partial,forbidden}-1440x900.png` / `server-detail-state-module403-1440x900.png` | 六态 + 模块 403 |
| `db-detail-focus-1440x900.png` / `db-list-test-dialog-1440x900.png` | 键盘焦点环、共享弹窗 |
| `db-detail-long-name-1366x768.png` | 长名称换行 |

## 7. 限制与未覆盖

- 原型为静态演示：**未连接后端**；权限、采集、模板发布、备份、诊断、AI 均为本地演示。截图与检查只证明设计与前端呈现。
- 未验证真实权限矩阵、资源范围、服务端 403/401、审计记录、幂等与真实业务闭环；这些属实施阶段 A01/A02/A05/A09 与 R-81/R-82/R-83。
- 未做人工读屏/VoiceOver 验收（按既定决定取消）；键盘、焦点、控件名称与自动化可访问性检查保留。
- 未做移动/平板、暗色、多语言专项（项目范围排除）。
- 原型复用共享组件，但生产实施仍以现有 `instance-detail` / `server-detail` / `network-device-detail` 为基线修改，不复制原型代码。
- 本记录只覆盖设计修复（R1–R6）；整单生产 UI 实施与 P1 数据能力仍未放行。
- R4 的配置业务组件仍是**独立演示状态机**，不等于已完成生产 `metric-configuration` 接入；真实模板目录、兼容性判定、试采与发布接口仍需实施阶段验证。
- 本轮只修配置原型（R4）与其验证（R6），未重做已接受设计，未改生产 frontend/API/导航/共享组件。

## 8. 提交绑定

- R4/R6 再修复轮验证对象为任务分支提交 `a4996163a`（原型、验证脚本与本文档同属该提交；其后仅新增本文档的 SHA 绑定提交，代码不变）；验证时 Vite 服务只读同一工作树文件，未缓存旧模块。
- 机器结果：完整 88/88、反例 11/11、Chief 独立脚本 23/23；RED 分别为 79/88、旧 11 项 0/11（历史）、Chief 20/23。

## 9. F1/F2 修复轮（2026-10-26 晚，对应 Chief review3）

复审对象为发布 SHA `f5815e786`（任务 `8496ea3f1`）。复审接受 R1/R2/R3/R5，R4/R6 保留两项：**F1** 只比引擎族，版本/设备子类型不兼容仍可检查通过、页头试采并发布；**F2** 不兼容分支把按类通用样例显示为“最近一次试采”，没有绑定资源/模板/配置版本/时间的历史快照。本轮只改配置原型与受影响验证，未重做已接受设计。

### 9.1 修复

| 项 | 根因 | 修复 |
|---|---|---|
| F1 | `compatResult` 只比较引擎族；`resourceEngine` 把所有服务器强制归为 linux，网络设备只看厂商 | `TEMPLATE_TARGETS` 为每个模板声明引擎族、资源类别/设备子类型、平台与版本范围（MySQL 8.0–8.x、PostgreSQL 14+、达梦 DM8、Huawei VRP V200 / V600）；资源侧按 `dbType` + 版本、`os`、`vendor` + 型号解析；未知引擎/型号/版本与未声明范围的模板一律拒绝；检查、页头试采、发布独立调用同一判定 |
| F2 | incompatible 分支直接取 `TRIAL_FIXTURES[ui.cls]` 并称“最近一次试采结果” | 试采证据绑定资源、模板版本、配置版本、时间与来源（`TRIAL_HISTORY` 显式预置 `mysql-order-prod #12`）；无历史显示“未试采”；失败检查不生成证据；修改模板/参数后保留的失效快照标注原因，发布仍要求本轮重新检查并试采 |

### 9.2 证据（绑定本轮源码，未连后端、未调用模型）

| 检查 | 结果 |
|---|---|
| 完整浏览器检查，Chrome 156.0.8078.48 headless + CDP | **103/103**（上轮 88 项中未变化部分沿用，本轮新增 15 项） |
| 完整浏览器检查，Microsoft Edge 156.0.4314.42（同一脚本，`MAX241_BROWSER` 指定浏览器） | **103/103** |
| 版本/子类型合成输入 `verify/version-checks.mjs` | **20/20**（含 Chief 的 MySQL 5.7、PG 13.12、PG 16.4、Huawei V600 × V200 交换机模板四项） |
| 早期 11 项反例 | 11/11 |
| Chief 复审脚本 `chief-focused-browser.mjs` 原样运行（Chrome / Edge） | 34/35（两个浏览器一致）；唯一失败项为旧语义断言 `trial===null`，本轮按复审允许“修改后可保留失效快照”，其余含 `compat` 清空、`step=0`、发布被拒均通过 |

本轮新增断言分组：

| 分组 | 检查 | 结果 |
|---|---|---|
| F2 无历史 | 无试采历史资源（`mysql-report-readonly #9`）检查失败后无试采表、显示“未试采”，试采/发布禁用 | 通过 |
| F2 预置历史 | 未检查时标注“最近一次试采记录”并绑定 `mysql-order-prod #12 · MySQL 基础采集 v2.4.1 · 配置版本 37 · 2026-10-25 21:08 · 预置历史快照`，发布禁用 | 通过 |
| F2 本轮试采 | 演示试采绑定资源/模板/配置版本/时间并标“本次试采结果”；改模板后保留带原模板绑定的失效快照且不可发布 | 通过（2/2） |
| F1 子类型 | `fw-edge-01`（Huawei V600R007 / USG6550E）选 Huawei VRP V200 交换机模板：检查拒绝（“要求交换机…是防火墙”）、页头试采与发布均不推进 | 通过（3/3） |
| F1 合法路径 | 同一设备选 USG 防火墙模板通过（`防火墙 · 平台 V600`）；Kylin 服务器选 Linux 模板按系统约束通过 | 通过（2/2） |
| 三档尺寸 | 1440×900 / 1366×768 / 1920×1080 下阻断页与历史快照无整页溢出、按钮禁用状态一致 | 通过（6/6） |

### 9.3 复现

```bash
# 版本/子类型合成输入（无需浏览器）
node docs/slide/development/MAX-241/verify/version-checks.mjs

# 完整检查（Chrome）
node docs/slide/development/MAX-241/verify/run-checks.mjs \
  http://127.0.0.1:8971/docs/slide/development/MAX-241/prototype <out>

# 同一套检查在真实 Edge 运行
MAX241_BROWSER="/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" \
MAX241_CDP_PORT=19354 node docs/slide/development/MAX-241/verify/run-checks.mjs <base> <out-edge>
```

### 9.4 结论与边界

- F1/F2 已按复审的精确范围修复；R1/R2/R3/R5 与 D05/O02/O03 未改动。
- 合成输入只证明判定函数，**不代表真实数据库或真实设备验收**；生产模板目录、兼容性判定、试采/发布接口仍需实施阶段用真实环境验证。
- 配置业务组件仍是独立演示状态机，不等于已完成生产 `metric-configuration` 接入；生产 ACL、采集、幂等与审计闭环未验证。
- 未发送模型请求、未写 224 账本、未操作真实资源或共享服务；人工听读不设门禁。

## 10. F1 未知版本判定再修复（2026-10-26，对应 Chief review4）

复审在已接受的 F1 修复上保留一项：**已知 Linux 族但版本不可确认**的资源（如 `CentOS unknown` 对 `linux-basic`）仍返回兼容并可试采/发布。根因是 Linux 模板只声明操作系统系列、没有版本约束，而 `compatResult` 仅在 `target.min` 存在时校验版本；缺 `min` 的模板直接跳过版本判定，`parseVersion` 返回 `null` 也被放过。

### 10.1 修复

| 项 | 根因 | 修复 |
|---|---|---|
| F1 未知版本误兼容 | Linux 模板无 `min`，版本判定被整体跳过 | `TEMPLATE_TARGETS` 的 `linux-basic` / `linux-minimal` 增加 `requireVersion: true`；`compatResult` 版本判定改为 `target.min` 或 `target.requireVersion` 时执行，无 `min` 时只要求版本可解析，不虚构版本下界 |

- 与 `03-detail-design.md` "任一维度不可验证（未知引擎、未知型号、未知版本、未声明适配范围的模板）都不得宣称兼容" 一致。
- 兼容性说明（`constraintLabel`）在没有版本区间时追加"版本需可确认"，检查通过时同样如实展示约束。
- 未知引擎/未知型号/未知平台/未声明适配范围、MySQL 8.0–8.x、PostgreSQL 14+、达梦 DM8、Huawei V600 × V200 子类型等既有判定不变。

### 10.2 证据

| 检查 | 修复前（RED，`4d47407e1` 的 `app.js`） | 修复后（GREEN） |
|---|---|---|
| `verify/version-checks.mjs`（23 项） | 20/23 —— `CentOS unknown`、仅有系统名 `Linux`、`Kylin OS` 无版本三项被误判兼容 | **23/23** |
| `verify/run-checks.mjs` 完整检查，Chrome 156.0.8078.48 | — | **103/103** |
| 同一脚本，Microsoft Edge 156.0.4314.42 | — | **103/103** |

- RED 复现：把同一 `verify/version-checks.mjs` 指向 `4d47407e1` 的 `app.js` 副本运行，失败项恰为上述三项；原有 Kylin V10 / CentOS 7.9 演示资源仍判兼容。
- 浏览器全套断言未改动，用于证明本次判定改动没有回归（Chrome 与 Edge 结果一致）。

### 10.3 绑定与边界

- 验证对象：本轮提交的 `prototype/app.js` 与 `verify/version-checks.mjs`（SHA 绑定见 §10.4），起始提交 `4d47407e1`。
- 复现：`node docs/slide/development/MAX-241/verify/version-checks.mjs`；完整检查命令同 §2，服务只读同一工作树文件。
- 合成输入只证明判定函数与原型呈现，**不代表真实服务器/数据库或设备验收**；生产模板目录、兼容性判定、试采/发布接口仍需实施阶段用真实环境验证。
- 本轮未改生产代码、共享组件、后端或导航；未发模型请求、未写 224 账本、未操作真实资源或共享服务。

### 10.4 SHA 绑定

- 修复与验证同属提交 `f6fb341df`（分支 `agent/15coder1/max-241`，起始 `4d47407e1` 保留；其后仅本文档追加本节，代码不变）。
- `prototype/app.js` sha256 `4943aa136f3d565f3b89437bcf1f2698c6758f6eccd8f98b6a45b0bc0e0704e4`
- `verify/version-checks.mjs` sha256 `b3a291f29d496a5f81deafc9a7c2b279c0674336b6cff562ca5db9dab373dc44`
- 机器结果：GREEN 23/23、Chrome 103/103、Edge 103/103；RED 20/23（同一脚本指向 `4d47407e1` 的 `app.js` 副本）。

## 11. F1 系统版本来源修复（2026-10-26，对应 Chief review5）

review5 接受纯 `unknown`/无版本拒绝，但指出新缺口：`parseVersion` 无条件取系统描述里的第一个数字，把架构号当成了系统版本。`CentOS unknown (x86_64)`、`Kylin OS unknown (aarch64)`、`Linux x86_64` 因此被判兼容，且检查、页头试采、配置试采、发布都按同一错误结论放行。

### 11.1 修复

| 项 | 根因 | 修复 |
|---|---|---|
| 架构号被当作系统版本 | 取数前没有区分系统版本与非版本元数据 | 新增 `VERSION_METADATA` 清洗：括号补充说明（括号内是纯版本号时保留）、架构标识（`x86_64`/`amd64`/`x64`/`aarch64`/`arm64`/`i386`/`ppc64*`/`s390x`/`riscv*`/`mips*`）、`<n>-bit`、`kernel|build|内核|构建` 及其编号 |
| 描述写明 unknown 仍取到数字 | 只判断能否解析出数字 | 清洗后命中 `unknown|未知|未确认|待确认|n/a` 即判定版本不可确认，返回 `null` |
| 展示版本不忠实 | 直接打印归一化数组（`22.04` → `22.4`） | 新增 `versionLabel`，按描述原样显示（`V10`、`22.04`、`9.4`） |
| 未知语义不可见 | 拒绝原因只说“版本未知” | 服务器拒绝原因明确“系统描述中的架构、内核、构建号不作为系统版本”；通过时注明“系统版本 X 取自系统描述” |

- 判定入口不变：检查（`runCompat`）、页头试采（`headerTrial`）、配置试采（`runTrial`）、发布（`publishConfig`）仍各自调用同一个 `compatResult`，没有新增第二套判定，也没有放行旁路。
- 不发明版本下界或支持矩阵，不删除已支持操作系统；数据库/设备版本字符串同样先剔除架构等元数据，保留原有版本范围判定。
- 新增评审用内存钩子 `window.__max241Review.setServerOs(id, os)`（仅覆盖演示数据并重绘，不是产品 API，不写后端），使反例可在浏览器中复现。

### 11.2 证据（合成输入，绑定本轮源码）

| 检查 | 修复前（RED） | 修复后（GREEN） |
|---|---|---|
| `verify/version-checks.mjs`（41 项） | 32/41 —— 9 项失败，含 review5 的 3 反例 × 2 模板 | **41/41** |
| `verify/run-checks.mjs` 完整检查，Chrome 156.0.8078.48 | — | **130/130** |
| 同一脚本，Microsoft Edge 156.0.4314.42（`Browser.getVersion` = `Edg/156.0.4314.42`） | — | **130/130** |

- RED 复现：先只新增用例、不改源码，同一脚本 32/41；失败项恰为 `CentOS unknown (x86_64)`、`Kylin OS unknown (aarch64)`、`Linux x86_64`（各 2 模板）、`CentOS (x86_64)`、`Linux kernel 5.14`、`CentOS build 19042`；其余 32 项（含 Kylin V10、CentOS 7.9、MySQL/PostgreSQL/达梦、网络子类型）行为不变。
- 新增 GREEN 用例 18 项：3 反例 × 2 模板、仅架构无版本、内核号、构建号、`CentOS 7.9 (x86_64)`、`Kylin OS V10 SP3 (aarch64)`、`Ubuntu 22.04 amd64`、`Red Hat Enterprise Linux 9.4 (x86_64)`、`Linux 6.1 (x86_64)`、`CentOS Linux 7 (Core)`、`Ubuntu 22.04.3 LTS (Jammy)`、Windows 带架构负例 × 2。
- 浏览器新增 27 项（103 → 130）：
  - 3 反例 × 3 档尺寸（1440×900 / 1366×768 / 1920×1080）：检查以 `role=alert` 拒绝并显示未知语义、试采与发布禁用、检查按钮仍可聚焦、无整页横向溢出；页头试采同样未通过且不产生试采结果（9 + 9 项）。
  - `CentOS 7.9 (x86_64)` 三档尺寸：检查通过并注明“系统版本 7.9 取自系统描述”，试采 3 项、发布进入“等待应用”（3 项）。
  - `Kylin OS V10 SP3 (aarch64)` / `Ubuntu 22.04 amd64` / `Red Hat Enterprise Linux 9.4 (x86_64)` 跨两个 Linux 模板仍通过（3 项）。
  - 合法检查后把系统改为 `Linux x86_64`：配置试采、页头试采、发布三个入口各自独立拒绝，界面仍保留旧的“兼容”结论但入口不放行（3 项）。
- 截图：`/Users/max/Coding/40-Slide/outputs/MAX-241-f1-os-provenance-20261026/screenshots-chrome|screenshots-edge/`（`server-os-provenance-*`）。
- 浏览器身份：`browser-chrome.json`（`Chrome/156.0.8078.48`）、`browser-edge.json`（`Edg/156.0.4314.42`）。

### 11.3 复现

```bash
# 1) 原型服务（仓库根目录）
frontend/node_modules/.bin/vite --config docs/slide/development/MAX-241/prototype/vite.config.mjs
# 2) 判定函数（合成输入）
node docs/slide/development/MAX-241/verify/version-checks.mjs
# 3) 浏览器（Chrome / 实际 Edge）
node docs/slide/development/MAX-241/verify/run-checks.mjs http://127.0.0.1:8971/docs/slide/development/MAX-241/prototype <输出目录>
MAX241_BROWSER="/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" MAX241_CDP_PORT=9344 \
  node docs/slide/development/MAX-241/verify/run-checks.mjs http://127.0.0.1:8971/docs/slide/development/MAX-241/prototype <输出目录>
# 4) 浏览器身份
node docs/slide/development/MAX-241/verify/browser-version.mjs "<浏览器可执行文件>" 9356 <输出JSON>
```

### 11.4 边界与绑定

- 合成系统描述只证明判定函数与原型呈现；**不代表真实服务器/采集验收**，也没有连接后端、真实资源或共享服务。
- 生产模板目录、真实资源的系统版本字段来源与未知语义仍需实施阶段按真实契约验证；本轮不改生产 frontend/API/导航/共享组件。
- 未发模型请求、未写 224 账本、未部署、无子代理；人工听读不设门禁。
- SHA 绑定见 §11.5。

### 11.5 SHA 绑定

- 修复与验证同属提交 `2f27450d1`（分支 `agent/15coder1/max-241`，起始 `08d249008` 保留，未 amend/rebase；本节为随后的文档追加，代码不变）。
- `prototype/app.js` sha256 `57eba64c0d88add0de096dc17239ee16ff6f254b93e0befa8128d1f9060639d4`
- `verify/version-checks.mjs` sha256 `a92ded99a8e9d763e693a9ec9c9d450f14f28a62d8c2a95addbade13c17687fe`
- `verify/run-checks.mjs` sha256 `3bb85f57ba505d700194783f8df80dfe45cf89c1ded0a9d8731d89c0ee1c651d`
- `verify/browser-version.mjs` sha256 `93685f1839f5036ea2e5cb25eab79fcb8c149026a1223d851a6f054d8a3dfd80`
- 机器结果：GREEN 41/41、Chrome 130/130、Edge 130/130；RED 32/41（同一脚本、同一 18 项新增用例，修复前源码）。

## 12. F1 元数据 span 修复（2026-10-26，对应 Chief review7）

review7 接受 review5 的三个架构反例修复，但用同一范围的合成输入指出系统版本来源仍可绕过：`VERSION_METADATA` 只剥特定拼写的数字子串，残留片段仍被 `parseVersion`/`versionLabel` 当作首个数字。两个 Linux 模板表现相同（各 5 项失败，合计 10 项）：

| 仅含元数据、无系统版本的合成输入 | 修复前误取 | 根因 |
|---|---|---|
| `Linux kernel=6.1` | `6.1` | 内核 span 只允许 `:`/`#`，`=` 未被识别，取值原样残留 |
| `Linux kernel release 5.14.0` | `5.14.0` | 内核 span 未覆盖 `release` 这类单词修饰 |
| `Linux 64 bit` | `64` | 位数规则只认 `<n>-bit` 连字符写法 |
| `Linux x86` | `86` | 架构规则只列 `x86_64`/`x64`，未覆盖裸 `x86` |
| `Linux kernel 5.14.0-427.13.1.el9` | `9` | 内核号只剥到 `5.14.0-427.13.1`，残留 `.el9` 中的 `9` |

### 12.1 修复

- 元数据改为**整体 span 剔除**：从 `kernel|build|内核|构建` 起，连同空白、`=`/`:`/`#` 分隔符、`release|version|ver|rev|no.|number|编号` 单词修饰，以及完整取值 token（`\d[\w.\-+~]*`，覆盖 `5.14.0-427.13.1.el9`）一次性移除，而不是只剥数字前缀。
- 架构规则补齐裸 `x86`、`x86_32`、`armhf`、`loongarch*` 等；位数规则同时覆盖 `64 bit`、`64bit`、`64位`。
- 剔除后仍取描述中第一个显式版本 token：`CentOS 7.9 kernel 5.14.0-427.13.1.el9` → `7.9`（不是 `9`）；`Ubuntu 22.04 kernel 6.5` → `22.04`；`Linux 6.1` → `6.1`；`Linux kernel 6.1` 没有系统版本 → 拒绝。
- `unknown|未知|未确认|待确认|n/a` 语义、展示原样写法、拒绝原因文案不变；不新增版本下界/支持矩阵，不删除已支持操作系统。检查、配置试采、页头试采、发布仍各自调用同一个 `compatResult`，没有第二套判定或放行旁路。

### 12.2 证据（合成输入，绑定本轮源码）

| 检查 | 修复前（RED） | 修复后（GREEN） |
|---|---|---|
| `verify/version-checks.mjs`（56 项） | 46/56 —— 10 项失败，恰为 5 个 review7 反例 × 2 个 Linux 模板 | **56/56** |
| `verify/run-checks.mjs` 完整检查，Chrome 156.0.8078.48 | — | **166/166** |
| 同一脚本，Microsoft Edge 156.0.4314.42（`Browser.getVersion` = `Edg/156.0.4314.42`） | — | **166/166** |

- RED 复现：`MAX241_APP_SRC=<修复前 app.js 副本> node verify/version-checks.mjs`，用例与判定逻辑不变；失败项为 `Linux kernel=6.1`、`Linux kernel release 5.14.0`、`Linux 64 bit`、`Linux x86`、`Linux kernel 5.14.0-427.13.1.el9` 各两个模板，渲染出的错误版本分别为 `6.1`/`5.14.0`/`64`/`86`/`9`，与 review7 报告一致；其余 46 项行为不变。
- 新增 GREEN 用例 15 项：上述 5 反例 × 2 模板，加 `CentOS 7.9 kernel 5.14.0-427.13.1.el9`（两个模板，断言版本为 `7.9`）、`Ubuntu 22.04 kernel 6.5`（断言 `22.04`）、`Linux 6.1`（断言 `6.1`）、`Linux kernel 6.1`（拒绝）。
- 浏览器新增 36 项（130 → 166）：
  - 5 个 review7 反例 × 3 档尺寸（1440×900 / 1366×768 / 1920×1080）：检查以 `role=alert` 拒绝并显示“系统版本不可确认/架构、内核、构建号不作为系统版本”，试采与发布禁用、检查按钮仍可聚焦、无整页横向溢出；页头试采同样不产生试采结果（15 + 15 项）。
  - `CentOS 7.9 kernel 5.14.0-427.13.1.el9` 三档尺寸：检查通过且文案为“系统版本 7.9 取自系统描述”，试采 3 项、发布进入“等待应用”（3 项）。
  - 合法检查后改为 `Linux kernel 5.14.0-427.13.1.el9`：配置试采、页头试采、发布三个入口各自独立拒绝（3 项）。
- 截图：`/Users/max/Coding/40-Slide/outputs/MAX-241-f1-review7-20261026/screenshots-chrome|screenshots-edge/`（`server-os-provenance-blocked-*`、`server-os-provenance-metadata-span-*`）；机器结果见同目录 `checks.json`、`version-checks-green.json`、`red/version-checks-red.json`。
- 浏览器身份：`browser-chrome.json`（`Chrome/156.0.8078.48`）、`browser-edge.json`（`Edg/156.0.4314.42`）。

### 12.3 复现

```bash
# 1) 原型服务（仓库根目录）
frontend/node_modules/.bin/vite --config docs/slide/development/MAX-241/prototype/vite.config.mjs
# 2) 判定函数（合成输入）+ RED 对照
node docs/slide/development/MAX-241/verify/version-checks.mjs
MAX241_APP_SRC=<修复前 app.js 副本> node docs/slide/development/MAX-241/verify/version-checks.mjs
# 3) 浏览器（Chrome / 实际 Edge）
node docs/slide/development/MAX-241/verify/run-checks.mjs http://127.0.0.1:8971/docs/slide/development/MAX-241/prototype <输出目录>
MAX241_BROWSER="/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" MAX241_CDP_PORT=9344 \
  node docs/slide/development/MAX-241/verify/run-checks.mjs http://127.0.0.1:8971/docs/slide/development/MAX-241/prototype <输出目录>
```

### 12.4 边界与绑定

- 合成系统描述只证明判定函数与原型呈现；**不代表真实服务器/采集验收**，未连接后端、真实资源或共享服务；生产系统版本字段来源与未知语义仍须实施阶段按真实契约验证。
- 本轮只改 `docs/slide/development/MAX-241/**`（原型、验证脚本与设计说明），生产 frontend/API/导航/共享组件只读；未发模型请求、未写 224 账本、未部署、无子代理；人工听读不设门禁。
- SHA 绑定见 §12.5。

### 12.5 SHA 绑定

- 修复与验证同属提交 `761f74d3d`（分支 `agent/15coder1/max-241`，起始 `f48f873355f1a23a23eb0aefb97faa6233fe5c9f` 保留，未 amend/rebase；本节为随后的文档追加，代码不变）。
- `prototype/app.js` sha256 `46740c79930c2f31e2ccf89be8029bb9033e616d51ffa14ac3425be12b0ca8ab`
- `verify/version-checks.mjs` sha256 `5825360ce3c0914858abc333c09907410375350b1ef96099fbcb79c69073b4e9`
- `verify/run-checks.mjs` sha256 `3ee1a42ccdf850d0257bce71d40dd1737e68249688fec96ce5ac049cbbb6c9bc`
- `verify/browser-version.mjs` sha256 `93685f1839f5036ea2e5cb25eab79fcb8c149026a1223d851a6f054d8a3dfd80`（本轮未改）
- 机器结果：GREEN 56/56、Chrome 166/166、Edge 166/166；RED 46/56（同一脚本、同一 15 项新增用例，修复前源码）。

## 13. F1 肯定式版本来源修复（2026-10-27，对应 Chief review9）

review9 接受 review7 的五个元数据 span 修复，但指出根因仍在：`VERSION_METADATA` 只是清洗黑名单，清洗后 `parseVersion`/`versionLabel` 仍无条件取剩余文本的首个数字。两个明确元数据输入在两个 Linux 模板上都被误判为系统版本并放行（独立 VM 64/68、Chrome 55/70、实际 Edge 55/70）：

| 仅含元数据、无系统版本的合成输入 | 修复前误取 | 根因 |
|---|---|---|
| `Linux build ID 19042` | `19042` | `build ID` 不在修饰词列举内，取值残留 |
| `Linux kernel: version 6.1` | `6.1` | 修饰词必须紧贴元数据词，`kernel: version` 的顺序不匹配 |

### 13.1 修复

- 改为**肯定式来源提取**（`systemVersion()`），不再依赖“清洗后取首数字”：
  1. 先按受支持的 OS 族标签（`SERVER_OS_FAMILIES`）定位锚点；
  2. 锚点之后按 token 顺序扫描：操作系统通名（`OS`/`Server`/`Enterprise`/`Linux`/`Core`/`SP` 等）与架构词可跳过；
  3. 遇到明确的版本 token（`v?7.9`、`V10`、`22.04.3`）即返回，`label` 保留原写法；
  4. 遇到内核/构建/ID/`release`/`version`/`revision`/编号等**元数据词**直接判为不可确认——后面的数字属于元数据，不继续扫描；
  5. 遇到其它未列举词、位数（`64 bit`/`64bit`/`64 位`）、`unknown`/未知，或没有受支持的 OS 族标签时同样不可确认。
- 因而不需要继续穷举失败词形：`Linux abc 6.1` 这类未列举词也会打断来源链；`Linux 6.1 build 20261026` 因版本在前仍取 `6.1`；`CentOS 7.9 kernel 5.14.0-427.13.1.el9` 取 `7.9`，`Kylin OS V10 SP3 kernel=4.19.90 (aarch64)` 取 `10`，`Ubuntu 22.04 build 20261026` 取 `22.04`，`Linux 6.1` 取 `6.1`；`Windows Server 2019` 仍按操作系统不符拒绝。
- 数据库/模板显式版本字段改用独立的 `parseVersion` 直接按字段值解析，不再与系统描述清洗逻辑耦合。
- 四个入口（检查、配置试采、页头试采、发布）仍各自调用同一 `compatResult`，无第二套判定或放行旁路；参数/模板变更使旧证据失效的行为不变；拒绝文案补充“需在操作系统名称后给出明确版本（如 CentOS 7.9）”。
- 不新增版本下界/支持矩阵，不删除已支持操作系统；`release`/`version` 等修饰词后的数字一律按元数据处理，无法证明来源时判为“不可确认”，由人工补充明确版本。

### 13.2 证据（合成输入，绑定本轮源码）

| 检查 | 修复前（RED，`c126f6c4c` 的 `app.js`） | 修复后（GREEN） |
|---|---|---|
| `verify/version-checks.mjs`（66 项） | 60/66 —— 6 项失败：两个 review9 反例 × 2 模板 + `Linux abc 6.1` × 2 模板 | **66/66** |
| `verify/run-checks.mjs` 完整检查，Chrome 156.0.8078.48 | — | **186/186** |
| 同一脚本，Microsoft Edge 156.0.4314.42（`Browser.getVersion` = `Edg/156.0.4314.42`） | — | **186/186** |

- RED 复现：`MAX241_APP_SRC=<c126f6c4c 的 app.js 副本> node verify/version-checks.mjs`，同一用例与判定逻辑；失败项渲染出的错误版本为 `19042`、`6.1`、`6.1`（各两个模板），与 review9 报告一致，其余 60 项行为不变。
- 新增 GREEN 用例 10 项：两个 review9 反例 × 2 模板、`Linux kernel version=6.1` × 2 模板（元数据修饰词变体）、`Linux abc 6.1` × 2 模板（来源链被打断）、`Linux 6.1 build 20261026` × 2 模板（版本在前，断言 `6.1`）。
- 浏览器新增 20 项（166 → 186），Chrome 与实际 Edge 结果一致：
  - `Linux build ID 19042`、`Linux kernel: version 6.1` × 三档尺寸（1440×900 / 1366×768 / 1920×1080）：检查以 `role=alert` 拒绝并显示“系统版本不可确认/架构、内核、构建号不作为系统版本”，试采与发布禁用、检查按钮仍可聚焦、无整页横向溢出；页头试采同样不产生试采结果（12 项）。
  - `Linux 6.1 build 20261026` 三档尺寸：检查通过且文案为“系统版本 6.1 取自系统描述”，试采 3 项、发布进入“等待应用”（3 项）。
  - `Linux abc 6.1`：来源链被打断时拒绝，不取后面任意数字（1 项）。
  - 合法检查后改为 `Linux kernel: version 6.1`：配置试采、页头试采、发布三个入口各自独立拒绝（3 项）。
  - 修改参数使旧证据失效，随后合法重查→试采→发布仍可推进（1 项）。
- 截图：`/Users/max/Coding/40-Slide/outputs/MAX-241-f1-review9-20261027/screenshots-chrome|screenshots-edge/`（`server-os-positive-source-*`）；机器结果见同目录 `checks.json`、`version-checks-green.json`、`red/version-checks-red.json`。
- 浏览器身份：`browser-chrome.json`（`Chrome/156.0.8078.48`）、`browser-edge.json`（`Edg/156.0.4314.42`）。
- 未变化的 F2/R1/R2/R3/R5 与旧 79/11 项检查沿用既有接受结论，未重跑旧证据。

### 13.3 复现

```bash
# 1) 原型服务（仓库根目录）
frontend/node_modules/.bin/vite --config docs/slide/development/MAX-241/prototype/vite.config.mjs
# 2) 判定函数（合成输入）+ RED 对照
node docs/slide/development/MAX-241/verify/version-checks.mjs
MAX241_APP_SRC=<修复前 app.js 副本> node docs/slide/development/MAX-241/verify/version-checks.mjs
# 3) 浏览器（Chrome / 实际 Edge）
node docs/slide/development/MAX-241/verify/run-checks.mjs http://127.0.0.1:8971/docs/slide/development/MAX-241/prototype <输出目录>
MAX241_BROWSER="/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" MAX241_CDP_PORT=9344 \
  node docs/slide/development/MAX-241/verify/run-checks.mjs http://127.0.0.1:8971/docs/slide/development/MAX-241/prototype <输出目录>
# 4) 浏览器身份
node docs/slide/development/MAX-241/verify/browser-version.mjs "<浏览器可执行文件>" 9356 <输出JSON>
```

### 13.4 边界与绑定

- 合成系统描述只证明判定函数与原型呈现；**不代表真实服务器/采集验收**，未连接后端、真实资源或共享服务；生产系统版本字段来源与未知语义仍须实施阶段按真实契约验证。
- 本轮只改 `docs/slide/development/MAX-241/**`（原型、验证脚本与设计说明），生产 frontend/API/导航/共享组件只读；未发模型请求、未写 224 账本、未部署、无子代理；人工听读不设门禁。
- SHA 绑定见 §13.5。

### 13.5 SHA 绑定

- 修复与验证同属提交（分支 `agent/15coder1/max-241`，起始 `c126f6c4cd43a479f3c55fe8078d9bfb07077815` 保留，未 amend/rebase；随后仅有文档绑定提交，代码不变）。
- `prototype/app.js` sha256 `6c210f60a874596cc322c8bb1320783fcc1388fe08addd50a8f91751d917f077`
- `verify/version-checks.mjs` sha256 `985497dd1974672f9ed0f3a035e4b1a97f2c5a2a70687774b6e793fb8e28f395`
- `verify/run-checks.mjs` sha256 `53f9b93deded0b72f778f5fad6ec49753dc4d9e1b46e221034bf62a0e5b3b6fc`
- `03-detail-design.md` sha256 `f7218447b8cc61443bdcd86fdfbdb4f15bad9c216363190fe97e048f2438d5e0`
- `prototype/README.md` sha256 `08fafc5ece582a9247d0b109a7a908d9e008a161dd01f85fc846fa7984fecd18`
- `verify/browser-version.mjs` sha256 `93685f1839f5036ea2e5cb25eab79fcb8c149026a1223d851a6f054d8a3dfd80`（本轮未改）
- 机器结果：GREEN 66/66、Chrome 186/186、Edge 186/186；RED 60/66（同一脚本、同一 10 项新增用例，修复前源码）。

## 14. F1 补丁/更新元数据边界修复（2026-10-27，对应 Chief review11）

review11 接受 review9 的肯定式来源修复，但指出同一来源判定仍有一个缺口：`VERSION_FILLER` 把 `update`/`service`/`pack`/`sp` 当作可跳过的操作系统通名，基础 OS 版本缺失时，其后的补丁/更新编号仍会被当成“明确版本”。两个 Linux 模板均误放行，四个入口（检查、配置试采、页头试采、发布）都受影响：

| 仅含补丁元数据、无基础版本的合成输入 | 修复前误取 | 根因 |
|---|---|---|
| `Linux update 20261026` | `20261026` | `update` 被当作可跳过通名，后续数字命中版本 token |
| `Linux service pack 3` | `3` | `service`/`pack` 同上 |
| `Linux SP 3` | `3` | `sp` 同上 |

### 14.1 修复

- 把 `update`/`patch`/`service`/`pack`/`sp` 从 `VERSION_FILLER`（可跳过通名）移入 `VERSION_METADATA_WORD`（元数据词）：基础版本缺失时，这些词一旦先出现就**停止扫描并判为不可确认**，不再取其后的数字。
- 按**同一 token 类别**收口，不针对字面值：`update`、`patch`、`service pack`（两个 token 均命中）、`SP`/`SP 3`/`Kylin OS V10 SP3` 的既有形式都走同一判定；未单独列举的 `SP3` 连写形式因不是合法版本 token 同样不可确认。
- 基础版本已有时，后续补丁/更新信息不会抹掉合法版本：扫描在第一个版本 token 处返回，`Linux 6.1 update 20261026`、`Linux 6.1 update20261026`、`Kylin OS V10 service pack 3` 分别取 `6.1`、`6.1`、`10`。
- 拒绝文案补充“补丁/更新编号不作为系统版本”，继续提示需在操作系统名称后给出明确版本；不新增支持矩阵、不删除已支持 OS、不写通用自然语言解析器。
- review9 记录中 `SP` 曾被列为可跳过的通名，本轮归入补丁元数据；行为以本节为准，历史记录保留。

### 14.2 证据（合成输入，绑定本轮源码）

| 检查 | 修复前（RED，`26378364d` 的 `app.js`） | 修复后（GREEN） |
|---|---|---|
| `verify/version-checks.mjs`（82 项） | 76/82 —— 6 项失败：`Linux update 20261026`、`Linux service pack 3`、`Linux SP 3` × 两个 Linux 模板 | **82/82** |
| `verify/run-checks.mjs` 完整检查，Chrome 156.0.8078.48 | — | **215/215**（其中 F1r11 新增 29 项全部通过） |
| 同一脚本，Microsoft Edge 156.0.4314.42（`Browser.getVersion` = `Edg/156.0.4314.42`） | — | **215/215**（F1r11 29/29） |

- RED 复现：`MAX241_APP_SRC=<26378364d 的 app.js 副本> node verify/version-checks.mjs`，同一用例与判定逻辑；失败项渲染出的版本为 `20261026`、`3`、`3`（各两个模板），与 review11 报告一致，其余 76 项行为不变。
- 新增 GREEN 用例 16 项（66 → 82）：三类补丁元数据 × 2 模板（6 项）、SP 连写与 patch 形式 × 2 模板（4 项）、`Linux 6.1 update 20261026`、`Linux 6.1 update20261026`、`Kylin OS V10 service pack 3` 各 × 2 模板（6 项，断言基础版本保留）。
- 浏览器新增 29 项（186 → 215），Chrome 与实际 Edge 结果一致：
  - `Linux update 20261026`、`Linux service pack 3`、`Linux SP3` × 三档尺寸（1440×900 / 1366×768 / 1920×1080）：检查以 `role=alert` 拒绝并显示“系统版本不可确认/补丁更新编号不作为系统版本”，试采与发布禁用、检查按钮仍可聚焦、无整页横向溢出；页头试采同样不产生试采结果（18 项）。
  - `Linux update 20261026`、`Linux service pack 3` × `linux-basic`/`linux-minimal` 两个模板：检查均拒绝（4 项）。
  - `Linux 6.1 update 20261026` 三档尺寸：检查通过且文案为“系统版本 6.1 取自系统描述”，试采 3 项、发布进入“等待应用”（3 项）；`Kylin OS V10 service pack 3` 检查通过并注明系统版本 10（1 项）。
  - 合法检查后改为 `Linux update 20261026`：配置试采、页头试采、发布三个入口各自独立拒绝（3 项）。
  - 既有 review5/review7/review9 反例、合法 CentOS 7.9 / Kylin V10 / Linux 6.1 / Ubuntu 22.04 / RHEL 9.4（含架构、完整 kernel/build）、Windows 负例、参数修改失效与合法重查均在同一轮回归通过，未重做已接受结论。
- 截图：`/Users/max/Coding/40-Slide/outputs/MAX-241-f1-review11-20261027/screenshots-chrome|screenshots-edge/`（`server-os-patch-metadata-*`）；机器结果见同目录 `checks-*.json`、`version-checks-green.json`、`version-checks-red.json`。
- 浏览器身份：`browser-chrome.json`（`Chrome/156.0.8078.48`）、`browser-edge.json`（`Edg/156.0.4314.42`）。
- F2/R1/R2/R3/R5 沿用既有接受证据，未重做；旧 79/11 未重跑。

### 14.3 复现

```bash
# 1) 原型服务（仓库根目录）
frontend/node_modules/.bin/vite --config docs/slide/development/MAX-241/prototype/vite.config.mjs
# 2) 判定函数（合成输入）+ RED 对照
node docs/slide/development/MAX-241/verify/version-checks.mjs
MAX241_APP_SRC=<修复前 app.js 副本> node docs/slide/development/MAX-241/verify/version-checks.mjs
# 3) 浏览器（Chrome / 实际 Edge）
node docs/slide/development/MAX-241/verify/run-checks.mjs http://127.0.0.1:8971/docs/slide/development/MAX-241/prototype <输出目录>
MAX241_BROWSER="/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" MAX241_CDP_PORT=9344 \
  node docs/slide/development/MAX-241/verify/run-checks.mjs http://127.0.0.1:8971/docs/slide/development/MAX-241/prototype <输出目录>
# 4) 浏览器身份
node docs/slide/development/MAX-241/verify/browser-version.mjs "<浏览器可执行文件>" 9356 <输出JSON>
```

### 14.4 边界与绑定

- 合成系统描述只证明判定函数与原型呈现；**不代表真实服务器/采集验收**，未连接后端、真实资源或共享服务；生产系统版本字段来源与未知语义仍须实施阶段按真实契约验证。
- 本轮只改 `docs/slide/development/MAX-241/**`（原型、验证脚本与设计说明），生产 frontend/API/导航/共享组件只读；未发模型请求、未写 224 账本、未部署、无子代理；人工听读不设门禁。
- SHA 绑定见 §14.5。

### 14.5 SHA 绑定

- 修复与验证同属提交 `358e57cb9`（分支 `agent/15coder1/max-241`，起始 `26378364d7420c4009de11e4ca9337630373b2ff` 保留，未 amend/rebase；本节为随后的文档追加，代码不变）。
- `prototype/app.js` sha256 `51d1638cc8f0a3160594654fa8fd1ed167ac5b18b109050cdc0aba5b4b29632a`
- `verify/version-checks.mjs` sha256 `540782412aea5a51b0893955bc8609ac69e039e0af370db00dbb48f6dc7b65fa`
- `verify/run-checks.mjs` sha256 `c285e0e21ee001966d859c34a4a5d151a00450ab8695ef67f198d41b120ec94b`
- `03-detail-design.md` sha256 `a88be7937cb39a8ba51435b1d1f7e669987d62d93a45eae66142428f44d87b6f`
- `prototype/README.md` sha256 `8c15e4a6cd9c08f5114148c3f103ea1e5066377735bcb9cdeab684fa2ff3e531`
- 机器结果：GREEN 82/82、Chrome 215/215、Edge 215/215；RED 76/82（同一脚本、同一批新增用例，修复前源码）。
