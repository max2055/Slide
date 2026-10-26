# MAX-241 三类完整资源详情：设计前置交付

日期：2026-10-26｜状态：设计前置完成，待 Chief 审阅；生产详情页未修改

本目录对应 GitHub Issue #265 / Multica MAX-241 的**设计前置**门槛：先盘点当前 Slide 三类资源完整详情的真实能力，产出“保留 / 优化 / 新增”差异表、三类完整详情原型与回归清单，再进入生产 UI 实施。本目录不声称整单完成，也不代表任何拟建能力已在生产可用。

## 盘点基线

| 项 | 值 |
|---|---|
| 盘点代码基线 | 本任务工作树 HEAD `9979d1b0c3fa22748eb6e7d6a1e51d44b029dcbe`（`agent/15coder1/max-241`） |
| 生产路由/组件 | 只读查阅，未修改 `frontend/` 下任何文件 |
| 方案基线 | `docs/superpowers/specs/2026-10-22-monitoring-operations-optimization-design.md` @ `5cb26fef`（§4 / §4.3 / §7、A12 / A15） |
| 原型基线 | `outputs/monitoring-redesign-20261022/` @ `5cb26fef`（V4 简化 `resource-detail` 弹窗仅入口占位） |
| 范围内文件 | `docs/slide/development/MAX-241/**` |
| 未触及 | 生产详情/导航/共享组件、`investigations`/`governance` 共享文件、MAX-228/PR #354 相关改动 |

## 交付物

| 文件 | 内容 |
|---|---|
| [01-inventory.md](01-inventory.md) | 数据库 / 服务器 / 网络设备完整详情逐类盘点：页面与页签、专业模块、数据来源、按钮、权限、深链接；含列表页盘点 |
| [02-diff-table.md](02-diff-table.md) | “保留 / 优化 / 新增”逐项差异表、设计决策与待 Chief 确认的开放项 |
| [03-detail-design.md](03-detail-design.md) | 三类完整详情设计：共享框架、各类专业内容、入口语义、状态设计、键盘/焦点、响应式 |
| [04-regression-checklist.md](04-regression-checklist.md) | 现有功能回归清单（按类、按页签、按操作、按深链接） |
| [prototype/](prototype/) | 可点击独立原型（三类详情 + 列表导航 + 六种状态 + 三档宽度），演示数据，不连后端 |
| [05-validation.md](05-validation.md) | 原型浏览器验证记录：1440×900 / 1366×768 / 1920×1080、键盘与焦点、空/错/无权限、长名、分页 |

## 边界声明

- 原型复用 Slide 现有设计语言（tokens、共享按钮契约、卡片/徽章/空状态外观），但**不是**生产组件：图形、演示数据、跳转均为本地样例，刷新重置。
- 原型通过 ≠ 业务验收。真实采集、权限、通知、历史与跳转必须按原 Issue 验收项在实施阶段用真实环境重新验证。
- “有效触发器 / 事件 / 操作审计 / 多模板绑定”等依赖 P1 及 #260 契约的能力，本文一律标注**拟建**，不写成现状。
- 详情页生产实施等待两项放行：Chief 审阅本设计前置；相关 P1 数据能力可用。
