# Phase 120: UI 问题清单

> **来源**: `/redesign-existing-projects` Scan → Diagnose 全站审计
> **日期**: 2026-06-17
> **扫描范围**: `frontend/src/` — 16 CSS 文件, 29 Lit 组件, ~45,000 行前端代码
> **方法论**: Taste Skill Redesign Skill — 10 大类审计，按 Fix Priority 排序

---

## 统计概览

| 维度 | 发现数 | CRITICAL | HIGH | MEDIUM | LOW |
|------|--------|----------|------|--------|-----|
| CSS 架构 | 10 | 2 | 2 | 4 | 2 |
| 组件模式 | 25 | 0 | 6 | 14 | 5 |
| 交互状态 | 40+ | 0 | 2 | 15 | 23+ |
| 代码质量 | 20 | 0 | 4 | 10 | 6 |
| **合计** | **~95** | **2** | **14** | **43** | **36** |

---

## 🔴 CRITICAL — 立即修复

### C1. 双 CSS 令牌系统冲突

**文件**: `src/styles/global.css` vs `src/app/styles/base.css`
**症状**: `main.ts` 同时加载两套 CSS，都定义了 `:root` 级别的 `--accent`、`--ring`、`--primary`、`--bg-hover` 等相同变量但**值不同**

| Token | global.css (旧) | base.css (新，最终生效) |
|-------|----------------|----------------------|
| `--accent` | `#409eff` (蓝色) | `#7c5cff` (紫色) |
| `--accent-hover` | `#66b1ff` | `#9b82ff` |
| `--accent-subtle` | `rgba(64,158,255,0.08)` | `rgba(124,92,255,0.12)` |
| `--bg-hover` | `#e6e8eb` | `#eceef0` |
| `--ring` | `#409eff` | `#7c5cff` |

**影响**: 
- 旧的 `global.css` (350行) + `components.css` (663行) = **1013 行死代码**，每次页面加载都会先解析再被覆盖
- 任何未来修改如果改变加载顺序，整套 UI 颜色会突变
- 旧 `components.css` 的 `.app-layout`、`.btn`、`.card`、`.table` 等类与新系统类名冲突

**修复方向**: 删除 `main.ts` 中 `import './styles/global.css'`，合并 `global.css` 中有用但 `base.css` 缺失的 token（如 `--accent-glow`、`--shadow-glow`、`--focus-glow`）到 `base.css`

### C2. Chat CSS 双重加载

**文件**: `src/app/styles.css` → `styles/components.css` → `chat.css` (路径 A) + `src/app/styles.css` → `chat.css` (路径 B)
**影响**: 所有 chat CSS 规则被解析和应用两次

**修复方向**: 删除 `styles/components.css` 中的 `@import "./chat.css"`，只保留 `styles.css` 中的直接 import

---

## 🟠 HIGH — 本 Phase 修复

### 组件标准化

#### H1. 两套对话框系统并存

| 系统 | 类名 | 动画 | 关闭检测 | 使用文件 |
|------|------|------|---------|---------|
| Dialog | `.dialog-overlay` / `.dialog` | `slide-up` (Y=20px→0, 0.2s) | `e.target === e.currentTarget` | instances-db, cron-jobs-settings, metric-registry, metric-templates |
| Modal | `.modal-overlay` / `.modal` | `modal-slide-in` (Y=-20px→0, 0.25s) | `contains("modal-overlay")` | users-management, rbac-page, sql-console, alerts, approval-dashboard, instance-detail |

**具体不一致**:
- 动画方向相反（Dialog 从下往上，Modal 从上往下）
- 标题字体: `.dialog-title` 用 `var(--text-lg)`，`.modal-title` 用硬编码 `15px`
- 关闭按钮: `.dialog-close` 固定 32x32px，`.modal-close` 无固定尺寸
- 宽度: 400px / 480px / 520px / 600px / 640px / 720px 无规律

**修复方向**: 创建共享 `<slide-dialog>` Lit 组件，统一动画、关闭行为、尺寸档位（sm/md/lg/xl）

#### H2. 无共享表单组件

3 种互不兼容的表单模式：

| 视图 | 标签大小 | 标签变换 | 标签颜色 | 布局方式 |
|------|---------|---------|---------|---------|
| instances-db | `var(--text-base)` | 无 | `var(--text)` | `display:block` + `margin-bottom` |
| users-management | `12px` | `uppercase` | `var(--muted)` | `display:grid; gap:6px` |
| rbac-page | `var(--text-sm)` | `uppercase` | `var(--muted)` | `display:grid; gap:var(--space-sm)` |

登录表单还用了第三种 `.field` 命名（login-gate.ts），LLM 配置表单是第四种变体（`.form-section-title` + `.form-row`）。

**修复方向**: 创建共享 `<form-field>` 组件（label + input/select/textarea + hint + error），统一标签风格

#### H3. 无共享卡片组件——每个视图自己造

| 文件 | 圆角 | 内边距 |
|------|------|--------|
| alerts.ts `.card` | `var(--radius-lg)` | `var(--space-md) var(--space-lg)` |
| ai-settings.ts `.card` | `var(--radius)` | `20px`（body 内边距） |
| approval-dashboard.ts `.card` | `var(--radius-md)` | `var(--space-lg)` |
| dashboard.ts `.status-card` | `var(--radius-md)` | `18px` |

Card header 命名不统一：`.card-header` / `.status-card__header` / 无 header。

**修复方向**: 已有 `stat-card.ts` 组件，扩展为通用 `<slide-card>` 组件，支持 header/body/footer 插槽

#### H4. "添加实例" Dialog 等问题界面

**文件**: `frontend/src/app/ui/views/instances-db.ts` (1088-1242 行)
**问题**:
- 所有样式内联在 Lit `static styles` 中，与其他 dialog 无共享
- 表单使用 `display:block` + `margin-bottom` 布局，较简陋
- 无表单校验错误展示
- `.form-hint` 只在全宽字段出现，并排字段缺少说明

类似的独立 dialog 实现还存在 `cron-jobs-settings.ts`、`metric-registry.ts`、`metric-templates.ts` 等文件中。

#### H5. Cron Jobs 使用 div 模拟表格

**文件**: `cron-jobs-settings.ts` (479-514 行)
使用 `display:grid` 的 `<div>` 模拟表格，而全站其他 12+ 视图使用标准的 `<table.table>` 模式。视觉不一致。

**修复方向**: 统一为标准 `<table>` 或创建共享 `<data-table>` 组件

#### H6. 无全局 Toast/通知系统

每个组件自己实现通知：

| 组件 | 实现 | 位置 |
|------|------|------|
| cron-jobs-settings | 自建 toast（success/error，3s 消失） | 右下角固定 |
| metric-templates | `toast-ok` / `toast-err` CSS 类 | 列表上方 |
| chat | COMPACTION_TOAST_DURATION_MS 常量 | 聊天区 |

大多数视图（users-management、rbac-page、instances-db、schema-management 等）操作成功/失败后**完全无反馈**。

**修复方向**: 创建全局 `<toast-container>` + `showToast()` 工具函数

### CSS 架构

#### H7. ~2000 个硬编码 px 值

设计令牌已定义但未被使用：

| 令牌 | 定义 | 应替换的硬编码模式 |
|------|------|------------------|
| `--space-xs:4px` ~ `--space-xl:24px` | base.css | `gap:12px`、`padding:8px 12px`、`margin-bottom:14px`（出现 >100 次） |
| `--text-xs:11px` ~ `--text-2xl:22px` | base.css | `font-size: 11px/12px/13px/14px/15px`（出现 >200 次） |
| `--radius-sm:6px` ~ `--radius-xl:20px` | base.css | `border-radius: 6px/8px/12px`（出现 >30 次） |
| `--shadow-sm` ~ `--shadow-xl` | global.css | 硬编码 box-shadow（出现 ~20 次） |

Lit 组件相对较好地使用了 token，但**全局 CSS 文件几乎不用 token**。

#### H8. z-index 无层级体系

15 个不同的 z-index 值，无 CSS 变量，无文档：`1, 2, 3, 4, 5, 10, 12, 30, 40, 65, 70, 100, 200, 1000, 1001`

**修复方向**: 定义 `--z-sidebar`、`--z-dropdown`、`--z-modal`、`--z-toast` 等层级令牌

### 代码质量

#### H9. 3 个 God Component 超过 2000 行

| 文件 | 行数 | 职责混杂 |
|------|------|---------|
| `views/alerts.ts` | **2,805** | 渲染 + 状态 + 数据获取 + 事件处理 + 多个 modal |
| `views/instance-detail.ts` | **2,267** | 渲染 + 数据获取 + 多 tab 管理 + 诊断 |
| `views/chat.ts` | **2,069** | 渲染 + WebSocket + session 管理 + 消息流 |

**修复方向**: 拆分为子组件（如 `alerts.ts` → `<alert-list>` + `<alert-detail-modal>` + `<alert-rule-editor>`）

#### H10. 30+ 处内联 style 绕过 CSS 令牌系统

典型模式（llm-config.ts:433）:
```ts
html`<div style="padding:48px;text-align:center;color:var(--muted);font-size:13px">加载中...</div>`
```
这些内联样式硬编码 px 值，不受主题/密度设置影响。部分甚至混用 `var(--muted)` 和硬编码 `13px`。

#### H11. 22 个 console.error/warn 散布在生产代码

`instance-detail.ts` 独有 7 个，`reports.ts` 有 5 个，`alerts.ts` 有 3 个。中英文混杂，无结构化日志。

#### H12. sql-console.test.ts 的 18 个测试全是占位

```ts
expect(true).toBe(true); // TODO — implement in Plan 02
```

---

## 🟡 MEDIUM — 本 Phase 或下个 Phase

### 交互状态

#### M1. 按钮 Active/Pressed 状态不完整

共享按钮系统的 9 个变体中：btn-primary ✅、btn ✅、btn-sm ✅，但 btn-ghost ❌、btn-icon ❌、btn-xs ❌、btn-danger-outline ❌ 缺少 `:active` 反馈。Nav 项、表格行、过滤按钮也缺少按下反馈。

#### M2. Focus 可见性不统一

全局 `:focus-visible` 规则定义在 `base.css:306`，但许多表单输入框用 `outline:none` 覆盖后只改 `border-color`，没有 `box-shadow` 焦点环。Nav 项完全无 focus 指示器。

#### M3. 加载态简陋

`base.css` 定义了 `.skeleton` / `.skeleton-line` / `.skeleton-block` 骨架屏 CSS，但**仅在 usage 页面使用**。其余视图清一色用 `"加载中..."` 文字或旋转圆圈。表格式数据加载时显示空白区域而非骨架行。

#### M4. 空态设计初级

大部分视图的空态就是文字 `"暂无数据"`。没有插画式空态、没有引导操作。只有 `event-management.ts` 和 `schema-management.ts` 使用了 SVG 图标 + 标题 + 描述的完整空态。

#### M5. 错误态不统一

3 种并存模式：`callout danger` 横幅 / `.error-msg` 内联文本 / 全页 `.error-state`。无重试按钮（仅 cron-jobs 有），无恢复建议。

#### M6. Disabled 态不透明度不一致

`opacity: 0.3`（btn-icon）到 `opacity: 0.7`（chat textarea），无统一 `--disabled-opacity` 令牌。

#### M7. 徽章/标签碎片化

存在 `<status-badge>` 组件，但大部分视图定义自己的徽章类（`.severity-badge`、`.status-badge-sm`、`.analysis-badge`、`.tag`），颜色硬编码（`#ef4444`、`#22c55e`）而非使用语义令牌（`--danger`、`--ok`）。

#### M8. 缺少页面过渡动画

页面切换时瞬间替换，无 crossfade 或 slide 过渡。

### 代码质量

#### M9. 旧 CSS 系统 class 仍可能被引用

`src/styles/components.css` 的 `.app-layout`、`.app-layout__sidebar` 等类如果被任何组件使用会导致布局错误（旧系统 flexbox vs 新系统 grid）。

#### M10. 按钮类名不一致

共享系统定义 `.btn-primary`，但 instances-db、users-management、schema-management 使用 `.btn.primary`（两个独立类）。

#### M11. schema-management 等视图的表格使用内联 style 覆盖列宽

```html
<th style="width:45px;text-align:center;">
```
而其他视图通过 CSS 类控制列宽。

#### M12. 主题名 "claw"/"knot"/"dash" 无 CSS 选择器

`data-theme` 属性被设置但无 CSS 使用，实际只有 `data-theme-mode="light|dark"` 起作用。

#### M13. 部分 Lit 组件引用不存在的 CSS 变量

`docs-viewer.ts` 使用 `--fg`、`--font-mono`、`--bg-active`、`--fg-active`（均未定义）。`branding-settings.ts` 和 `event-management.ts` 使用未定义的 `--success`。

#### M14. 冷热灰混用

系统 A 用暖灰（`#e6e8eb`、`#f8f9fa`），系统 B 用冷灰（`#eceef0`、`#f8fafc`），色差约 2%，但混在一起缺乏一致性。

#### M15. 22 个文件导入 `sharedBtnStyles` 后又自定义按钮样式

`metric-registry.ts`、`approval-dashboard.ts`、`sql-console.ts` 等在导入共享样式后定义视觉不一致的局部按钮类。

---

## 🟢 LOW — 技术债，择机清理

#### L1. `#000000` 纯黑使用

`layout.css:339` 视频播放器背景、`llm-config.ts:89-90` xAI/Grok 品牌色（JS 中）

#### L2. BEM 命名不规范

部分文件使用 BEM（`.chat-group__messages`），部分使用扁平命名（`.toolbar`、`.page`）

#### L3. `<div>` 语义化不足

chat bubble、code block、LLM form 等可用 `<article>`、`<figure>`、`<fieldset>` 替代

#### L4. 没有自定义 tooltip 组件

全站依赖浏览器原生 `title` 属性（不可样式化、无延迟配置）

#### L5. 没有 `@media (hover: hover)` 优化

触摸设备上 hover 效果可能粘滞

#### L6. Chat CSS 中使用了 `!important`（22 处）

主要用于覆盖内联样式和强制 hover 控件可见

---

## 按 Taste Skill Fix Priority 排序的行动计划

| 优先级 | 类别 | 任务 |
|--------|------|------|
| **1. 字体** | C1, H7 | 统一 CSS 令牌系统，删除旧 `global.css`，消除 `#409eff` vs `#7c5cff` 冲突 |
| **2. 色彩** | C1, H7, M14 | 合并暖/冷灰为单一调色板，消除 `#000`，确定 accent 色 |
| **3. 交互态** | M1, M2, M5, M6 | 补全 `:active`/`:focus-visible`/`:disabled` 状态，创建全局 toast |
| **4. 布局间距** | H1, H2, H3, H8 | 统一 dialog/modal → `<slide-dialog>`，表单 → `<form-field>`，卡片 → `<slide-card>` |
| **5. 组件替换** | H4, H5, H6, M7 | 替换"添加实例"等独立 dialog，统一表格，统一徽章/标签 |
| **6. 状态模式** | M3, M4, M5 | 扩展 skeleton 使用，创建空态插画组件，统一错误展示 |
| **7. 排版打磨** | H7, H9, H10 | 消除硬编码 px → token，拆分 god component，清理内联 style |

---

## 附录：本清单对应的文件索引

### 需要删除的文件
- `frontend/src/styles/global.css` (350 行)
- `frontend/src/styles/components.css` (663 行)
- `frontend/src/styles/global.css.d.ts`

### 需要重构的文件（God Components）
- `frontend/src/app/ui/views/alerts.ts` (2,805 行)
- `frontend/src/app/ui/views/instance-detail.ts` (2,267 行)
- `frontend/src/app/ui/views/chat.ts` (2,069 行)

### 需要创建的新共享组件
- `<slide-dialog>` — 统一 dialog/modal
- `<form-field>` — 统一表单行
- `<slide-card>` — 统一卡片
- `<data-table>` — 统一表格
- `<toast-container>` + `showToast()` — 全局通知
- `<empty-state>` — 空态插画组件
- `<loading-skeleton>` — 骨架屏组件

### 需要修复的 CSS 文件（按行数排序）
- `frontend/src/app/styles/components.css` (4,597 行, ~745 px 值)
- `frontend/src/app/styles/config.css` (1,787 行, ~279 px 值)
- `frontend/src/app/styles/usage.css` (1,768 行, ~93 px 值)
- `frontend/src/app/styles/layout.css` (1,206 行, ~192 px 值)
- `frontend/src/app/styles/dreams.css` (1,162 行, ~213 px 值)
- `frontend/src/app/styles/chat/layout.css` (1,099 行, ~206 px 值)
- `frontend/src/app/styles/layout.mobile.css` (763 行, ~100 px 值)
- `frontend/src/app/styles/chat/tool-cards.css` (772 行, ~80 px 值)
- `frontend/src/app/styles/chat/grouped.css` (502 行, ~50 px 值)
- `frontend/src/app/styles/chat/sidebar.css` (343 行, ~40 px 值)
- `frontend/src/app/styles/base.css` (309 行)
- `frontend/src/app/styles/chat/text.css` (190 行)
