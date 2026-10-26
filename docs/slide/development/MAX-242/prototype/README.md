# MAX-242 原型说明与浏览器证据

本目录是**独立静态原型**，用于审阅统一 AI 工作空间的信息层级与交互，不是产品实现。

- 打开：`open index.html`（或任意静态服务器打开同目录）。
- 数据：全部为演示数据，页面顶部常驻“演示数据 · 未接真实后端 · 不调用模型 · 不执行任何运维动作”标识；故事数据带 `[样例]` 前缀。
- 无网络请求、无模型调用、无持久化；刷新即回到默认演示阶段。

## 覆盖内容

| 页面（hash） | 对应设计 | 关键点 |
|---|---|---|
| `#/home` | 首页发起区、需要你处理、继续调查 | 事件上下文带入；场景选择（0 必填自由文本）；处理项引用原调查/审批/执行记录 |
| `#/start` | 启动前上下文确认与能力检查 | 生成标题/目标、绝对时间 + 时区、来源、返回位置约定；数据/权限/模型/执行范围分别判断 |
| `#/detail` | 调查详情 | 一句话现状 + 三状态；当前判断（证据/反证/缺口/充分度）；一个优先下一步；真实进度；证据清单 |
| `#/supplement` | 结构化补充 | 已查值 + 来源；有/无/不清楚；数量 + “不清楚”；自由描述可选 |
| `#/action` | 行动草案、预检查、独立审批、显式执行 | 结果版本绑定；作者不能自批；改版失效；未知回执不重发 |
| `#/verify` | 三类复测结论 | 观察窗口、前后观测、副作用；恢复/未改善/证据不足；追加记录 |
| `#/handoff` | 交接摘要 | 从记录生成（不调用模型）；缺口与敏感信息人工确认 |
| `#/exceptions` | 异常与边界分支 | 11 类分支矩阵 + 四个可现场试用的状态 |
| `#/compat` | 旧入口兼容 | 13 个旧入口与深链接约束 |

侧栏可切换“演示进度”（结果 V1 → V2 → 待审批 → 已执行 → 三类复测）与“演示角色”（处理人 / 审批人 / 只读），便于直接审阅任一阶段。

## 与前端规范的关系

- 已阅读根 `AGENTS.md` 与 `frontend/AGENTS.md`。
- 为保持原型独立可打开、不引入生产构建，本原型使用与 `frontend/src/app/styles/tokens.css` 同名、同值的 CSS token，未直接 import Lit 共享组件；这是原型侧的有意取舍，**不代表生产实现可以绕过 `app-card`、`app-dialog`、`app-badge`、`app-form-field`、`btn-primary/btn` 等共享组件**。
- 实现阶段必须复用共享组件与主题 token，并按 `frontend/AGENTS.md` 校验 Boolean property binding、焦点、键盘与错误状态。
- 原型不修改任何生产文件；`git diff` 仅新增 `docs/slide/development/MAX-242/**`。

## 浏览器验证

环境：macOS + Google Chrome（headless=`--headless=new`），本地 `file://` 加载；2026-10-26。

```bash
node verify-prototype.mjs
```

脚本通过 CDP 驱动真实 Chrome，走完主故事：首页 → 启动确认 → 只读排查进度 → 结构化补充（“不清楚”分支）→ 结果版本 → 行动草案 → 提交审批 → 切换审批人批准 → 显式执行 → 复测恢复 → 未改善分支 → 未知提交/核对 → 断线/重连 → 交接 → 旧入口兼容。

结果：**28/28 通过**，浏览器控制台无错误。检查项只验证原型交互与文案，不验证产品后端、权限或真实恢复。

截图（1440×900 主验；1366×768、1920×1080 关键页检查）：

| 文件 | 内容 |
|---|---|
| `browser-evidence/01-home-1440.png` | 首页：发起区、需要你处理、继续调查 |
| `browser-evidence/02-start-1440.png` | 从事件进入的启动确认与四项能力检查 |
| `browser-evidence/03-detail-1440.png` | 调查详情（V2）：三状态、当前判断、证据/反证/缺口、下一步 |
| `browser-evidence/04-supplement-1440.png` | 结构化补充（含“不清楚”） |
| `browser-evidence/05-action-1440.png` | 行动草案与预检查（处理人视角） |
| `browser-evidence/06-verify-after-execution-1440.png` | 复测：报告通过，待人工确认结论 |
| `browser-evidence/07-verify-not-improved-1440.png` | 复测：未改善，可回同一调查继续 |
| `browser-evidence/07b-verify-insufficient-1440.png` | 复测：证据不足（采样缺失） |
| `browser-evidence/08-handoff-1440.png` | 交接摘要与分享前确认 |
| `browser-evidence/09-exceptions-1440.png` | 异常分支矩阵 |
| `browser-evidence/10-compat-1440.png` | 旧入口兼容表 |
| `browser-evidence/11-action-approver-1440.png` | 审批人视角：批准/驳回 |
| `browser-evidence/12-home-1366.png` | 1366×768 首页 |
| `browser-evidence/13-detail-1366.png` | 1366×768 详情 |
| `browser-evidence/14-home-1920.png` | 1920×1080 首页 |

## 明确限制

- 不接真实采集、权限、审批、执行或通知；所有状态是本页内存中的演示。
- 不验证真实恢复；复测页面只展示“应如何呈现三类结论”，不是业务通过证据。
- 不覆盖移动/平板、暗色、完整无障碍合规；保留基础标签、键盘可达与焦点样式。
- 原型中的“预算/冷却/去重”只是文案说明，未运行真实准入策略。

真实闭环验收需要 MAX-238/239/240 的 P1 证据与真实环境，见上层 [acceptance-matrix.md](../acceptance-matrix.md)。
