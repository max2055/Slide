# AI 基础运维助手总体实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Slide 从数据库运维平台演进为覆盖数据库、服务器和华为网络设备的 AI 基础运维助手，同时保持现有数据库 API 和用户流程兼容。

**Architecture:** 以 `ResourceRef + Capability + Observation + Relation + Operation` 作为跨资源内核。数据库和服务器保留现有专用表及 API，通过适配器接入统一资源契约；华为网络设备先实现 SNMPv3 只读观测和 SSH 配置备份，所有写操作延后到独立审批阶段。

**Tech Stack:** TypeScript, Fastify, MySQL, Lit 3.3, `ssh2`, `net-snmp`, Vitest, Playwright, DirectAdapter。

---

## 冻结的范围契约

### 本次范围

- 服务器操作系统：Kylin OS、Red Hat Enterprise Linux、CentOS。
- 网络设备厂商：华为 VRP；第一版按真实实验设备确认型号和 MIB，不承诺其他厂商。
- 网络设备能力：SNMPv3 可达性/认证测试、uptime、CPU、内存、温度、接口 admin/oper、入出流量、错误/丢包/丢弃、设备级告警、与服务器/数据库关系、配置备份。
- 配置备份为只读采集，备份内容加密存储，界面默认只显示脱敏摘要和版本信息。
- Agent 默认只读；服务器操作和网络设备配置下发不在本轮范围。

### 明确排除

- Windows、Ubuntu、Debian、Solaris 等服务器。
- Cisco、H3C、Juniper 等其他网络设备厂商。
- 自动网段扫描、自动发现和未经批准的网络设备配置修改。
- 任意 SSH shell、任意 SNMP SET、路由/VLAN/ACL 自动变更。
- 一次性把 `database_instances`、`servers`、`network_devices` 合并为单表。

### 停止条件

- 任何新需求若不直接阻塞下列验收项，进入 backlog，不在本里程碑扩展。
- 需要真实华为设备才能验证的协议行为，在没有实验设备或抓包/厂商 MIB 证据时不得宣称完成。
- 迁移、权限或凭据安全测试失败时停止功能扩展，先修复安全门禁。

## 执行顺序与依赖

| Wave | 子计划 | 结果 | 依赖 |
|---|---|---|---|
| 0 | `2026-08-25-infrastructure-ops-foundation.md` | 资源类型、关系、权限、观测和公共 API 契约 | 无 |
| 1 | `2026-08-25-server-ops-expansion.md` | 三种 Linux 发行版的服务器指标、诊断和 UI 闭环 | Wave 0 类型契约 |
| 1 | `2026-08-25-huawei-network-device.md` | 华为 SNMPv3、接口指标、告警、配置备份和关系 | Wave 0 类型契约 |
| 2 | 本文件的集成门禁 | 总览、跨资源诊断、完整回归和发布文档 | Wave 1 两个子计划 |

## 统一资源契约

```text
ResourceType = instance | server | network_device
CapabilityState = declared | configured | verified | degraded | unsupported
Observation = resource + metric + dimensions + value + observedAt + quality + source
Relation = source + target + relationType + provenance + validity window
Operation = target + effect + protocol + approval binding + audit record
```

## 统一验收清单

### 功能验收

- [ ] 可纳管 Kylin、RHEL、CentOS，并拒绝未支持的 OS 类型。
- [ ] 可纳管一台华为 VRP 设备，完成 SNMPv3 认证测试和 SSH 主机密钥校验。
- [ ] 华为设备显示 uptime、CPU、内存、温度、接口状态、流量、错误、丢包和丢弃。
- [ ] 可生成设备级告警，并能从告警跳转到设备详情。
- [ ] 可采集、列出、查看和恢复某设备的配置备份版本。
- [ ] 数据库实例、服务器和网络设备可以建立可审计关系。
- [ ] Agent 能基于数据库-服务器-网络设备证据回答关联故障问题。

### 安全验收

- [ ] SNMPv3 密钥和 SSH 凭据不出现在 API、日志、Agent 上下文或前端响应中。
- [ ] 配置备份原文加密存储，下载/查看需要独立权限并记录审计。
- [ ] 未绑定资源、过期凭据、错误主机密钥、未审批操作均 fail closed。
- [ ] 任何配置写操作和任意命令执行在本里程碑均不可用。

### 工程验收

- [ ] 每个子计划的 focused tests、typecheck、contract check 通过。
- [ ] 后端、前端和 Agent Core 的受影响测试通过。
- [ ] Playwright 在桌面和移动视口通过，无溢出、重叠和空状态错误。
- [ ] `pnpm contracts:check`、schema validator、security gate 和生产构建通过。

## 最终集成任务

### Task I1: 统一总览和导航

**Files:**
- Modify: `frontend/src/app/ui/navigation.ts`
- Modify: `frontend/src/app/ui/app-render.ts`
- Modify: `frontend/src/app/ui/views/dashboard.ts`
- Modify: `frontend/src/app/i18n/locales/zh-CN.ts`
- Modify: `frontend/src/app/i18n/locales/en.ts`
- Modify: `docs/slide/README.md`
- Modify: `docs/slide/ARCHITECTURE.md`

- [ ] 将侧边栏分组改为“总览 / 数据库 / 服务器 / 网络设备 / 告警与事件 / Agent”，保留旧路径重定向。
- [ ] 总览同时读取三类资源的状态、数据新鲜度、未解决告警和关系影响范围；数据库原有卡片数据保持兼容。
- [ ] 为缺失采集数据显示明确的质量和原因，不把空值渲染为健康。
- [ ] 更新产品定位和运行文档，删除“仅数据库”描述。
- [ ] 运行 `cd frontend && npx vitest run src/app/ui/views/dashboard.test.ts`、`npm run typecheck`、`npm run build`。

### Task I2: 跨资源事件和 Agent 证据包

**Files:**
- Modify: `apps/db-ops-api/src/instance-diagnostic-context-service.ts`
- Modify: `apps/db-ops-api/src/fault-diagnosis-service.ts`
- Modify: `apps/db-ops-api/src/ai-agent-bridge.ts`
- Modify: `apps/db-ops-api/src/tools/generated/slide-self-mgmt/index.ts`
- Create: `apps/db-ops-api/src/tools/generated/slide-self-mgmt/resource_tools.ts`
- Create: `apps/db-ops-api/src/tools/generated/slide-self-mgmt/resource_tools.test.ts`
- Modify: `frontend/src/app/ui/views/alerts.ts`

- [ ] 将诊断主题从 instance/server 扩展为任意 `ResourceRef`，并携带关系、采集时间、质量和缺口。
- [ ] 增加只读 `list_resources`、`get_resource_observations`、`get_resource_relations`、`diagnose_resource` 工具。
- [ ] 在工具策略中绑定资源、权限和效果；不为网络设备注册写工具。
- [ ] 用固定 fixture 验证“数据库异常 + 主机正常 + 网络接口丢包”的证据排序和缺口说明。
- [ ] 运行 `pnpm --filter slide-api exec vitest run src/instance-diagnostic-context-service.test.ts src/fault-diagnosis-service.test.ts src/tools/generated/slide-self-mgmt/resource_tools.test.ts src/tools/security-catalog.test.ts`。

### Task I3: 最终资格门禁

**Files:**
- Create: `frontend/e2e/infrastructure-ops.spec.ts`
- Modify: `tests/qualification/coverage-matrix.ts`
- Modify: `tests/qualification/security-gate.ts`
- Modify: `docs/slide/USER-GUIDE.md`

- [ ] E2E 纳管三类资源，建立关系，触发告警，查看配置备份并启动一次只读诊断。
- [ ] 运行 `pnpm --filter slide-api test:all`、`pnpm --filter slide-api typecheck`、`cd frontend && npm test -- --run`、`npm run typecheck`、`npm run build`。
- [ ] 运行 `pnpm contracts:check`、`pnpm security:test`、`pnpm security:scan` 和 schema validator。
- [ ] 在真实华为设备上执行一轮 SNMPv3、接口指标和配置备份 UAT；没有设备时记录为环境阻塞，不降低测试标准。

## 资源预算与停止门

- 计划按 3 个独立子计划执行，最多 8 个实现/审查任务，不再引入第四类资源。
- 每个 Wave 只运行 focused checks；Wave 结束后运行受影响模块门禁；最终集成只运行一次完整 gate。
- 任何迁移失败、凭据泄露、未授权访问或配置备份原文外泄均为 P0，立即停止后续功能开发。
