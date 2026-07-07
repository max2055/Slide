# Requirements: Slide v0.8

**Defined:** 2026-07-07
**Milestone:** v0.8 服务器纳管
**Core Value:** AI 驱动的数据库运维 — 扩展到通用服务器 SSH 无 Agent 纳管

## v0.8 Requirements

### 服务器注册与凭据管理

- [ ] **SRV-01**: 用户可添加服务器（IP/主机名/SSH 端口/标签/OS 类型），数据存入独立的 `servers` 表
- [ ] **SRV-02**: 用户可配置 SSH 凭据（密码/私钥），凭据加密存储（AES-256-CBC），预填时覆盖现有密码
- [ ] **SRV-03**: 用户可在保存前测试 SSH 连接，验证凭据有效性和服务器可达性
- [ ] **SRV-04**: 用户可查看服务器列表（状态指示器：online/offline/error + 最后检查时间 + CPU/内存摘要徽标）
- [ ] **SRV-05**: 用户可查看服务器详情页（概览/指标趋势图/告警历史/配置 多选项卡）
- [ ] **SRV-06**: SSH 凭据支持密钥轮换（POST /api/servers/:id/rotate-key）

### SSH 指标采集

- [ ] **COL-01**: 系统通过 SSH 采集核心系统指标：CPU 使用率、CPU 负载(1/5/15min)、内存使用、Swap、磁盘使用（每挂载点）、运行时间
- [ ] **COL-02**: 系统通过 SSH 采集扩展磁盘指标：每挂载点磁盘总量、已用、可用、使用率百分比
- [ ] **COL-03**: SSH 指标采集使用持久连接池模式（SshSessionPool），而非每次新建连接
- [ ] **COL-04**: SSH 命令超时处理（readyTimeout 10s + command timeout 15s），超时后标记采集失败
- [ ] **COL-05**: SSH 连接连续 N 次失败后标记服务器为 UNREACHABLE，恢复连接后自动标记为 online
- [ ] **COL-06**: 采集间隔可配置（默认 5 分钟，与 DB 指标 30s 间隔独立）
- [ ] **COL-07**: 采集结果存入 `server_metrics` KV 表（server_id + metric_name + metric_value + recorded_at）
- [ ] **COL-08**: 支持批量 SSH 命令单连接执行（减少连接开销，单次采集内顺序执行所有命令）

### 服务器告警规则

- [ ] **ALR-01**: 用户可为服务器创建告警规则：CPU 使用率 > X%、内存使用率 > X%、磁盘使用率 > X%（指定挂载点或任意）、负载 > X
- [ ] **ALR-02**: SSH 连接失败连续 2 次采集周期后触发"服务器不可达"告警
- [ ] **ALR-03**: 服务器告警复用现有告警引擎（alert-rules/alerts/alert-events），增加 `target_type = 'server'` 和 `server_id` 字段
- [ ] **ALR-04**: 服务器告警通过现有通知渠道推送（钉钉/企微/飞书/Webhook）

### 服务器监控界面

- [ ] **UI-01**: 导航栏新增"服务器"入口，列出所有已纳管服务器
- [ ] **UI-02**: 服务器列表页显示状态指示器、核心指标徽标（CPU/内存/磁盘摘要）、最后采集时间
- [ ] **UI-03**: 服务器详情页包含概览卡片（关键指标实时值）、指标趋势图（ECharts，1h/6h/24h/7d/30d 切换）
- [ ] **UI-04**: 服务器详情告警选项卡显示当前活跃告警和历史告警
- [ ] **UI-05**: 复用现有共享组件（app-card/app-data-table/app-badge/app-dialog/app-empty-state）

### 定时自动化服务器巡检

- [ ] **RPT-01**: 系统支持定时生成服务器健康巡检报告
- [ ] **RPT-02**: 巡检报告包含所有被纳管服务器的健康状态摘要（CPU/内存/磁盘/负载总分）
- [ ] **RPT-03**: 巡检报告支持 PDF/HTML/MD 格式输出，复用现有 report-service
- [ ] **RPT-04**: 管理员可配置巡检报告的发送周期和通知渠道

### AI 服务器分析

- [ ] **AI-01**: Agent 可通过工具查询服务器指标数据（list_server_instances、get_server_metrics、get_server_alerts）
- [ ] **AI-02**: Agent 可在对话中回答服务器相关问题（"显示所有磁盘超过 80% 的服务器"、"分析这台服务器的 CPU 趋势"）
- [ ] **AI-03**: Agent 可在告警触发后自动分析服务器上下文（当前指标 + 历史趋势）并生成分析摘要
- [ ] **AI-04**: Agent 工具集成服务器指标到现有 AI 分析流程（fault-diagnosis、alert-rca）

## v2+ Requirements

Deferred to future milestones.

### 扩展采集

- **COL-09**: 网络 I/O 指标采集（每接口 rx/tx bytes/packets/errors/drops）
- **COL-10**: 磁盘 I/O 指标采集（iostat: tps, read/write kbps, await, svctm）
- **COL-11**: Top 进程采集（按 CPU/内存排序前 N 个进程）
- **COL-12**: inode 使用率采集

### 平台增强

- **ALR-05**: 自适应采集频率（异常时缩短期、稳定时恢复常态）
- **UI-06**: 统一基础设施仪表盘（服务器 + DB 实例统一视图）
- **UI-07**: 服务器-数据库实例关联映射
- **SRV-07**: 跳板机/堡垒机 SSH 代理支持
- **SRV-08**: Host key 验证 UI（首次连接确认 + 变更告警）

## Out of Scope

| Feature | Reason |
|---------|--------|
| Windows 服务器监控 | Linux 优先，Windows 需 PowerShell 命令和不同解析逻辑 |
| 实时 SSH 流式输出 | 轮询采集足够，流式需要 Agent 进程常驻 |
| 远程脚本执行 | 安全风险过大，运维工具不执行不可信脚本 |
| 自动服务器发现 | 网络安全风险，需用户主动添加 |
| 内置 SSH 终端 | 独立产品功能，超出运维平台范围 |
| Agent 安装模式 | v0.8 定位于无 Agent 方案，Agent 模式延后 |
| Windows 凭据管理 | v0.8 仅支持 Linux SSH 凭据 |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| SRV-01 | TBD | Pending |
| SRV-02 | TBD | Pending |
| SRV-03 | TBD | Pending |
| SRV-04 | TBD | Pending |
| SRV-05 | TBD | Pending |
| SRV-06 | TBD | Pending |
| COL-01 | TBD | Pending |
| COL-02 | TBD | Pending |
| COL-03 | TBD | Pending |
| COL-04 | TBD | Pending |
| COL-05 | TBD | Pending |
| COL-06 | TBD | Pending |
| COL-07 | TBD | Pending |
| COL-08 | TBD | Pending |
| ALR-01 | TBD | Pending |
| ALR-02 | TBD | Pending |
| ALR-03 | TBD | Pending |
| ALR-04 | TBD | Pending |
| UI-01 | TBD | Pending |
| UI-02 | TBD | Pending |
| UI-03 | TBD | Pending |
| UI-04 | TBD | Pending |
| UI-05 | TBD | Pending |
| RPT-01 | TBD | Pending |
| RPT-02 | TBD | Pending |
| RPT-03 | TBD | Pending |
| RPT-04 | TBD | Pending |
| AI-01 | TBD | Pending |
| AI-02 | TBD | Pending |
| AI-03 | TBD | Pending |
| AI-04 | TBD | Pending |

**Coverage:**
- v0.8 requirements: 31 total
- Mapped to phases: 0 (roadmap pending)
- Unmapped: 31

---
*Requirements defined: 2026-07-07*
