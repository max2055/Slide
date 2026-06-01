# Phase 102: UI 统一 — Context

**Gathered:** 2026-05-20
**Status:** Ready for planning

## Phase Boundary

统一前端图标系统和卡片组件，消除缺失图标导致的 UI 裂痕。合并两个图标文件为一个规范文件，统一命名规范，提取 ov-card 重复 CSS 为共享 `<stat-card>` Lit 组件，替换结构性 emoji/inline SVG 为共享图标调用。

**Requirements:** UI-01, UI-02, UI-03, UI-04, UI-05
**Depends on:** Phase 101

## Implementation Decisions

### UI-01/02: 图标文件合并
- **D-01:** 新建 `frontend/src/icons.ts` 作为唯一规范图标文件，合并后将两个旧文件 (`frontend/src/openclaw/ui/icons.ts`, `frontend/src/styles/icons.ts`) 删除
- **D-02:** 所有图标统一补全 `fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"` 属性——这是图标不可见（如 eyeOff 崩溃）的根因，一并修复
- **D-03:** 两个文件全部图标合并去重（约 70+ 个），同名图标取 `styles/icons.ts` 版本（其 SVG 属性已完整）
- **D-04:** 保持现有 API 兼容：`export { icons, icon(), renderIcon(), type IconName }`，`renderIcon` 默认 className 改为 `'icon'`（与 styles/icons.ts 一致）
- **D-05:** 31 个文件的 import 路径从两个旧文件改为 `frontend/src/icons.js`

### UI-03: 图标命名规范
- **D-06:** 统一 kebab-case，与 Lucide 官方风格一致（`eye-off`, `bar-chart`, `file-text`, `trending-up`, `chevron-down`）
- **D-07:** 现有 100+ 处 camelCase 引用直接批量替换（`eyeOff→eye-off`, `barChart→bar-chart`, `chevronDown→chevron-down`, `messageSquare→message-square` 等），不保留别名过渡
- **D-08:** 命名冲突以 `styles/icons.ts` 名称为准（更接近 Lucide 官方）。同图形不同名取 styles/ 名（`refresh-cw` > `refresh`）；图形不同的都保留（`check` 和 `circle-check` 是不同图标）；单方独有的转 kebab-case 保留（`more-horizontal`, `arrow-up-down`, `lobster` 等）

### UI-04: stat-card 组件
- **D-09:** LitElement 自定义组件 `class StatCard extends LitElement`——项目已是 Lit 3.3 + Web Components 架构，Shadow DOM 样式隔离 + CSS 变量穿透天然兼容现有主题系统
- **D-10:** 属性：`label`（string）、`value`（string）、`hint`（string）、`variant`（`'ok' | 'warn' | 'danger' | 'info'`，默认无变体）
- **D-11:** 无图标 slot——组件保持纯文本，variant 自动渲染指示点标记（如 danger 显示红色圆点）
- **D-12:** 组件保持纯展示，不加内置点击行为。需要可点击时由父组件包一层 `<button>`（如 overview-cards 已有此模式）
- **D-13:** 颜色通过 CSS 变量驱动（`var(--ok)`, `var(--warn)`, `var(--destructive)`, `var(--info)`），与现有主题系统无缝衔接
- **D-14:** 删除 `components.css` 中 ~80 行 ov-card CSS + 6 个视图中各自内联的重复 ov-card CSS（共约 300 行）
- **D-15:** 6 个视图替换为 `<stat-card>`：`dashboard.ts`, `alerts.ts`, `instances-db.ts`, `reports.ts`, `schema-management.ts`, `overview-cards.ts`

### UI-05: 表情符号替换
- **D-16:** 只替换结构性 emoji（用作图标容器的 emoji 字符），共约 4 处，替换为 `renderIcon()` 调用
- **D-17:** 状态消息中的 ✅❌⚠️ 保留不动——它们是文本语义的一部分（如 "✅ 连接成功"），不属于"用 emoji 替代图标"问题

### Claude's Discretion
- 同名图标的逐个对比和选择映射（30+ 组命名冲突）
- `<stat-card>` 组件的具体文件位置（`frontend/src/components/stat-card.ts` 或其他）
- 旧图标文件删除时机（一次性迁移完即删 vs 分步）
- 6 个视图的 ov-card → stat-card 迁移顺序

## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### 图标源文件（合并前）
- `frontend/src/openclaw/ui/icons.ts` — 49 个图标，camelCase，大部分缺少 SVG 属性
- `frontend/src/styles/icons.ts` — 52 个图标，kebab-case，属性完整

### Card 组件相关
- `frontend/src/openclaw/styles/components.css` §3920-4000 — ov-card 全局 CSS 定义（~80 行）
- `frontend/src/openclaw/ui/views/overview-cards.ts` — 已有 `renderStatCard()` 函数雏形，可作为组件参考
- `frontend/src/openclaw/ui/views/dashboard.ts` — ov-card 使用示例（6 cards）+ 内联 CSS
- `frontend/src/openclaw/ui/views/alerts.ts` — ov-card 使用示例（4 cards）+ 内联 CSS
- `frontend/src/openclaw/ui/views/instances-db.ts` — ov-card 使用示例 + 内联 CSS
- `frontend/src/openclaw/ui/views/reports.ts` — ov-card 使用示例 + 内联 CSS
- `frontend/src/openclaw/ui/views/schema-management.ts` — ov-card 使用示例 + 内联 CSS

### 使用旧 styles/icons.ts 的组件（需改 import）
- `frontend/src/components/AppHeader.ts` — 导入 `styles/icons.js`
- `frontend/src/components/AppSidebar.ts` — 导入 `styles/icons.js`
- `frontend/src/components/AppLayout.ts` — 导入 `styles/icons.js`
- `frontend/src/components/InstanceDetailLayout.ts` — 导入 `styles/icons.js`，使用 `(icons as any)[tab.icon]` 动态图标

### Emoji 需替换的位置
- `frontend/src/openclaw/ui/views/query-analysis-tab.ts` — 🔍📊 标签标题前缀
- `frontend/src/openclaw/ui/views/instance-detail.ts` — 📦 容量图标
- `frontend/src/openclaw/ui/views/event-management.ts` — ⚠️ 空状态

### 需求与规划
- `.planning/REQUIREMENTS.md` — UI-01~UI-05 需求定义
- `.planning/ROADMAP.md` — Phase 102 成功标准和依赖

## Existing Code Insights

### Reusable Assets
- `renderStatCard()` (overview-cards.ts:39-46) — 现有模板函数，可作为 `<stat-card>` LitElement 的 render() 参考
- Project's Lit 3.3 Web Component pattern — `AppHeader`, `AppSidebar` 等都是 LitElement，stat-card 遵循相同模式
- CSS design tokens — `var(--card)`, `var(--border)`, `var(--muted)`, `var(--ok)`, `var(--warn)`, `var(--destructive)`, `var(--info)` 已定义，stat-card 直接引用

### Established Patterns
- LitElement component: `@property()` decorators, `static styles = css`...``
- Icon usage: `icons.iconName` 直接嵌入模板，`renderIcon('name', className)` 带包装 span
- Import extension: `.js` for Lit components, `.ts` for raw templates (Vite resolves)

### Integration Points
- 31 个文件的 import 路径需更新（大多数只改 import 行）
- 6 个视图文件需：删除内联 ov-card CSS → 导入 stat-card → 替换 HTML
- `components.css` 中 ov-card 全局 CSS 删除（确认无其他引用后）
- `frontend/src/main.ts` 或相关入口可能需要注册 `<stat-card>` 自定义元素

## Specific Ideas

无特殊参考 — 按标准方式实施。

## Deferred Ideas

None — discussion stayed within phase scope.

---

*Phase: 102-UI统一*
*Context gathered: 2026-05-20*
