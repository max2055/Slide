# 前端开发规则

本文件适用于 `frontend/`，以及其他目录中复用这些组件的产品原型。根目录 [AGENTS.md](../AGENTS.md) 的范围、授权和验证规则继续适用。

## 设计与交付标准

- 新增复杂页面或调整主要布局前，先明确页面服务的用户目标、首屏关键信息、主要操作、信息分组、按需查看的详情及必要状态，并选定现有页面、设计稿或交互原型作为可核对的设计依据。简单文案、菜单或既有组件的小幅调整可沿用现有设计直接实施和验证，无需另建原型或增加批准环节。
- 按用户任务组织页面，不按接口字段顺序平铺。使用可读文案和单位；原始标识、完整摘要、原始数据等技术细节放在详情中；长列表使用适合现有数据能力的检索、筛选、分页或受控滚动。保持未知、部分完成、冲突和权限限制的真实含义。
- 有已确认原型时，将对应版本、设计说明、截图和交互验收要求写入任务，供开发及审查环境访问。复用原型使用的共享组件、主题 token 和可用布局代码，接入真实数据时保持信息层级、文案、操作位置和核心交互。真实内容长度和数量变化可适配，实质设计偏离需说明并讨论；已确认方案和范围内常规集成不重复索取批准。
- 同批多个页面改造时，先将一个代表页面接入真实数据并完成设计对照，再推广到其余页面；发现偏差先修正，避免批量复制粗糙布局。
- 开发任务的完成条件同时包括功能、视觉和真实业务验收。接口可用、组件复用、单测或构建通过均不能单独证明 UI 已完成；必要证据缺失或存在实质设计偏差时，明确标为未完成。

## 共享组件优先

新增 UI 前先检查已有组件。没有适用组件时，第一次可局部实现；第二次出现同类模式时复用或提取共享组件，避免复制样式。不要为遵循本规则重写未触达的旧界面。

| 元素 | 优先使用 | 实现位置 |
|---|---|---|
| Primary / 次要 / Ghost 按钮 | `btn-primary` / `btn` / `btn-ghost` | [shared-btn-styles.ts](src/app/styles/shared-btn-styles.ts) |
| 卡片 | `<app-card>` | [app-card.ts](src/app/ui/components/app-card.ts) |
| 弹窗 | `<app-dialog>` | [app-dialog.ts](src/app/ui/components/app-dialog.ts) |
| 表单字段 | `<app-form-field>` | [app-form-field.ts](src/app/ui/components/app-form-field.ts) |
| 数据表格 | `<app-data-table>` | [app-data-table.ts](src/app/ui/components/app-data-table.ts) |
| 空状态 | `<app-empty-state>` | [app-empty-state.ts](src/app/ui/components/app-empty-state.ts) |
| 徽章 / 标签 | `<app-badge>` | [app-badge.ts](src/app/ui/components/app-badge.ts) |
| 通知 | `showToast()` | [app-toast-container.ts](src/app/ui/components/app-toast-container.ts) |
| 统计卡片 | `<stat-card>` | [stat-card.ts](src/components/stat-card.ts) |
| 表格加载态 | `.skeleton` | 复用现有骨架样式 |

消费组件时不另造同类 `.card`、`.modal-overlay`、`.badge`、toast 或按钮样式；不用 `alert()` 作为产品通知。共享组件确实缺少所需能力时，先评估最小扩展；专用实现须说明原因，不为一次性需求创建通用框架。

按钮按场景统一：页面/列表刷新使用 `btn btn-refresh`（共享单向环形箭头＋文字，无底色、无边框；颜色复用轻量操作配色）；创建/保存使用 `btn-primary`；行内操作使用 `btn-sm` / `btn-ghost`，删除保留 danger 语义；局部图标操作提供可访问名称。普通 DOM 与 Shadow DOM 共用 `shared-btn-styles.css`，页面不得重复定义通用 `.btn` 配色/尺寸。尺寸、字号、圆角与颜色消费现有外观 token；同场景一致，不要求聊天图标与页面工具栏相同。规范与验收范围见 [主要控件规范](../docs/slide/development/MAX-186/visual-controls-2026-10-16.md)。

## 样式与 Lit

- 使用主题 token：颜色 `--accent`、`--text`、`--text-strong`、`--muted`、`--border`；圆角 `--radius-sm/md/lg`；间距 `--space-xs` 至 `--space-xl`。业务组件不硬编码同类颜色、圆角和间距。
- 默认浅色主色为蓝色，具体值由 [tokens.css](src/app/styles/tokens.css) 及外观配置决定；深色和用户主题可以改变值，不把 `--accent` 固定为某个色值，也不自行切成紫色品牌。
- 保持组件现有 DOM 封装。`app-card`、`app-dialog` 等使用 Shadow DOM；`app-badge`、`app-data-table`、`app-empty-state` 使用 Light DOM，不为统一形式迁移现有组件。
- Shadow DOM 组件沿用已有样式机制（如 render 内 `<style>` 或 `static styles`）。Light DOM 组件不能依赖 Lit 的 `static styles` 自动应用；视图子组件按现有模式在 render 开头注入 `<style>`，选择器限定组件范围。
- 自定义组件 Boolean property 用 `.open=${value}` 等 property binding；布尔 attribute 用 `?disabled=${value}` 等 boolean attribute binding。不要用 `open=${false}` 生成字符串属性；原生 `disabled` 也可通过 `.disabled` 绑定 DOM property。
- 表单字段需提供可访问名称；保留弹窗焦点管理、键盘操作与关闭后焦点恢复。检查实际语义，不仅检查属性是否有 `.` 前缀。

## 验证

按改动检查组件复用、主题兼容、响应式、Boolean 语义、空/加载/失败状态及键盘交互。运行相关单测和浏览器检查；功能原型需标明演示数据及未接入能力，不能把原型交互通过当作业务后端验收。

新增复杂页面或主要布局改造还需逐页提供真实实现与设计依据的截图对照，核对信息层级、间距、字体、文案、操作位置、表格/分页/详情行为。记录当前代码版本、视口、主题和数据情景，覆盖桌面、窄屏、明暗主题及适用的正常、空、加载、失败、权限受限、未知/部分完成/冲突状态。正常业务流使用真实服务验收；特殊状态可用受控测试数据补充并标注来源。检查长文本、页面溢出、弹窗键盘关闭与焦点恢复，先修复实质偏差再交付。
