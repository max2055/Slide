# 服务器运维能力增强实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended; one task per fresh worker) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将现有 SSH 服务器监控稳定收敛到 Kylin OS、Red Hat Enterprise Linux 和 CentOS，并补齐服务器诊断所需的网络、进程、磁盘 IO、服务和日志证据。

**Architecture:** 继续使用现有 `servers`、`server_metrics`、`server-collector`、`ssh-session-pool` 和 `server-alert-evaluator`，通过 OS capability profile 选择固定命令集。所有命令仍为后端定义的只读命令，Agent 不获得任意 shell。

**Tech Stack:** TypeScript, ssh2, MySQL, Lit 3.3, ECharts, Vitest, Playwright。

---

## 冻结范围

### 支持

- Kylin OS（`kylin` 及带版本后缀的标识）。
- Red Hat Enterprise Linux（`rhel`, `redhat`, `red hat enterprise linux` 及版本后缀）。
- CentOS（`centos` 及版本后缀）。
- SSH password/key authentication，继续要求 host key fingerprint。

### 不支持

- Ubuntu、Debian、Windows 和未识别发行版必须返回 `HOST_OS_UNSUPPORTED`，不得静默按 Linux 采集。
- 服务器变更操作、任意 shell、网段扫描和跳板机不在本计划。

## 文件清单

**Create**

- `apps/db-ops-api/src/server-os-profile.ts`
- `apps/db-ops-api/src/server-os-profile.test.ts`
- `apps/db-ops-api/src/server-diagnostic-service.ts`
- `apps/db-ops-api/src/server-diagnostic-service.test.ts`
- `frontend/src/app/ui/components/server-diagnostic-panel.ts`
- `frontend/src/app/ui/components/server-diagnostic-panel.test.ts`
- `frontend/e2e/server-ops.spec.ts`

**Modify**

- `apps/db-ops-api/src/server-metric-provider.ts`
- `apps/db-ops-api/src/server-collector.ts`
- `apps/db-ops-api/src/server-alert-evaluator.ts`
- `apps/db-ops-api/src/metric-registry.ts`
- `apps/db-ops-api/src/alert-rule-template-service.ts`
- `apps/db-ops-api/src/instance-diagnostic-context-service.ts`
- `apps/db-ops-api/src/tools/generated/slide-self-mgmt/server_tools.ts`
- `apps/db-ops-api/server.ts`
- `frontend/src/app/ui/views/servers-page.ts`
- `frontend/src/app/ui/views/server-detail.ts`
- `frontend/src/app/ui/views/server-metric-utils.ts`
- `frontend/src/app/i18n/locales/zh-CN.ts`
- `frontend/src/app/i18n/locales/en.ts`

## Task 1: OS profile 和输入约束

- [ ] 写 `server-os-profile.test.ts` 的参数化测试：接受 `kylin`, `Kylin V10`, `rhel 8`, `red hat enterprise linux 9`, `centos 7/8/9`；拒绝 Ubuntu、Debian、Windows、空值和包含 shell 字符的值。
- [ ] 运行 `pnpm --filter slide-api exec vitest run src/server-os-profile.test.ts`，确认 RED。
- [ ] 创建 `server-os-profile.ts`，暴露 canonical values、`normalizeServerOs()`、`isSupportedServerOs()` 和 profile-specific command environment。
- [ ] 将 `server-metric-provider.ts` 的正则和命令选择改为调用 profile，去掉任何“未知 OS 默认 Linux”的路径。
- [ ] 在创建和更新服务器 API 中统一规范化 `os_type`，详情接口返回 canonical OS 和原始 label（如有）。
- [ ] 运行 `pnpm --filter slide-api exec vitest run src/server-os-profile.test.ts src/server-database-service.security.test.ts`。

## Task 2: 核心指标增强

- [ ] 先扩展 `server-collector-filesystem.test.ts` 和新 collector fixture，覆盖三种 OS 的等价 `LANG=C` 输出和异常输出。
- [ ] 在 `server-metric-provider.ts` 增加固定只读定义：
  - `network_rx_bytes`, `network_tx_bytes`, `network_rx_errors`, `network_tx_errors`, `network_rx_drops`, `network_tx_drops`，来源 `/proc/net/dev`。
  - `disk_read_bytes`, `disk_write_bytes`, `disk_io_time_ms`，优先 `/proc/diskstats`，不依赖 `iostat`。
  - `process_count`, `top_processes_cpu`, `top_processes_memory`，输出限制为 20 行并只保存结构化字段。
  - 保留现有 CPU、内存、Swap、负载、uptime 和每挂载点磁盘指标。
- [ ] 为接口和磁盘指标使用 `dimensions`，维度只允许 `interface`, `device`, `mount`, `direction`，复用 `canonicalDimensions()`。
- [ ] 在 `server-collector.ts` 中按批次执行命令，单台主机总输出限制 512 KiB，单命令超时 15 秒，超限返回稳定错误码并关闭连接。
- [ ] 将失败分类为 `network`, `authentication`, `command`, `unsupported_os`，只有连续失败达到阈值才转 `unreachable`；认证失败必须立即产生可诊断原因。
- [ ] 增加针对 RHEL/CentOS/Kylin 的 parser tests、输出上限测试和连接释放测试。
- [ ] 运行 `pnpm --filter slide-api exec vitest run src/server-metric-provider.test.ts src/server-collector-filesystem.test.ts src/ssh-session-pool-output.test.ts src/ssh-session-pool.security.test.ts`。

## Task 3: 服务器健康、告警和报告

- [ ] 在 `metric-registry.ts` 注册新增 server metrics，声明单位、聚合方式、`higher_is_worse`、有效期和维度。
- [ ] 在 `alert-rule-template-service.ts` 增加网络接口错误/丢包、磁盘 IO、进程数和主机不可达模板；沿用 `target_type=server`，不复制告警表。
- [ ] 扩展 `server-alert-evaluator.ts` 处理带 dimensions 的指标，告警消息中包含接口/磁盘/设备维度和采集时间。
- [ ] 扩展 `server-report-service.ts` 的健康分数：可达性 30%、CPU/内存 25%、磁盘 20%、网络错误/丢包 15%、负载/IO 10%；缺失指标按 unknown，不按 100 分处理。
- [ ] 增加告警去重、持续时间、恢复和旧规则兼容测试。
- [ ] 运行 `pnpm --filter slide-api exec vitest run src/server-alert-evaluator.test.ts src/server-report-service.test.ts src/metric-registry.test.ts`。

## Task 4: 服务器诊断 API 和证据

- [ ] 在 `server-diagnostic-service.ts` 实现只读诊断：服务状态、监听端口、Top 进程、最近系统日志、接口错误摘要；命令必须来自固定 profile，禁止用户传入命令。
- [ ] 每个证据 section 返回 `source`, `collectedAt`, `quality`, `reason`, `truncated`，并设置 5 分钟有效期。
- [ ] 在 `server.ts` 增加：
  - `GET /api/servers/:id/diagnostics`
  - `POST /api/servers/:id/collect-diagnostics`
  两者分别使用 `servers:view` 和 `servers:manage`，后者只触发固定采集，不执行变更。
- [ ] 将诊断证据接入 `instance-diagnostic-context-service.ts`，数据库故障时按已建立的 instance-host relation 加入主机证据。
- [ ] 测试权限、目标绑定、过期证据、SSH 输出截断、日志脱敏和主机不存在场景。
- [ ] 运行 `pnpm --filter slide-api exec vitest run src/server-diagnostic-service.test.ts src/instance-diagnostic-context-service.test.ts src/instance-host-routes.test.ts`。

## Task 5: Agent 服务器工具收敛

- [ ] 保留现有工具名称兼容，但内部改为调用公共诊断服务，避免 `server_tools.ts` 直接拼接 SQL。
- [ ] 增加只读工具参数校验：`serverId`、证据 section、时间范围和最大返回条数；默认最多 100 条记录。
- [ ] `analyze_server_health` 返回指标新鲜度、缺口和建议来源；无数据时必须返回 unknown。
- [ ] 将工具安全目录声明为 `effect=read`, `network=registered-server`, `credentials=use`，不增加写权限。
- [ ] 运行 `pnpm --filter slide-api exec vitest run src/tools/security-catalog.test.ts src/tools/resource-filtering.test.ts src/ai-agent-bridge.test.ts`。

## Task 6: 前端服务器工作台

- [ ] `servers-page.ts` 保留现有 CRUD，增加 OS canonical label、采集质量、网络流量/错误摘要、健康分数和证据新鲜度。
- [ ] `server-detail.ts` 增加“网络 / 进程 / 服务 / 日志 / 关联资源”标签；所有卡片使用 `app-card`、`app-badge`、`app-empty-state` 和现有 token，不新增重复 `.card` 组件。
- [ ] `server-diagnostic-panel.ts` 显示证据来源、采集时间、截断状态和缺口原因；不显示凭据或未脱敏日志。
- [ ] 增加服务器筛选：OS、环境、状态、采集质量、关联数据库。
- [ ] 编写组件测试覆盖空状态、旧数据、移动视口和长主机名；运行 `cd frontend && npx vitest run src/app/ui/components/server-diagnostic-panel.test.ts src/app/ui/views/server-detail-hosted-instances.test.ts src/app/ui/views/server-disk-metrics.test.ts`。

## Task 7: 服务器 E2E 和 UAT

- [ ] `frontend/e2e/server-ops.spec.ts` 覆盖新增服务器、OS 校验、指标卡、诊断面板、关联数据库和告警跳转。
- [ ] 使用 fixture 模拟 Kylin/RHEL/CentOS 采集，禁止测试依赖未安装的真实远端命令。
- [ ] 真实环境至少验证一种 Kylin、一种 RHEL 或 CentOS 的 SSH host key、核心指标和失败恢复。
- [ ] 运行 `cd frontend && npx playwright test frontend/e2e/server-ops.spec.ts`（从仓库根目录执行时使用正确的 `--config`），并运行后端 focused gate。

## Wave 1 验收

- [ ] 三种支持 OS 均能采集核心指标，其他 OS 明确拒绝。
- [ ] 网络接口指标有稳定 dimensions，不产生 N+1 查询或无界 cardinality。
- [ ] 服务器故障诊断能返回质量和缺口，且不会把缺失数据判为健康。
- [ ] 现有服务器 CRUD、告警、报表、数据库-主机关系测试无回归。
