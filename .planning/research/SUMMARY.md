# Project Research Summary

**Project:** Slide — v0.8 服务器纳管
**Domain:** SSH 无 Agent 服务器监控
**Researched:** 2026-07-07
**Confidence:** HIGH

## Executive Summary

v0.8 在现有数据库运维平台 Slide 上增加**通用服务器 SSH 无 Agent 纳管**能力。调研结论：技术栈极轻（仅 `ssh2` 一个 npm 新依赖），现有基础设施高度可复用（采集调度、指标存储、告警引擎、通知渠道、报表生成），核心工作在于构建 SSH 连接池、服务器注册服务、指标采集器和前端界面。

关键设计决策：
1. **服务器 vs 数据库实例** — `servers` 表独立于 `database_instances`，通过 `server_id` 外键关联（多对一）
2. **指标存储** — 推荐 KV 表 `server_metrics`（server_id + metric_name + value），避免固定列模式
3. **连通性** — `SshSessionPool` 连接池模式（复用 ssh2 Client），非每次新建连接
4. **凭据安全** — 复用现有 AES-256-CBC 加密方案存储 SSH 私钥，需内置 host key verification
5. **告警集成** — 告警规则和 alerts 表增加 `target_type` + `server_id`，复用现有 alert-engine

关键风险：Host key 验证绕过（MITM）、SSH 密钥明文存储、连接池耗尽、不同 Linux 发行版命令输出格式差异。

## Key Findings

### 推荐技术栈

只需要一个新增 npm 包：

- **ssh2@^1.17.0** — Node.js SSH 客户端标准库（13年维护，2M+ weekly downloads）
- **@types/ssh2@^1.15.5** — TypeScript 类型定义
- 连接池自行实现（Map&lt;id, Client&gt;，和现有 database-service.ts 一致）
- 指标解析自行实现（line-split + regex，每命令约 20 行解析逻辑）
- AES-256-CBC 加密复用现有 `encryptData/decryptData` 模式
- **明确避免的包**: `node-ssh`（多余依赖链）、`ssh2-promise`（2022 年停更）

**核心推荐:**
- `ssh2`: SSH 连接，所有操作
- Node.js crypto: SSH 密钥加密存储
- 复用现有 cron/metrics/alert/report 基础设施

### 功能范围

**表 stakes（用户期待）：**
- 服务器注册/注销（IP/主机名/SSH port/凭据/标签）
- SSH 凭据管理（密码 + 密钥支持，加密存储）
- 测试 SSH 连接（保存前验证）
- 核心指标采集：CPU 使用率、内存、磁盘、系统负载、运行时间
- 扩展指标：网络 I/O、磁盘 I/O、Top 进程（P2）
- 服务器列表/详情视图 + 指标趋势图
- 服务器告警规则（复用现有告警引擎）
- 定时自动化巡检报告

**差异化：**
- 与现有 DB 实例监控统一视图
- Agent 自管理工具的 AI 分析能力
- 闭环健康中心的服务器维度扩展

**反模式（避免）：**
- 实时 SSH 流式输出（应用场景不适合）
- 远程脚本执行（安全风险过大）
- Windows 监控（feature creep）
- 自动服务器发现（网络安全违规）
- 内置 SSH 终端（独立产品）

### 架构方案

```
ServerCollector (cron heartbeat)
  → SshSessionPool (ssh2 连接池)
    → ServerMetricProvider (命令定义 + 解析器注册)
      → server_metrics (KV 时间序列表)

AlertEngine (扩展)
  → alert_rules (增加 target_type = 'server')
  → alerts (增加 server_id)
  → alert_events (复用)
  → notification-service (复用无改动)

Frontend (Lit 3.3 + ECharts)
  → 服务器列表页 (复用 app-data-table)
  → 服务器详情页 (概览 + 指标趋势图 + 告警)
  → 告警规则配置 (复用 app-dialog/app-form-field)
  → 巡检报告 (复用 report-service)
```

**核心新组件：**
1. `servers` 表 + `server_credentials` 表 + `server_known_hosts` 表
2. `server-metric-definitions` 注册表（复用 metric_definitions 模式）
3. `server-metrics` KV 表（独立于 DB 指标）
4. `SshSessionPool` 类（连接池管理）
5. `ServerCollector` 类（采集循环，与 MonitorCollector 并行）
6. `ServerMetricProvider`（命令定义 + 解析器）

**现有组件扩展：**
- `alert_rules` + `alerts` 表增加 `target_type` 和 `server_id` 列
- `alert-engine.ts` 增加 `evaluateAllServerRules()` 分支
- `notification-service.ts` 无改动（server_id 已包含在 alert 上下文中）

### 关键陷阱

1. **Host Key 验证绕过 (MITM)** — ssh2 默认 auto-accept。必须实现 `hostVerifier`，存储 known_hosts。Phase 1 必须设计好验证模型。
2. **SSH 密钥明文存储** — 私钥泄漏风险极高。必须加密存储，提供密钥轮换 API。
3. **连接池耗尽** — 每周期新建连接会导致 socket 泄漏、Event Loop 阻塞。必须使用持久连接 + keepalive + 每主机并发限制（默认 3）。
4. **解析跨发行版脆弱性** — `df -B1` 可能不存在、不同 locale 输出格式不同。应对：所有 exec 前缀 `LANG=C LC_ALL=C`，优先用 `/proc` 文件。
5. **Event Loop 阻塞** — SSH 密钥交换是同步 crypto 操作。持久连接避免每次重建，全局信号量限制并发。
6. **不要建平行监控系统** — 最大的架构错误是为服务器监控另起一套采集/存储/告警体系。应该扩展现有组件。

## Roadmap Implications

### 建议阶段结构

**Phase 1: 基础设施（服务器注册 + 凭据管理）**
底层依赖：servers 表、server_credentials 表、SSH 凭据加密存储、服务器 CRUD API + 前端、连接测试
**影响：所有后续阶段依赖此阶段**

**Phase 2: SSH 连接池 + 核心指标采集**
SshSessionPool、ServerCollector、CPU/内存/磁盘/负载/Uptime 采集、server_metrics 表、服务器列表 + 详情页 ECharts 趋势图
**前置：Phase 1**

**Phase 3: 服务器告警**
alert_rules/alerts 表扩展 server_id + target_type、服务器告警规则 UI、告警联动
**前置：Phase 2**

**Phase 4: 定时自动化巡检**
扩展 report-service 支持服务器巡检报告、报告模板、定时报告调度
**前置：Phase 2**

**Phase 5: 平台增强（可选）**
Host key 验证 UI、凭据轮换、密钥管理、批量操作、AI 服务器分析
**前置：Phase 2**

### 阶段顺序依据

- Phase 1 为基础 — 服务器注册和凭据存储是所有操作的前提
- Phase 2 为核心 — 连接池和采集是所有数据和告警的前提
- Phase 3 在 Phase 2 之后 — 告警需要指标数据
- Phase 4 在 Phase 2 之后 — 巡检报告需要采集的指标
- 告警和巡检可以并行依赖 Phase 2

## 信心评估

| 领域 | 信心 | 说明 |
|------|------|------|
| 技术栈 | HIGH | ssh2 是 Node.js SSH 标准库，已验证 npm 版本和依赖 |
| 功能范围 | HIGH | 服务器监控是成熟领域，模式来自 Nagios/Zabbix/Prometheus |
| 架构 | HIGH | 每个新组件映射到现成的 Slide 类比（数据库实例、采集器、告警） |
| 陷阱 | HIGH | 每个陷阱都有具体的 SSH MITM、连接泄漏、跨发行版解析问题 |

## Source

- Slide 代码库：现有 database-service.ts（连接池模式）、monitor-collector.ts（采集器模式）、alert-engine.ts（告警引擎）、report-service.ts（报表）
- npm: ssh2@^1.17.0, @types/ssh2@^1.15.5
- nmp: node-ssh（避免）、ssh2-promise（停更，避免）
- ssh2 GitHub: 连接生命周期、hostVerifier、keepalive 文档
- Linux: /proc 文件系统、top/free/df/netstat 输出格式

---
*Research completed: 2026-07-07*
*Ready for roadmap: yes*
