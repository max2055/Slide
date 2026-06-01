# 信息架构设计 - 以数据库实例为中心

## 设计原则

**核心思想**：所有功能围绕**数据库实例**展开，而不是独立的功能模块。

```
用户心智模型：
"我要查看/管理 某个数据库实例 的健康状态/慢查询/故障"
而不是
"我要查看所有数据库的慢查询列表"
```

## 页面结构

### 一级导航

| 路径 | 页面 | 说明 |
|------|------|------|
| `/` | 仪表盘 (Dashboard) | 全局概览，所有实例的汇总统计 |
| `/instances` | 实例列表 (Instances) | 所有数据库实例列表 |
| `/instances/:id` | 实例详情 (Instance Detail) | 单个实例的所有功能和数据 |
| `/alerts` | 告警中心 (Alerts) | 跨实例的告警汇总 |
| `/reports` | 运维报表 (Reports) | 跨实例的报表汇总 |
| `/settings` | 系统设置 (Settings) | 全局配置 |

### 实例详情页结构 (`/instances/:id`)

```
/instances/:id
├── /overview          - 实例概览（基本信息、实时监控指标）
├── /health            - 健康检查（健康评分、检查历史、问题诊断）
├── /slow-queries      - 慢查询分析（慢查询列表、SQL 详情、执行计划）
├── /faults            - 故障诊断（故障历史、自动诊断、自愈）
├── /metrics           - 性能指标（CPU、内存、连接数、QPS/TPS 趋势）
└── /settings          - 实例配置（编辑连接信息、删除实例）
```

## API 设计对照

### 现有 API（已符合实例中心设计）

```
GET  /api/database/instances              - 实例列表
GET  /api/database/instances/:id          - 实例详情
POST /api/database/instances              - 创建实例
PUT  /api/database/instances/:id          - 更新实例
DELETE /api/database/instances/:id        - 删除实例

GET  /api/database/instances/:id/metrics  - 实例监控指标

POST /api/health/check                    - 健康检查（支持指定 instance_ids）
GET  /api/health/:id/history              - 健康历史（按实例）
GET  /api/health/trend/:id                - 健康趋势（按实例）

GET  /api/slow-queries/instances/:id      - 慢查询列表（按实例）
POST /api/slow-queries/instances/:id/analyze  - 分析慢查询（按实例）
POST /api/slow-queries/instances/:id/explain  - 执行计划（按实例）

POST /api/fault/diagnose                  - 诊断故障（需 instance_id）
POST /api/fault/heal                      - 自动修复（需 instance_id）
GET  /api/fault/:id/history               - 故障历史（按实例）

GET  /api/alerts                          - 告警列表（支持 instance_id 过滤）
```

**结论**：后端 API 设计已经是以实例为中心的，前端页面结构需要与之匹配。

## 页面组件设计

### 实例详情页 (`InstanceDetailPage`)

```typescript
// 路由：/instances/:id
// 子路由通过 tabs 切换

layout: InstanceDetailLayout
├── Header: 实例名称、状态徽章、快捷操作
├── Tabs Navigation:
│   ├── Overview      (/instances/:id/overview)
│   ├── Health        (/instances/:id/health)
│   ├── SlowQueries   (/instances/:id/slow-queries)
│   ├── Faults        (/instances/:id/faults)
│   ├── Metrics       (/instances/:id/metrics)
│   └── Settings      (/instances/:id/settings)
└── Tab Content:
    ├── OverviewTab    - 基本信息 + 实时指标卡片
    ├── HealthTab      - 健康评分 + 检查项 + 历史趋势
    ├── SlowQueriesTab - 慢查询列表 + SQL 分析
    ├── FaultsTab      - 故障列表 + 诊断工具
    ├── MetricsTab     - 监控图表（CPU、内存、连接等）
    └── SettingsTab    - 编辑表单 + 危险操作
```

### 各 Tab 内容详细设计

#### 1. Overview Tab
```
- 基本信息卡片：名称、类型、版本、环境、连接信息
- 实时指标卡片：CPU、内存、连接数、QPS、TPS
- 健康状态卡片：当前评分、状态、主要问题
- 快捷操作：健康检查、查看慢查询、诊断故障
```

#### 2. Health Tab
```
- 健康评分概览：总分、各子项评分（CPU、内存、连接、慢查询等）
- 检查项列表：每个检查项的状态、详情、建议
- 历史趋势图：健康评分变化曲线
- 检查历史：历次检查记录
- 操作按钮：执行健康检查
```

#### 3. SlowQueries Tab
```
- 统计卡片：总数量、平均执行时间、总执行时间
- 慢查询列表：SQL、执行次数、平均时间、问题类型
- SQL 详情面板：完整 SQL、执行计划、优化建议
- 操作：分析慢查询、获取执行计划
```

#### 4. Faults Tab
```
- 故障列表：故障类型、严重级别、诊断结果、状态
- 故障详情：根因分析、证据、解决方案
- 诊断工具：选择故障类型、执行诊断
- 自愈操作：执行自动修复
- 历史记录：历次故障和修复记录
```

#### 5. Metrics Tab
```
- 时间范围选择：1h、6h、24h、7d、30d
- 指标图表：
  - CPU 使用率
  - 内存使用率
  - 连接数
  - QPS/TPS
  - 缓冲池命中率
  - 磁盘使用率
  - 复制延迟（如有）
```

#### 6. Settings Tab
```
- 基本信息编辑：名称、环境
- 连接信息编辑：主机、端口、用户名、密码
- 测试连接按钮
- 危险操作：删除实例（软删除）
```

## 导航流程

### 从仪表盘出发
```
Dashboard（仪表盘）
├── 点击实例卡片 → /instances/:id/overview
├── 点击告警 → /alerts?instance_id=:id
└── 查看某个实例的慢查询 → /instances/:id/slow-queries
```

### 从实例列表出发
```
Instances（实例列表）
├── 点击实例名称 → /instances/:id/overview
├── 点击操作菜单 → 健康检查/慢查询/故障诊断
└── 点击状态徽章 → /instances/:id/health
```

### 从告警中心出发
```
Alerts（告警列表）
├── 点击告警 → /instances/:id/:relevant-tab
└── 筛选实例 → 查看特定实例的告警
```

## 与 OpenClaw 的对应关系

OpenClaw Control UI 的设计也是以 Agent/Instance 为中心：

```
OpenClaw:
/instances              → 实例列表
/instances/:id          → 实例详情
  - /overview           → 概览
  - /sessions           → 会话历史
  - /tools              → 工具配置
  - /settings           → 设置

我们的设计:
/instances              → 实例列表
/instances/:id          → 实例详情
  - /overview           → 概览
  - /health             → 健康检查
  - /slow-queries       → 慢查询
  - /faults             → 故障诊断
  - /metrics            → 监控指标
  - /settings           → 设置
```

## 开发优先级

### P0 - 核心功能
1. ✅ Dashboard (仪表盘) - 已完成
2. ⏳ InstancesPage (实例列表) - 待开发
3. ⏳ InstanceDetailPage (实例详情) - 待开发
   - ⏳ Overview Tab
   - ⏳ Settings Tab

### P1 - 监控功能
4. ⏳ Health Tab (健康检查)
5. ⏳ Metrics Tab (性能指标)

### P2 - 分析功能
6. ⏳ SlowQueries Tab (慢查询分析)
7. ⏳ Faults Tab (故障诊断)

### P3 - 辅助功能
8. ⏳ AlertsPage (告警中心)
9. ⏳ ReportsPage (运维报表)
