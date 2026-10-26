# 原型浏览器验证记录（设计修复 R1–R6）

日期：2026-10-26｜验证提交：任务分支 `d2f653a5d`（发布分支为同内容的设计专用提交，见 PR）｜对象：[prototype/](prototype/) 独立原型（演示数据，不连后端）。生产详情页未修改。

## 1. 环境

| 项 | 值 |
|---|---|
| 系统 | macOS 27.0.1（Darwin 27.0.0），Apple Silicon |
| 浏览器 | Google Chrome 155.0.8059.85（headless new） |
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

## 3. 完整检查：79/79 通过

机器可读结果：`/Users/max/Coding/40-Slide/outputs/MAX-241-2026-10-26/repair/checks.json`。

| 分组 | 检查 | 结果 |
|---|---|---|
| 共享组件（R5） | `app-card` / `app-badge` / `app-data-table` 正在使用；无 `.card/.badge/.dialog` 重复类；内容区按钮使用共享按钮契约 | 通过（5/5） |
| 列表 × 3 类 | 业务列恰好八列且名称符合 Issue；行内四操作完整；无整页横向溢出；`role=region` 局部横滚容器 | 通过（15/15） |
| 详情 × 3 类 | 页签集合与顺序（13/10/6）；保留关联调查/事件/审计联动行 | 通过（6/6） |
| 键盘 | `→` 切页签且焦点跟随；页签可见焦点环 | 通过（2/2） |
| 弹窗 | `app-dialog` 打开后焦点进入；`Esc` 关闭并返回触发按钮 | 通过（2/2） |
| 状态 | 无数据 / 加载中 / 加载失败 / 部分失败 / 页面 403 / 模块 403 明确呈现 | 通过（8/8） |
| 权限 | 只读禁用写操作；监控配置只读且有原因；数据库 `manage≠update/delete`；网络备份读/写分离 | 通过（7/7） |
| 反例（GREEN） | 选中行身份 ×3、页面 403 ×3、可编辑配置 ×3、非数据库模板流程 ×2 | 通过（11/11） |
| 配置流程 | 参数修改更新最终值并重置流程；检查→试采→发布→应用→等待正式样本；绑定随资源变化 | 通过（7/7） |
| 上下文 | 指标页使用所选资源 id；返回恢复筛选/横滚/焦点；旧深链接可用 | 通过（4/4） |
| 三档宽度 | 1440/1366/1920 列表与关键详情无整页溢出、主操作可达（含容器内滚动后） | 通过（12/12） |
| 长名称 / 窄窗口 | 1366×768 长名换行不溢出；1100×800 降级为表格内横滚 | 通过（2/2） |

## 4. 反例 RED → GREEN（11/11）

同一组断言分别运行在修复前原型（`d53fbc20c`，RED）与本轮原型（GREEN）：

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

RED 产物：`.../repair/red-old/counterexamples-old.json`（0/11）；GREEN 产物：`.../repair/green-new/counterexamples-new.json`（11/11）。

## 5. 权限与状态证据（原型级）

- 页面 403 不渲染资源身份；模块 403 保留身份、仅当前页签无权限。
- 只读：编辑/测试/删除禁用；监控配置显示“只读：缺少 …:manage”。
- 数据库 `manager` 预设：`instance:manage` 不含 `update/delete` → 编辑/删除禁用，监控配置仍可编辑（与 06 §1 一致）。
- 网络设备 `manager`：备份写禁用（原因 `network_devices:backup`）、备份列表仍可读；`backup` 预设下保存定时可用。
- 配置流程不伪造：试采“不写正式历史”，发布后“等待应用”，应用后“等待首个正式样本，不代表已健康”；P1 前不显示触发器数量。

## 6. 截图索引（`.../repair/screenshots/`，44 张）

| 文件 | 用途 |
|---|---|
| `db-list-1440x900.png` / `server-list-1440x900.png` / `network-list-1440x900.png` | 三类列表八列 + 四操作 + 局部横滚 |
| `db-list-1366x768.png` / `db-list-1920x1080.png` / `db-list-narrow-1100x800.png` | 三档与窄窗降级 |
| `db-detail-overview-1440x900.png` / `server-detail-overview-1440x900.png` / `network-detail-overview-1440x900.png` | 详情共享框架 |
| `db-detail-collection-full-1440x900.png` | 监控配置：绑定、有效参数、四步、触发器未接入、覆盖、事件 |
| `db-config-edited-flow-1440x900.png` | 参数修改后的检查/试采/发布/应用状态 |
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
