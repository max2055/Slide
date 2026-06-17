# Phase 120: 全面优化系统UI - Context

**Gathered:** 2026-06-18
**Status:** Ready for planning

<domain>
## Phase Boundary

对 Slide 全系统 UI 进行系统性打磨：统一 CSS 架构（删除双令牌系统）、建立共享组件库（7 个新组件）、标准化视觉风格和交互状态、拆分 3 个 God Component。本 Phase 只打磨现有功能，不新增业务能力。

**In scope**: CSS 令牌统一、共享组件建设、视觉一致性、交互状态标准化、响应式布局、动效体系、God Component 拆分

**Out of scope**: 新业务功能、数据库/后端改动、品牌/LOGO 重设计、深色模式
</domain>

<decisions>
## Implementation Decisions

### CSS 架构重组
- **D-01:** Accent 色统一为蓝色 `#409eff`（数据库运维平台行业惯例），废弃紫色 `#7c5cff`。对齐 Taste Skill Electric Blue 建议。
- **D-02:** 一步到位删除旧系统 — 移除 `main.ts` 中 `import './styles/global.css'`，删除 `src/styles/global.css` (350行) + `src/styles/components.css` (663行)。将旧系统中有用但 base.css 缺失的 token（`--accent-glow`, `--focus-glow`, `--shadow-glow`）和 `[data-theme-mode="dark"]` 块合并到 `base.css`。
- **D-03:** CSS 文件最终结构按层组织（≤7 文件）：`tokens.css`（:root + 设计令牌）→ `layout.css`（shell + 导航 + 响应式）→ `components.css`（共享组件 + 按钮 + 表单 + 表格）→ `chat.css`（聊天子系统）→ `utilities.css`（skeleton, animation keyframes, utility classes）。Dreams 页面可保留独立文件。
- **D-04:** 修复 Chat CSS 双重加载 — `components.css` 和 `styles.css` 各自 `@import "./chat.css"`，保留 styles.css 中的直接 import，删除 components.css 中的重复。

### 视觉风格基线
- **D-05:** Taste Skill 三旋钮设定为 V=5-6（保守布局，左对齐为主，允许适度非对称）/ M=3-4（克制动效，不炫技）/ D=7-8（数据密集面板，紧凑但可读）。
- **D-06:** 保留 Inter + JetBrains Mono 字体组合（运维平台可读性优先，中文混排已验证）。不引入 Geist/Outfit。
- **D-07:** 动效全面标准化 — 统一定义动效 token：时长（`--duration-fast/normal/slow`）、缓动（`--ease-out/in-out/spring`），所有 dialog/modal 统一用同一套进场动画，补全页面过渡（crossfade）和 `:active` 反馈（`translateY(1px)` 或 `scale(0.98)`）。

### 共享组件建设
- **D-08:** 组件优先级顺序：token 修复 → toast 通知系统 → dialog 统一 → form-field → card → data-table → empty-state。基础设施先行，高使用频率组件紧随。
- **D-09:** 所有共享组件使用 Light DOM（`createRenderRoot() { return this; }`），与现有 stat-card 和 29 个 Lit 组件保持一致。全局 CSS 可直接覆盖样式。
- **D-10:** 命名前缀统一为 `app-`（品牌无关）：`<app-dialog>`、`<app-form-field>`、`<app-card>`、`<app-data-table>`、`<app-toast-container>`、`<app-empty-state>`。现有 `<status-badge>` 重命名为 `<app-badge>`。
- **D-11:** `<app-dialog>` 统一 4 种尺寸（sm=400px / md=520px / lg=640px / xl=720px），单一进场动画（`scale-in` + `fade-in`，200ms），ESCAPE 关闭 + overlay 点击关闭。

### 交互状态标准化
- **D-12:** 补全按钮 `:active` 状态：`btn-primary/btn/btn-sm` (已有) + `btn-ghost/btn-icon/btn-xs/btn-danger-outline` (新增)。反馈：`translateY(1px)` 或 `scale(0.98)`。
- **D-13:** 统一 `:focus-visible` 使用 `var(--focus-ring)` token，覆盖所有表单输入框和导航项。
- **D-14:** 统一 disabled 态不透明度为 `--disabled-opacity: 0.45`。
- **D-15:** Toast 通知系统 — 全局 `<app-toast-container>` + `showToast(message, type)` 函数。4 种类型（success/error/warning/info）。固定右下角，3s 自动消失，支持手动关闭。替换 cron-jobs、metric-templates 等各自实现的 toast。
- **D-16:** 加载态统一用骨架屏（复用 `.skeleton` CSS），不再用 `"加载中..."` 文字。数据表格加载时渲染 3-5 行骨架行。
- **D-17:** 空态统一用 `<app-empty-state>` 组件（图标 + 标题 + 描述 + 可选操作按钮）。

### God Component 拆分
- **D-18:** `alerts.ts` (2805行) 拆为 `<alert-list>` + `<alert-detail-modal>` + `<alert-rule-editor>` + `<alert-analysis-viewer>`。每子组件 <300 行。
- **D-19:** `instance-detail.ts` (2267行) 拆为 `<instance-overview-tab>` + `<instance-metrics-tab>` + `<instance-diagnosis-modal>` + `<instance-trend-chart>`。
- **D-20:** `chat.ts` (2069行) 拆为 `<chat-message-list>` + `<chat-compose-area>` + `<chat-tool-result-card>`。WebSocket/会话管理保留在主视图中。
- **D-21:** 拆分粒度目标：每子组件 150-300 行。主视图负责状态协调和数据获取，子组件纯渲染。

### 质量工程
- **D-22:** z-index 建立层级体系：`--z-sidebar: 10` / `--z-dropdown: 100` / `--z-modal: 1000` / `--z-toast: 1100`。
- **D-23:** 消除 ~2000 个硬编码 px → 设计令牌（`--space-*`, `--text-*`, `--radius-*`）。Lit 组件优先，全局 CSS 跟进。
- **D-24:** 22 个 `console.error/warn` 替换为结构化日志（`logger.warn/error`），中英文统一为英文。

### Claude's Discretion
- 设计令牌的具体数值微调（如 `--space-xs` 从 4px→6px 等）由 Claude 根据视觉 audit 结果自行决定
- 共享组件内部 CSS 细节（padding、font-size 精确值）由 Claude 决定，只需保持全站一致
- CSS 文件重构的具体合并/拆分操作顺序由 planner 编排
- 旧 `global.css` 中哪些 token 需要保留、哪些可直接丢弃由 Claude 判断
- `app-` 前缀组件的事件命名约定（如 `app-dialog-close` vs `app-dialog:close`）由实现时决定
</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase 120 审计
- `.planning/phases/120-ui/ui-issues-inventory.md` — 全站 UI 审计报告（95 项发现，含文件:行号引用）。PLAN 必须覆盖所有 CRITICAL 和 HIGH 项。

### 设计系统
- `.agents/skills/redesign-existing-projects/SKILL.md` — Taste Skill Redesign 规则（10 大类审计清单，Fix Priority 顺序）
- `.agents/skills/design-taste-frontend/SKILL.md` — Taste Skill v2 反 AI-slop 设计规则（三旋钮、色板、字体、禁止模式）
- `.agents/skills/high-end-visual-design/SKILL.md` — 高端 agency 审美参考

### 现有共享代码
- `frontend/src/app/styles/shared-btn-styles.ts` — 共享按钮样式系统（Lit `css` tagged template），新组件按钮样式的基础
- `frontend/src/app/ui/components/status-badge.ts` — 现有状态徽章组件，重命名为 `<app-badge>` 的基线
- `frontend/src/app/ui/views/settings-shell.ts` — 设置页面子导航模式参考

### 项目配置
- `.planning/ROADMAP.md` § Phase 120 — 8 条 Success Criteria（完整验收标准）
- `CLAUDE.md` — 项目架构概览（Lit 3.3 + Vite，Fastify 后端）
</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `shared-btn-styles.ts` — Lit `css` 模板导出模式。新共享组件（app-dialog, app-form-field 等）沿用此模式提供可选样式
- `status-badge.ts` — 已在使用 Light DOM + CSS 变量，可作为其他共享组件的实现范本
- `base.css:245-253` — `.skeleton` / `.skeleton-line` / `.skeleton-block` CSS 已定义，只需在各视图中使用
- `base.css:290-303` — `prefers-reduced-motion` 和 `[data-reduce-animations]` 支持已就绪

### Established Patterns
- Lit 组件使用 `createRenderRoot() { return this; }` （Light DOM），所有 29 个组件无 Shadow DOM
- `sharedBtnStyles` 通过 import 引入，Lit 的 `css` tagged template 提供类型安全
- 应用 Shell 使用 CSS Grid（`.shell`），响应式断点：1100px / 768px / 400px
- 设置页面使用左栏（200px 子导航） + 右栏（flex:1 内容）布局

### Integration Points
- `main.ts` — 修改 CSS import 链的入口点
- `app-render.ts` — 应用 Shell 渲染，dialog/toast 容器挂载点
- `app-settings.ts:applyAccentColor()` — 运行时覆盖 accent 色，需同步 D-01 的默认值
- `navigation.ts` — 25 个 Tab 定义，侧边栏渲染依赖
</code_context>

<specifics>
## Specific Ideas

- 用户提到"添加实例" dialog（`instances-db.ts:1088-1242`）样式简陋，需要优先在 `<app-dialog>` 建设中修复
- 用户偏好保守专业的运维工具风格，拒绝花哨动效
- 品牌名可在 Settings 中配置，因此组件前缀不能硬编码品牌名 → 采用 `app-`
</specifics>

<deferred>
## Deferred Ideas

- 深色模式完善 — 当前浅色主题已满足需求
- 字体替换（Inter → Geist）— 风险大于收益，延后评估
- 完全可视化主题重设计 — REQ v2+ 已标记
- 动画升级到 Framer Motion/GSAP 级别 — Slide 是 Lit + vanilla CSS，不引入 JS 动画库
- 自定义 tooltip 组件 — 浏览器原生 `title` 暂时够用
</deferred>

---

*Phase: 120-ui*
*Context gathered: 2026-06-18*
