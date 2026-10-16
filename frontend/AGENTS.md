# 前端开发规则

本文件适用于 `frontend/`，以及其他目录中复用这些组件的产品原型。根目录 [AGENTS.md](../AGENTS.md) 的范围、授权和验证规则继续适用。

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

按钮按场景统一：页面/列表刷新使用 `btn btn-refresh`（共享图标＋文字次要按钮）；创建/保存使用 `btn-primary`；行内操作使用 `btn-sm` / `btn-ghost`，删除保留 danger 语义；局部图标操作提供可访问名称。普通 DOM 与 Shadow DOM 共用 `shared-btn-styles.css`，页面不得重复定义通用 `.btn` 配色/尺寸。尺寸、字号、圆角与颜色消费现有外观 token；同场景一致，不要求聊天图标与页面工具栏相同。规范与验收范围见 [主要控件规范](../docs/slide/development/MAX-186/visual-controls-2026-10-16.md)。

## 样式与 Lit

- 使用主题 token：颜色 `--accent`、`--text`、`--text-strong`、`--muted`、`--border`；圆角 `--radius-sm/md/lg`；间距 `--space-xs` 至 `--space-xl`。业务组件不硬编码同类颜色、圆角和间距。
- 默认浅色主色为蓝色，具体值由 [tokens.css](src/app/styles/tokens.css) 及外观配置决定；深色和用户主题可以改变值，不把 `--accent` 固定为某个色值，也不自行切成紫色品牌。
- 保持组件现有 DOM 封装。`app-card`、`app-dialog` 等使用 Shadow DOM；`app-badge`、`app-data-table`、`app-empty-state` 使用 Light DOM，不为统一形式迁移现有组件。
- Shadow DOM 组件沿用已有样式机制（如 render 内 `<style>` 或 `static styles`）。Light DOM 组件不能依赖 Lit 的 `static styles` 自动应用；视图子组件按现有模式在 render 开头注入 `<style>`，选择器限定组件范围。
- 自定义组件 Boolean property 用 `.open=${value}` 等 property binding；布尔 attribute 用 `?disabled=${value}` 等 boolean attribute binding。不要用 `open=${false}` 生成字符串属性；原生 `disabled` 也可通过 `.disabled` 绑定 DOM property。
- 表单字段需提供可访问名称；保留弹窗焦点管理、键盘操作与关闭后焦点恢复。检查实际语义，不仅检查属性是否有 `.` 前缀。

## 验证

按改动检查组件复用、主题兼容、响应式、Boolean 语义、空/加载/失败状态及键盘交互。运行相关单测和浏览器检查；功能原型需标明演示数据及未接入能力，不能把原型交互通过当作业务后端验收。
