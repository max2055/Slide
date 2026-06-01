# 数据库运维前端 - Lit 版本

## 技术栈

- **框架**: Lit 3.3.2 (Web Components)
- **图表**: ECharts 5.4.0
- **构建工具**: Vite 5.0.0
- **样式**: CSS 变量 + 作用域样式

## 架构设计

本前端系统采用 OpenClaw Control UI 的设计风格和技术架构：

### 设计特点

1. **Web Components**: 使用 Lit 框架构建可重用的自定义元素
2. **主题系统**: 支持暗色/亮色主题切换
3. **图标系统**: 基于 Lucide 风格的 SVG 图标
4. **响应式设计**: 侧边栏可折叠，自适应布局

### 目录结构

```
src/
├── api/                    # API 客户端
│   ├── index.ts           # 统一的 API 客户端
│   └── database.ts        # 数据库运维 API 接口
├── components/            # 可复用组件
│   ├── AppLayout.ts       # 主布局组件
│   ├── AppHeader.ts       # 顶部导航栏
│   └── AppSidebar.ts      # 侧边栏导航
├── pages/                 # 页面组件
│   ├── DashboardPage.ts   # 仪表盘页面
│   └── ...
├── styles/                # 样式文件
│   ├── global.ts          # 全局样式变量
│   ├── icons.ts           # 图标系统
│   └── theme.ts           # 主题配置
└── main.ts                # 应用入口
```

## 组件说明

### 布局组件 (AppLayout)

- 包含侧边栏、顶部栏和内容区
- 处理路由和页面切换
- 管理告警通知数量

### 仪表盘组件 (DashboardPage)

- 统计卡片：显示数据库实例统计信息
- 健康趋势图：展示健康评分历史趋势
- 告警列表：显示最新告警通知
- 实例列表：展示数据库实例状态
- 慢查询列表：显示慢查询 TOP10

## 主题系统

### 颜色变量

```css
/* 主色调 */
--color-primary: #409eff;
--color-primary-light: #ecf5ff;
--color-primary-dark: #337ecc;

/* 功能色 */
--color-success: #67c23a;
--color-warning: #e6a23c;
--color-danger: #f56c6c;
--color-info: #909399;

/* 健康评分颜色 */
--color-health-excellent: #37ecba;
--color-health-good: #67c23a;
--color-health-warning: #e6a23c;
--color-health-critical: #f56c6c;
```

### 暗色主题

- 背景：`#1a1a2e`, `#16213e`, `#0f3460`
- 文本：`#ffffff`, `#a0a0a0`, `#666666`

### 亮色主题

- 背景：`#ffffff`, `#f5f7fa`, `#e4e7ed`
- 文本：`#303133`, `#606266`, `#909399`

## API 调用

```typescript
import { databaseAPI, healthAPI, alertAPI } from '@/api/database.js';

// 获取实例列表
const instances = await databaseAPI.getInstances();

// 执行健康检查
const health = await healthAPI.checkHealth(instanceId);

// 获取告警列表
const alerts = await alertAPI.getRecentAlerts({ limit: 5 });
```

## 开发命令

```bash
# 安装依赖
npm install

# 启动开发服务器
npm run dev

# 构建生产版本
npm run build

# 预览生产构建
npm run preview
```

## 与 OpenClaw 的集成

### 设计风格继承

- 导航布局：侧边栏 + 顶部栏的经典布局
- 主题系统：暗色/亮色主题切换
- 图标系统：Lucide 风格 SVG 图标
- 组件模式：Lit Web Components

### 功能菜单对比

| OpenClaw 功能 | 数据库运维功能 |
|--------------|---------------|
| Chat | - |
| Overview | 仪表盘 |
| Instances | 数据库实例 |
| Sessions | - |
| Usage | 运维报表 |
| Cron | 定时任务 |
| Agents | - |
| Skills | 技能执行 |
| Nodes | - |
| Config | 系统设置 |
| Logs | 告警日志 |

## 后续开发计划

- [ ] 数据库实例管理页面
- [ ] 健康检查页面
- [ ] 慢查询分析页面
- [ ] 故障诊断页面
- [ ] 告警管理页面
- [ ] 报表生成页面
- [ ] WebSocket 实时通信
- [ ] TypeScript 类型完善
- [ ] 单元测试覆盖
