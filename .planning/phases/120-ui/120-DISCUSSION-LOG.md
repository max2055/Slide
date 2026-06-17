# Phase 120: 全面优化系统UI - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-06-18
**Phase:** 120-ui
**Areas discussed:** CSS 架构重组, 视觉风格参数, 共享组件建设顺序, God Component 拆分

---

## CSS 架构重组

| Option | Description | Selected |
|--------|-------------|----------|
| 蓝色 #409eff | 数据库运维行业惯例，稳重专业，Taste Skill Electric Blue 方向 | ✓ |
| 紫色 #7c5cff | 当前 base.css 默认，偏开发工具风格 | |

| Option | Description | Selected |
|--------|-------------|----------|
| 一步到位删除 | 直接删旧 global.css + components.css，合并有用 token 到 base.css | ✓ |
| 渐进式迁移 | 先标记 deprecated，逐步确认无引用 | |

| Option | Description | Selected |
|--------|-------------|----------|
| 按层组织 (5-7文件) | tokens.css + layout.css + components.css + chat.css + utilities.css | ✓ |
| 保持当前结构 | 只删旧文件，保留 app/styles/ 划分 | |

---

## 视觉风格参数

| Option | Description | Selected |
|--------|-------------|----------|
| V5-6 M3-4 D7-8 | 保守布局 + 克制动效 + 高密度数据面板 | ✓ |
| 调高动效 V5-6 M5-6 D7-8 | 稍多微交互 | |

| Option | Description | Selected |
|--------|-------------|----------|
| 保留 Inter | 可读性优先，中文混排已验证 | ✓ |
| 换 Geist | Vercel 出品，更现代 sharp | |

| Option | Description | Selected |
|--------|-------------|----------|
| 补缺即可 | 只加页面过渡 + 统一 dialog 动画 + 补 :active | |
| 全面标准化 | 动效 token 统一定义，所有动画参数标准化 | ✓ |

---

## 共享组件建设顺序

| Option | Description | Selected |
|--------|-------------|----------|
| 基础设施优先 | tokens→toast→dialog→form-field→card→data-table→empty-state | ✓ |
| 用户可见优先 | dialog→form-field→card→table→toast→tokens | |

| Option | Description | Selected |
|--------|-------------|----------|
| Light DOM | createRenderRoot() { return this; } — 全局 CSS 可覆盖 | ✓ |
| Shadow DOM | 样式隔离但全局 CSS 无法穿透 | |

| Option | Description | Selected |
|--------|-------------|----------|
| app- | 品牌无关，与 app-render.ts 等核心文件一致 | ✓ |
| slide- | 与品牌一致但品牌名可配置时有问题 | |

---

## God Component 拆分

| Option | Description | Selected |
|--------|-------------|----------|
| 按功能区域拆 | alerts → list + detail-modal + rule-editor + analysis-viewer，每子组件 <300行 | ✓ |
| 激进拆分 | 8-10 个子组件，组件树可能过深 | |

| Option | Description | Selected |
|--------|-------------|----------|
| 全部拆分 | alerts + instance-detail + chat 都拆 | ✓ |
| 只拆前两个 | chat.ts 复杂度在 WebSocket/会话管理 | |

---

## Deferred Ideas

- 深色模式完善
- 字体替换 Inter → Geist
- 自定义 tooltip 组件
- JS 动画库引入 (GSAP/Framer Motion)
