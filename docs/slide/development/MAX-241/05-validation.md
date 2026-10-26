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
