# MAX-241 三类完整资源详情：设计前置交付

日期：2026-10-26｜状态：设计修复 R1–R6 与复审 F1/F2 已提交，待 Chief 复审；生产详情页未修改，整单未完成

本目录对应 GitHub Issue #265 / Multica MAX-241 的**设计前置**门槛：先盘点当前 Slide 三类资源完整详情的真实能力，产出“保留 / 优化 / 新增”差异表、三类完整详情原型与回归清单，再进入生产 UI 实施。本目录不声称整单完成，也不代表任何拟建能力已在生产可用。

## 基线

| 项 | 值 |
|---|---|
| 生产事实基线 | 已验证 main `e11f6ba2`；权限相关文件与工作树逐字节一致 |
| 工作树 | 本任务分支 `agent/15coder1/max-241`，起始提交 `d53fbc20c` |
| 生产路由/组件 | 只读查阅，未修改 `frontend/`、`apps/db-ops-api/` 任何文件 |
| 方案基线 | `docs/superpowers/specs/2026-10-22-monitoring-operations-optimization-design.md` @ `5cb26fef`（§4 / §4.3 / §7、A12 / A15） |
| 原型基线 | `outputs/monitoring-redesign-20261022/` @ `5cb26fef`（V4 简化 `resource-detail` 弹窗仅入口占位） |
| 范围内文件 | `docs/slide/development/MAX-241/**`（本轮设计修复不再引入基线文件，发布分支只含本目录） |
| 未触及 | 生产详情/导航/共享组件、`investigations`/`governance` 共享文件、MAX-228/PR #354 相关改动 |

## 交付物

| 文件 | 内容 |
|---|---|
| [01-inventory.md](01-inventory.md) | 三类详情逐项盘点：页签、专业模块、接口、按钮、权限、深链接；含列表八列/四操作与前后端权限差异 |
| [02-diff-table.md](02-diff-table.md) | 保留 / 优化 / 新增差异表；D-05 与 O-01～O-03 的 Chief 决定；权限、身份、403 设计项 |
| [03-detail-design.md](03-detail-design.md) | 共享框架、选中身份、页面/模块 403、监控配置可编辑四步、备份读写分离、返回恢复 |
| [04-regression-checklist.md](04-regression-checklist.md) | 回归清单 R-01～R-104（新增身份/403/配置/备份/返回/共享组件项） |
| [05-validation.md](05-validation.md) | 浏览器检查 103/103（Chrome 与 Edge）、20 项 RED→GREEN 反例、版本/子类型合成输入 23/23（review4 增补未知版本）、截图索引、限制 |
| [06-permission-gates.md](06-permission-gates.md) | 每个专业动作的前端门控 / 服务端权限 / 资源范围；已知不一致清单 |
| [prototype/](prototype/) | 可点击独立原型：只读复用生产共享组件，支持 id/权限预设/模块 403/可编辑配置 |

## 已修复的审阅项（R1–R6）

- **R1**：发布分支只含 `docs/slide/development/MAX-241/**`，不再带入 229 个基线文件（见交付评论中的实际 PR diff）。
- **R2**：列表“详情”按行 id 绑定身份、配置、指标来源与联动；返回恢复筛选、横向位置和焦点。
- **R3**：页面 403 清空名称/地址/健康/联动/页签/操作；新增模块 403；权限按实际接口码分层（view / update / delete / manage / backup）；新增权限盘点并更正“四操作均 manage”和 R-33→R-22。
- **R4**：监控配置可编辑，三类模板/参数/兼容性/试采/发布均按资源类型渲染；兼容性按资源引擎族拒绝不兼容模板并阻止试采/发布，页头“试采”不绕过前置检查；试采表逐项显示成功/部分失败（含错误码）/待验证/未覆盖；四步流程与“等待正式采集”不伪造成功。
- **R5**：原型只读复用 `app-card` / `app-dialog` / `app-badge` / `app-empty-state` / `app-data-table` / `app-form-field` / `showToast` 与共享样式，删除重复的 card/badge/dialog/button/toast 样式。
- **R6**：上一轮完整检查 88/88；20 项反例（11 项早期 + 9 项配置兼容/试采）在修复前 79/88（RED）、修复后 88/88（GREEN）；三档宽度、键盘、状态、长名称、权限负例均有截图。
- **F1（review3）**：兼容性判定补齐版本范围与设备子类型——模板声明引擎族/类别/平台/版本范围，资源按 `dbType`/`os`/`vendor`+型号解析；未知或未覆盖一律拒绝；检查、页头试采、发布共用同一判定。修复前 `fw-edge-01`（Huawei V600 防火墙）选 Huawei VRP V200 交换机模板可试采并发布，修复后被拒绝。
- **F1（review4）**：Linux 模板补 `requireVersion`——已知 Linux 族但版本不可确认（`CentOS unknown`、仅系统名、`Kylin OS` 无版本）不再宣称兼容；无 `min` 区间时不虚构下界。`version-checks` 由 20/23（RED）到 23/23（GREEN），完整浏览器检查 Chrome / Edge 均 103/103。
- **F2（review3）**：试采证据绑定资源/模板版本/配置版本/时间/来源；无历史显示“未试采”，失败的检查不再凭空生成“最近一次试采”；修改后保留的失效快照仅作参考、不能发布。完整检查 103/103（Chrome 与 Edge），版本合成输入 20/20（review4 后 23/23）。

## 边界声明

- 原型通过 ≠ 业务验收。真实采集、权限、通知、历史与跳转必须按原 Issue 验收项在实施阶段用真实环境重新验证。
- “有效触发器 / 事件 / 操作审计 / 多模板绑定”等依赖 P1 及 #260 契约的能力，一律标注**拟建**；P1 前不显示触发器数量。
- 详情页生产实施等待两项放行：Chief 复审本设计修复；相关 P1 数据能力可用。
- 本轮**未**修改生产代码、未重启共享服务、未发送模型请求、未写 224 台账、未操作真实资源。
