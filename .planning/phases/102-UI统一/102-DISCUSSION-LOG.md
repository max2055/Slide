# Phase 102: UI 统一 - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-05-20
**Phase:** 102-UI统一
**Areas discussed:** 图标合并策略, 图标命名规范, stat-card 组件设计, 表情符号替换策略

---

## 图标合并策略

| Option | Description | Selected |
|--------|-------------|----------|
| openclaw/ui/icons.ts | 已有 27 个文件导入，但需批量补充 SVG 属性 | |
| styles/icons.ts | 已有正确 SVG 属性，但需改 27 个文件导入路径 | |
| 全新文件 frontend/src/icons.ts | 创建全新规范文件，一步到位 | ✓ |

| Option | Description | Selected |
|--------|-------------|----------|
| 统一补全属性 | 所有图标加 fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" | ✓ |
| 只补影响到视图的 | 只修有渲染问题的图标 | |

| Option | Description | Selected |
|--------|-------------|----------|
| 全部合并去重 | 两个文件所有图标合并，同名取 styles/icons.ts 版本 | ✓ |
| 按需合并 | 只合并当前视图使用的 | |

| Option | Description | Selected |
|--------|-------------|----------|
| 保持现有 API 兼容 | icons, icon(), renderIcon(), type IconName，默认 className 用 'icon' | ✓ |
| 新增辅助工具函数 | 额外提供 iconSprite(), coloredIcon() 等 | |

**User's choice:** 全新文件 frontend/src/icons.ts，全部合并去重，统一补全属性，保持现有 API。renderIcon 默认 className = 'icon'。用户追问后 Claude 推荐方案 A（保持现有 API），用户确认。

---

## 图标命名规范

| Option | Description | Selected |
|--------|-------------|----------|
| 统一 kebab-case | 与 Lucide 官方风格一致 | ✓ |
| 保持 camelCase | JS/TS 直接 icons.eyeOff 更符合语言习惯 | |

| Option | Description | Selected |
|--------|-------------|----------|
| 直接批量替换 | 一次性替换所有引用点，不保留旧名 | ✓ |
| 加别名过渡 | 旧名保留 @deprecated 别名 | |

| Option | Description | Selected |
|--------|-------------|----------|
| 以 styles/icons.ts 为准 | 更接近 Lucide 官方命名 | ✓ (Claude) |
| 按语义择优 | 逐个判断 | |

**User's choice:** 统一 kebab-case，直接批量替换。命名冲突交给 Claude 决定——Claude 选 styles/icons.ts 为准。规则：同图形不同名→取 styles/ 名；图形不同→都保留；单方独有→kebab-case 保留。

---

## stat-card 组件设计

| Option | Description | Selected |
|--------|-------------|----------|
| LitElement 自定义组件 | class StatCard extends LitElement，Shadow DOM 隔离 | ✓ (Claude) |
| 共享模板函数 | 导出 renderStatCard() 函数 | |

| Option | Description | Selected |
|--------|-------------|----------|
| variant 属性 | ok\|warn\|danger\|info\|default，通过 CSS 变量驱动 | ✓ (Claude) |
| 自定义 slot | label/value/hint 由 slot 控制 | |

| Option | Description | Selected |
|--------|-------------|----------|
| 纯属性，无图标 | variant 自动渲染指示点 | ✓ |
| 加 icon slot | 允许自定义图标 | |

| Option | Description | Selected |
|--------|-------------|----------|
| 纯展示 | 组件不加点击，父组件按需包 button | ✓ (Claude) |
| 加 href 属性 | 可选的链接模式 | |

**User's choice:** 全部交给 Claude 决定——"从规范和长远角度考虑，注意与外观设置兼容"。Claude 选择 LitElement + variant 属性 + 无图标 + 纯展示。理由：项目已是 Lit 3.3 架构，Shadow DOM + CSS 变量天然兼容主题系统。

---

## 表情符号替换策略

| Option | Description | Selected |
|--------|-------------|----------|
| 分类替换 | 结构emoji→图标，状态emoji→CSS指示器 | |
| 全部用图标 | 所有 emoji 统一替换 | |
| 只替结构性 | 只替标签标题中的 🔍📊📦，状态消息 ✅❌ 保留 | ✓ |

**User's choice:** 只替换结构性 emoji（约 4 处），状态消息的 ✅❌⚠️ 不管。用户先追问选项 1 和 3 区别，Claude 解释后选了 3。

---

## Claude's Discretion

- 同名图标的具体映射表（30+ 组命名冲突对比）
- `<stat-card>` 组件文件位置
- 旧文件删除时机
- 6 个视图的迁移顺序

## Deferred Ideas

None — discussion stayed within phase scope.
