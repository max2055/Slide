---
phase: 100
slug: 安全紧急修复
status: draft
shadcn_initialized: false
preset: none
created: 2026-05-20
---

# Phase 100 — UI Design Contract

> 纯 bugfix 阶段 — 无新 UI 组件、无新页面、无新设计系统决策。
> 唯一前端变更为 SEC-02: eyeOff 图标 SVG 属性修复。

---

## Phase Type

| Property | Value |
|----------|-------|
| 阶段性质 | 纯 bugfix (4 个生产缺陷修复) |
| 前端变更量 | 1 行 SVG 属性添加 |
| 新组件数 | 0 |
| 新页面数 | 0 |
| 设计系统变更 | 无 — 复用现有所有 tokens |

---

## SEC-02: eyeOff 图标修复

### 问题原因

`frontend/src/openclaw/ui/icons.ts:439` 中 `eyeOff` SVG 元素缺少标准渲染属性，导致图标不可见。

### 修复模式

在 `<svg>` 元素上添加以下属性（第 440 行）：

```
fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
```

**参考模式:** `shield` 图标（icons.ts:489）已有正确属性 `fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"`。

### 前后对比

```
// 修复前 (L440)
<svg viewBox="0 0 24 24">

// 修复后
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
```

> 注意：属性加在 `<svg>` 元素上，**不是**加在每个 `<path>` 上。

### 受影响视图（4 处引用）

| # | 文件 | 行号 | 使用场景 |
|---|------|------|----------|
| 1 | `views/login-gate.ts` | 81 | **登录页**密码可见性切换 — **崩溃现场** |
| 2 | `views/overview.ts` | 199 | 概览页网关密码字段 |
| 3 | `views/config-form.node.ts` | 211 | 配置表单密码字段（使用 `sharedIcons.eyeOff`） |
| 4 | `views/config.ts` | 1113 | 配置页密码字段 |

### 验证方法

1. 打开登录页，点击密码字段的可见性切换按钮
   - 预期：切换前后图标均可见（eye / eyeOff）
   - 当前故障：切换到 eyeOff 时图标不可见
2. 检查概览页、配置表单、配置页的密码字段切换
3. 终端验证：在浏览器开发者工具中确认 SVG 元素携带了正确的渲染属性
4. 无回归：其他图标不受影响（eye 图标已有正确属性）

### 批量修复（Claude's Discretion — 由规划者决定）

修复前应先评估：

```
# 统计缺属性图标数量
grep -c '<svg viewBox="0 0 24 24">' frontend/src/openclaw/ui/icons.ts
```

约 ~40 个图标存在相同的缺属性问题。选项：

| 选项 | 变更范围 | 风险 | 建议 |
|------|----------|------|------|
| A. 只修复 eyeOff | 1 行 | 低 | 最小变更，匹配 SEC-02 需求范围 |
| B. 批量修复所有缺失 | ~40 个图标 × 1 行 | 中 — 行数多但模式统一 | 推荐如 Phase 102 计划中包含此项 |

**决策依据:** 只有 eyeOff 当前导致登录页崩溃。批量修复属于"改进"性质，更适合在 Phase 102 (UI 统一) 中完成，该阶段的目标就是图标文件合并和命名规范统一。

---

## 设计系统零变更声明

| 维度 | 变更? | 原因 |
|------|-------|------|
| 间距 | 无 | 无布局变更 |
| 字体 | 无 | 无文字变更 |
| 颜色 | 无 | 图标复用 `currentColor`，从父元素继承 |
| 文案 | 无 | 无任何文字变更 |
| 组件注册表 | 无 | 无新依赖 |
| 设计 token | 无 | 复用现有 CSS 变量 |

---

## 设计系统引用（现有 — 已由 Phase 91 建立）

本阶段不修改以下内容，仅列出供上下文参考：

| 类别 | 值 | 来源 |
|------|-----|------|
| CSS 变量前缀 | `--text-*`, `--space-*` | `frontend/src/styles/global.css` |
| 图标系统 | Lucide 风格内联 SVG，在 `icons.ts` 中定义为 Lit `html` 模板 | `frontend/src/openclaw/ui/icons.ts` |
| 引用方式 | `icons.eyeOff`, `sharedIcons.eyeOff` | 按需 `import { icons }` |
| 颜色继承 | 通过 `stroke="currentColor"` 从父元素继承 | shied 图标 (L489) 为正确模式 |

---

## Checker Sign-Off

- [x] Dimension 1 Copywriting: N/A — 无文案变更
- [x] Dimension 2 Visuals: 1 行 SVG 属性修复 — 遵循现有 shield 图标模式
- [x] Dimension 3 Color: N/A — 复用 currentColor 继承
- [x] Dimension 4 Typography: N/A — 无字体变更
- [x] Dimension 5 Spacing: N/A — 无布局变更
- [x] Dimension 6 Registry Safety: N/A — 无新依赖

**Approval:** pending
