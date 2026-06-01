# OpenClaw 风格重构报告

## 重构日期
2026-04-08

## 重构目标
将数据库运维系统前端重构为 OpenClaw Control UI 的设计风格，采用简洁、专业、深度的暗色主题。

## 主要变更

### 1. 全局样式系统

**颜色系统**（基于 OpenClaw 深蓝色主题）：
- 主色：`#409eff` (数据库蓝)
- 背景：`#0e1015` (深度黑蓝)
- 卡片：`#161920` (表面层)
- 边框：`#1e2028` (微妙边框)
- 文本：`#d4d4d8` (主要内容)
- 次要文本：`#838387` (次要内容)

**语义色**：
- 成功：`#22c55e` (绿色)
- 警告：`#f59e0b` (琥珀色)
- 危险：`#ef4444` (红色)
- 信息：`#3b82f6` (蓝色)

**阴影系统**：
- 小阴影：`0 1px 2px rgba(0, 0, 0, 0.25)`
- 中阴影：`0 4px 16px rgba(0, 0, 0, 0.3)`
- 大阴影：`0 12px 32px rgba(0, 0, 0, 0.4)`

**动画系统**：
- 淡入：`fade-in 0.3s`
- 缩放入：`scale-in 0.2s`
- 升起：`rise 0.25s`
- 微光：`shimmer 1.5s` (骨架屏)

### 2. 组件重构

#### AppSidebar (侧边栏)
- 简洁的深色背景 `var(--panel)`
- 简约的 logo 区域
- 扁平化导航项
- 激活状态：柔和的背景色 `var(--accent-subtle)`
- 折叠动画：`0.3s ease-out`

#### AppHeader (顶部栏)
- 高度：56px (原 64px)
- 玻璃态背景：`var(--chrome)` + `backdrop-filter: blur(8px)`
- 简约的面包屑导航
- 用户菜单：简洁的下拉样式
- 告警徽章：小型红色徽章

#### DashboardPage (仪表盘)
- 统计卡片：简洁的卡片设计，无渐变装饰
- 数据表格：简约的行列设计
- 徽章样式：统一的圆角徽章
- 图表：使用 Canvas 绘制的简约折线图

### 3. 设计原则

**OpenClaw 设计哲学**：
1. **深度感**：通过多层深色背景创建 Z 轴深度
2. **克制**：避免过度装饰，使用微妙的边框和阴影
3. **一致**：所有组件使用统一的变量系统
4. **反馈**：明确的悬停和激活状态
5. **专业**：克制的动画，快速的过渡

**与之前设计的对比**：
| 特性 | 之前设计 | OpenClaw 设计 |
|------|---------|--------------|
| 渐变 | 大量使用渐变背景 | 几乎不使用渐变 |
| 阴影 | 强烈的发光阴影 | 微妙的深度阴影 |
| 动画 | 弹跳、脉冲等丰富动画 | 简洁的淡入、缩放 |
| 边框 | 透明边框 | 实色微妙边框 |
| 颜色 | 紫色/粉色强调色 | 蓝色强调色 |
| 复杂度 | 装饰性元素多 | 极简主义 |

### 4. 文件结构

```
frontend/src/
├── styles/
│   ├── global.css       (全局样式变量和基础样式)
│   ├── components.css   (组件通用样式)
│   └── icons.ts         (图标系统)
├── components/
│   ├── AppLayout.ts     (主布局)
│   ├── AppSidebar.ts    (侧边栏)
│   └── AppHeader.ts     (顶部栏)
├── pages/
│   └── DashboardPage.ts (仪表盘)
├── api/
│   ├── index.ts         (API 客户端)
│   └── database.ts      (数据库 API)
└── main.ts              (入口文件)
```

### 5. CSS 变量使用

**布局变量**：
```css
--shell-pad: 16px;
--header-height: 56px;
--sidebar-width: 240px;
--sidebar-collapsed-width: 64px;
```

**过渡变量**：
```css
--ease-out: cubic-bezier(0.16, 1, 0.3, 1);
--ease-in-out: cubic-bezier(0.4, 0, 0.2, 1);
--ease-spring: cubic-bezier(0.34, 1.56, 0.64, 1);
--duration-fast: 100ms;
--duration-normal: 180ms;
--duration-slow: 300ms;
```

**圆角变量**：
```css
--radius-sm: 6px;
--radius-md: 10px;
--radius-lg: 14px;
--radius-xl: 20px;
--radius-full: 9999px;
```

### 6. 响应式设计

**断点**：
- 1200px：4 列卡片 → 3 列
- 900px：3 列卡片 → 2 列，双列布局 → 单列
- 600px：2 列卡片 → 1 列

### 7. 性能优化

- 使用 CSS 变量实现主题切换
- 动画使用 `transform` 和 `opacity` (GPU 加速)
- 骨架屏加载状态
- 按需渲染图表

### 8. 兼容性

- 现代浏览器 (Chrome 90+, Firefox 90+, Safari 14+)
- CSS 变量
- backdrop-filter
- CSS Grid 和 Flexbox

## 下一步

- [ ] 其他页面的 OpenClaw 风格重构
- [ ] 添加骨架屏加载状态
- [ ] 实现 Toast 通知组件
- [ ] 添加确认对话框组件
- [ ] 完善响应式布局
- [ ] 添加键盘快捷键支持

## 参考

- OpenClaw Control UI: `openclaw/ui/src/styles/`
- OpenClaw 主题系统：`openclaw/ui/src/ui/theme.ts`
- OpenClaw 概览页面：`openclaw/ui/src/ui/views/overview.ts`
- OpenClaw 组件样式：`openclaw/ui/src/styles/components.css`
