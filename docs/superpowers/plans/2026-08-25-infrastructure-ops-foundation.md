# 基础运维资源内核实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不破坏现有数据库和服务器 API 的前提下，将资源、能力、关系、观测、权限和公共契约扩展到 `network_device`。

**Architecture:** 保留 `database_instances` 和 `servers` 的物理表，新增 `network_devices` 物理表；统一层只负责资源引用、权限、关系、能力和观测协议。旧字段继续兼容，新网络设备数据通过明确的 `network_device_id` 和 `resource_type` 扩展接入。

**Tech Stack:** TypeScript, Fastify, MySQL migrations, TypeBox, Vitest, generated OpenAPI client。

---

## 约束

- 只新增 `network_device`，不在本阶段合并旧表。
- 旧路由 `/api/database/*`、`/api/servers/*` 和旧权限代码保持可用。
- 不在本阶段实现 SNMP 或华为逻辑；本计划只提供可被网络设备适配器使用的内核。

## 文件清单

**Create**

- `apps/db-ops-api/sql/migrations/070_network_device_resource_foundation.sql`
- `apps/db-ops-api/src/resources/resource-subject.ts`
- `apps/db-ops-api/src/resources/resource-subject.test.ts`
- `apps/db-ops-api/src/resources/network-device-types.ts`
- `apps/db-ops-api/src/resources/network-device-types.test.ts`
- `apps/db-ops-api/src/network-devices/network-device-database-service.ts`
- `apps/db-ops-api/src/network-devices/network-device-database-service.test.ts`

**Modify**

- `apps/db-ops-api/src/resources/types.ts`
- `apps/db-ops-api/src/resources/resource-service.ts`
- `apps/db-ops-api/src/resources/capability-service.ts`
- `apps/db-ops-api/src/resources/observation-service.ts`
- `apps/db-ops-api/src/auth/role-permissions.ts`
- `apps/db-ops-api/src/security/public-dto.ts`
- `apps/db-ops-api/src/contracts/public-api.ts`
- `apps/db-ops-api/src/contracts/generate-public-api.ts`
- `apps/db-ops-api/server.ts`
- `apps/db-ops-api/sql/schema.sql`

## Task 1: 定义资源和关系类型

- [ ] 先写 `resource-subject.test.ts`：验证 `ResourceType` 接受 `instance`, `server`, `network_device`；验证非法类型、零 ID、空 label 被拒绝。
- [ ] 运行 `pnpm --filter slide-api exec vitest run src/resources/resource-subject.test.ts`，确认失败原因是新类型不存在。
- [ ] 在 `resources/types.ts` 增加 `network_device`，在 `resource-subject.ts` 提供 `parseResourceRef()`、`resourceKey()` 和资源类型标签映射。
- [ ] 在 `resource-service.ts` 扩展拓扑规则：`instance runs_on server`、`server connected_to network_device`、`network_device serves server`；禁止自环和重复活动边。
- [ ] 为 `canReadResource` / `canManageResource` 增加 `network_devices:view`、`network_devices:manage`，并保留 `servers:*` 与 `instance:*` 行为。
- [ ] 运行 `pnpm --filter slide-api exec vitest run src/resources/resource-subject.test.ts src/resources/resource-service.test.ts`。

## Task 2: 创建数据库迁移

**迁移必须幂等，并使用现有 migration runner 的单语句兼容模式。**

- [ ] 先写 migration invariant 测试，检查以下对象存在且枚举包含 `network_device`：
  - `network_devices`
- `network_device_interfaces`
- `network_device_observations`
  - `network_device_config_backups`
  - `resource_relations`
  - `resource_capabilities`
  - `alert_rules`、`alerts`、`alert_events` 的网络设备目标字段
- [ ] 在 `070_network_device_resource_foundation.sql` 创建 `network_devices`：
  - `id`, `name`, `label`, `host`, `site`, `vendor`, `model`, `os_version`, `serial_number`
  - `snmp_port` 默认 161，`ssh_port` 默认 22
  - `status`, `last_check_at`, `collection_enabled`, `created_at`, `updated_at`
  - 唯一键 `(host, snmp_port)`，厂商值第一版约束为 `huawei`
- [ ] 创建 `network_device_credentials`：按 `protocol` 区分 `snmpv3` / `ssh`，算法、用户名等非秘密字段单独存储，认证/加密密钥和私钥使用 `encryptData()` 加密；严禁把明文放入 `network_devices`。
- [ ] 创建 `network_device_interfaces`：`device_id`, `if_index`, `if_name`, `if_alias`, `speed_bps`, `admin_status`, `oper_status`, `last_seen_at`，唯一键 `(device_id, if_index)`。
- [ ] 创建 `network_device_observations`：`device_id`, `metric_id`, `dimensions`, `metric_value`, `recorded_at`, `quality`, `source`；索引 `(device_id, metric_id, recorded_at)` 和 `(device_id, recorded_at)`，维度写入前调用 `canonicalDimensions()`。
- [ ] 创建 `network_device_config_backups`：`device_id`, `version_no`, `content_encrypted`, `content_sha256`, `source_protocol`, `collected_at`, `size_bytes`, `redaction_status`, `created_by`；原文限制 2 MiB，外键删除级联。
- [ ] 为 `resource_relations` 和 `resource_capabilities` 的资源类型枚举增加 `network_device`，为关系类型增加 `connected_to`、`serves`。
- [ ] 为 `alert_rules`、`alerts`、`alert_events` 增加可空 `network_device_id` 和索引，并将目标类型枚举扩展为 `network_device`；保持旧 `instance_id/server_id` 字段不变。
- [ ] 为 `reports`、`report_configs`、AI analysis subject 增加同样的网络设备字段，保证旧记录不迁移、不丢失。
- [ ] 更新 `sql/schema.sql`，运行 `pnpm --filter slide-api schema:check` 和 migration invariant tests。

## Task 3: 网络设备公共类型和 DTO

- [ ] 在 `network-device-types.ts` 定义：`NetworkDeviceVendor = 'huawei'`、`NetworkDeviceStatus`、`SnmpV3SecurityLevel`、`InterfaceStatus`、`ConfigBackupSummary`。
- [ ] 将输入拆成 `NetworkDeviceCreateInput`、`NetworkDeviceUpdateInput`、`SnmpV3CredentialInput`、`SshCredentialInput`，秘密字段只允许进入写入服务，不出现在 DTO。
- [ ] 编写 DTO 测试，验证 host/port、SNMPv3 用户名、算法、密钥长度和配置备份大小边界。
- [ ] 更新 `public-api.ts` 和生成器，增加 `/api/network-devices`、`/metrics`、`/interfaces`、`/config-backups` 的 schema。
- [ ] 运行 `pnpm contracts:generate && pnpm contracts:check`。

## Task 4: 网络设备库存服务和基础路由

- [ ] 先写 `network-device-database-service.test.ts`：创建、更新、删除、重复地址、凭据脱敏、删除有关系资源时返回冲突。
- [ ] 实现 `network-device-database-service.ts`，所有查询使用参数化 SQL；凭据读取只允许内部 collector 使用。
- [ ] 在 `server.ts` 注册并把静态路径放在 `/:id` 之前：
  - `GET /api/network-devices`
  - `GET /api/network-devices/:id`
  - `POST /api/network-devices`
  - `PUT /api/network-devices/:id`
  - `DELETE /api/network-devices/:id`
  - `POST /api/network-devices/test-connection`
- [ ] 所有路由分别使用 `network_devices:view` / `network_devices:manage`，返回 `publicNetworkDeviceDto()`，不返回任何密文。
- [ ] 运行 `pnpm --filter slide-api exec vitest run src/network-devices/network-device-database-service.test.ts src/security/public-dto.test.ts`。

## Task 5: 能力和观测服务扩展

- [ ] 为 `CapabilityService` 增加网络设备 capability key：`snmp.reachability`, `snmp.auth`, `metrics.core`, `interfaces`, `config.backup`。
- [ ] 增加 capability 过期和降级测试，验证未通过 collector 证据不能标记 `verified`。
- [ ] 扩展 `ObservationService` 的资源分派，让网络设备观测从 `network_device_observations`（或同结构的专用 store）读取，并统一输出 `ObservationQuality`、`validUntil` 和 `source`。
- [ ] 标准化 metric ID：`device_uptime_seconds`, `device_cpu_percent`, `device_memory_percent`, `device_temperature_celsius`, `interface_*`。
- [ ] 运行 `pnpm --filter slide-api exec vitest run src/resources/capability-service.test.ts src/resources/resource-service.test.ts src/resources/observation-service.test.ts`。

## Task 6: 基础权限、审计和契约门禁

- [ ] 新增权限 `network_devices:view`, `network_devices:manage`, `network_devices:backup`；默认只给 admin 和专用 network-operator 角色，DBA 默认只读。
- [ ] 在安全事件分类中增加 `network_device_target_denied`, `network_device_backup_denied`。
- [ ] 为配置备份访问绑定 `network_devices:backup` 和审计事件；失败也要记录原因，不记录秘密内容。
- [ ] 更新 security catalog 的 resource 类型映射和公开 DTO 测试。
- [ ] 运行 `pnpm security:test` 中受影响用例和 `pnpm contracts:check`。

## Wave 0 验收

- [ ] 空库和升级库都能重复执行 070 migration。
- [ ] 旧数据库/服务器测试全部通过。
- [ ] 一个无 SNMP/SSH 能力的网络设备可被创建为 `declared/configured`，但不能伪造为 `verified`。
- [ ] 任意未授权网络设备 URL 返回 403 或统一 404，不泄露资源存在性。
