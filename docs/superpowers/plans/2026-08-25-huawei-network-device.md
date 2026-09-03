# 华为网络设备运维能力实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended; one task per fresh worker) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为华为 VRP 网络设备提供 SNMPv3 只读监控、设备级告警、资源关系和加密配置备份，并将这些证据接入 Slide 的基础运维 Agent。

**Architecture:** 使用 `net-snmp` 作为 SNMPv3 command generator，使用现有 `ssh2` 和 host-key verifier 采集配置。标准 MIB-II/IF-MIB 负责通用系统和接口指标，华为 enterprise MIB 通过版本化 OID catalog 提供 CPU、内存和温度映射。所有采集器只写观测和备份，不执行设备配置变更。

**Tech Stack:** TypeScript, Fastify, MySQL, `net-snmp`, `@types/net-snmp`, `ssh2`, Lit 3.3, Vitest, Playwright。

---

## 协议和安全决策

- 只接受 SNMPv3；默认 `authPriv`，`authNoPriv` 只有在显式策略允许时可保存；拒绝 v1/v2c。
- 认证协议支持 SHA，隐私协议支持 AES；MD5/DES 仅为兼容旧设备时由管理员显式启用并产生审计事件。
- 标准 OID 使用 `SNMPv2-MIB`、`IF-MIB`、`HOST-RESOURCES-MIB` 可验证项；华为指标必须来自随版本提交的 Huawei VRP MIB fixture，不在代码中硬编码未经验证的数值。
- 配置备份使用 SSH 只读流程：连接后设置临时分页 `screen-length 0 temporary`，执行 `display current-configuration`，不执行 `save`、`undo`、`system-view` 或任意用户命令。
- SNMP 和 SSH 目标均经过 allowlist/CIDR 和端口策略；UDP 超时、响应大小、walk 深度和并发数全部有上限。

## 文件清单

**Create**

- `apps/db-ops-api/src/network-devices/snmp-types.ts`
- `apps/db-ops-api/src/network-devices/snmp-client.ts`
- `apps/db-ops-api/src/network-devices/snmp-client.test.ts`
- `apps/db-ops-api/src/network-devices/huawei-mib-catalog.ts`
- `apps/db-ops-api/src/network-devices/huawei-mib-catalog.test.ts`
- `apps/db-ops-api/src/network-devices/huawei-adapter.ts`
- `apps/db-ops-api/src/network-devices/huawei-adapter.test.ts`
- `apps/db-ops-api/src/network-devices/network-device-collector.ts`
- `apps/db-ops-api/src/network-devices/network-device-collector.test.ts`
- `apps/db-ops-api/src/network-devices/network-device-alert-evaluator.ts`
- `apps/db-ops-api/src/network-devices/network-device-alert-evaluator.test.ts`
- `apps/db-ops-api/src/network-devices/config-backup-service.ts`
- `apps/db-ops-api/src/network-devices/config-backup-service.test.ts`
- `apps/db-ops-api/src/network-devices/network-device-routes.test.ts`
- `frontend/src/app/ui/views/network-devices-page.ts`
- `frontend/src/app/ui/views/network-device-detail.ts`
- `frontend/src/app/ui/components/network-interface-table.ts`
- `frontend/src/app/ui/components/network-config-backups.ts`
- `frontend/src/app/ui/views/network-devices-page.test.ts`
- `frontend/src/app/ui/views/network-device-detail.test.ts`
- `frontend/e2e/huawei-network-device.spec.ts`

**Modify**

- `apps/db-ops-api/package.json`
- `pnpm-lock.yaml`
- `apps/db-ops-api/server.ts`
- `apps/db-ops-api/src/network-devices/network-device-database-service.ts`
- `apps/db-ops-api/src/resources/observation-service.ts`
- `apps/db-ops-api/src/metric-registry.ts`
- `apps/db-ops-api/src/alert-database-service.ts`
- `apps/db-ops-api/src/alert-rule-template-service.ts`
- `apps/db-ops-api/src/contracts/public-api.ts`
- `apps/db-ops-api/src/contracts/generate-public-api.ts`
- `apps/db-ops-api/src/tools/generated/slide-self-mgmt/index.ts`
- `frontend/src/app/ui/navigation.ts`
- `frontend/src/app/ui/app.ts`
- `frontend/src/app/ui/app-render.ts`
- `frontend/src/app/i18n/locales/zh-CN.ts`
- `frontend/src/app/i18n/locales/en.ts`

## Task 1: 依赖和 SNMP session seam

- [ ] 在 `apps/db-ops-api/package.json` 添加锁定版本 `net-snmp@3.26.3` 和 `@types/net-snmp@3.23.0`，运行 `pnpm install --lockfile-only` 并检查无不相关 lockfile 漂移。
- [ ] 在 `snmp-types.ts` 定义 `SnmpV3Config`, `SnmpVarbind`, `SnmpTableRow`, `SnmpProbeResult` 和稳定错误码：`SNMP_TIMEOUT`, `SNMP_AUTH_FAILED`, `SNMP_UNSUPPORTED_SECURITY`, `SNMP_RESPONSE_INVALID`, `SNMP_TARGET_DENIED`。
- [ ] 在 `snmp-client.ts` 封装 `net-snmp.createV3Session()`、`get()`、`table()` 和 `close()`；禁止调用 `set()`，将 timeout、retries、maxRepetitions 固定在配置边界内。
- [ ] 用 fake session 测试 authPriv/authNoPriv 参数映射、超时、错误码、varbind 类型校验、响应大小限制和 close 必达。
- [ ] 运行 `pnpm --filter slide-api exec vitest run src/network-devices/snmp-client.test.ts`。

## Task 2: 华为 MIB catalog 和适配器

- [ ] 在 `huawei-mib-catalog.ts` 建立版本化 catalog，至少包含：
  - `sysUpTime`, `sysName`, `sysDescr`。
  - `ifIndex`, `ifDescr`, `ifAlias`, `ifSpeed`, `ifAdminStatus`, `ifOperStatus`。
  - 64 位优先的 `ifHCInOctets`, `ifHCOutOctets`，以及错误、丢弃计数；设备不支持 HC 时使用 32 位回退。
  - Huawei VRP CPU、内存、温度 OID 的符号名、单位、索引规则和 fixture 版本。
- [ ] 任何华为专用 OID 必须有 JSON fixture：原始 varbind、期望单位、转换公式和固件版本；没有 fixture 的指标状态为 `unsupported`，不能伪造 0。
- [ ] 在 `huawei-adapter.ts` 实现 `probe()`, `collectSystemMetrics()`, `collectInterfaces()`；返回 `CapabilityState`、质量、缺失原因和采集时间。
- [ ] 实现 counter delta：处理 32/64 位回绕、设备重启和负 delta；转换为 bytes/sec、errors/sec、drops/sec 时保留原始计数。
- [ ] 用华为 fixture 测试 CPU/内存/温度单位、接口状态映射、counter 回绕、空值和未知固件。
- [ ] 运行 `pnpm --filter slide-api exec vitest run src/network-devices/huawei-mib-catalog.test.ts src/network-devices/huawei-adapter.test.ts`。

## Task 3: 设备连通性和纳管路由

- [ ] 在 `network-device-database-service.ts` 增加 SNMPv3/SSH credential reference 的创建、轮换、删除和内部解密接口；外部 DTO 永远只返回 `hasCredential`、算法和版本。
- [ ] 在 `server.ts` 注册静态路径优先的路由：
  - `POST /api/network-devices/test-connection`
  - `POST /api/network-devices/:id/probe`
  - `GET /api/network-devices/:id/capabilities`
- [ ] `test-connection` 必须同时验证 allowlist、SNMPv3 身份和（启用备份时）SSH host key；错误信息不得回显 secret。
- [ ] probe 成功只能将 capability 置为 `verified`，失败将其置为 `degraded` 并记录稳定 reason code。
- [ ] 编写 route tests：未授权、错误 vendor、v1/v2c payload、CIDR 拒绝、重复设备、SNMP auth 失败和主机密钥不匹配。
- [ ] 运行 `pnpm --filter slide-api exec vitest run src/network-devices/network-device-database-service.test.ts src/network-devices/network-device-routes.test.ts src/security/server-target-policy.test.ts src/security/ssh-host-key.test.ts`。

## Task 4: 采集 uptime、系统和接口指标

- [ ] 在 `network-device-collector.ts` 实现可停止的定时采集器；按指标定义的采集频率调度，单设备任务互斥。
- [ ] 每轮先做 sysUpTime/身份 probe，再采集 CPU、内存、温度；系统指标写入 `network_device_observations`。
- [ ] 使用 IF-MIB table 发现和 upsert 接口快照，写入 `network_device_interfaces`；随后采集入出流量、errors、discards，写入带 `if_index` 和 `direction` dimensions 的 observation。
- [ ] 记录 `source=snmpv3`, `quality=good|degraded|unknown`、raw counter timestamp；单设备响应和 table 行数有上限。
- [ ] 设备连续失败时更新 `status=unreachable` 并触发 capability degraded；成功后恢复 online，区分认证失败和网络超时。
- [ ] 测试并发互斥、失败恢复、接口新增/删除、无 HC 回退、温度缺失、SNMP table 截断和时钟回退。
- [ ] 运行 `pnpm --filter slide-api exec vitest run src/network-devices/network-device-collector.test.ts src/resources/observation-service.test.ts`。

## Task 5: 设备级告警

- [ ] 在 `metric-registry.ts` 注册：`device_uptime_seconds`, `device_cpu_percent`, `device_memory_percent`, `device_temperature_celsius`, `interface_oper_status`, `interface_error_rate`, `interface_drop_rate`, `interface_in_bps`, `interface_out_bps`。
- [ ] 在 `alert-rule-template-service.ts` 增加华为设备模板：设备不可达、CPU/内存/温度超阈值、接口 down、错误/丢弃率超阈值。
- [ ] 在 `network-device-alert-evaluator.ts` 沿用现有 compiled rule/duration/dedup 机制，告警目标写入 `network_device_id`，接口告警必须带 dimensions。
- [ ] 更新 alerts API 和前端 filter，目标类型显示“网络设备”，目标名称和接口名称可跳转。
- [ ] 测试阈值、持续时间、恢复、去重、设备和接口告警并存、未知指标不误报。
- [ ] 运行 `pnpm --filter slide-api exec vitest run src/network-devices/network-device-alert-evaluator.test.ts src/alert-evaluator.test.ts`。

## Task 6: 配置备份服务

- [ ] 在 `config-backup-service.ts` 实现固定 SSH 流程：获取设备 credential、校验 host key、执行临时分页命令和 `display current-configuration`；禁止调用任意用户输入命令。
- [ ] 设置每次连接 30 秒、输出 2 MiB、单设备并发 1；超限立即中止并记录 `CONFIG_OUTPUT_LIMIT`，不保存半截配置为成功版本。
- [ ] 对原文执行敏感字段识别，生成脱敏预览；原文用 `encryptData()` 存 `content_encrypted`，SHA-256 对原文计算 `content_sha256`，日志只记 hash 和大小。
- [ ] 同一 hash 不重复生成版本；新版本使用单调 `version_no`，保存 `source_protocol`, `collected_at`, `created_by`, `redaction_status`。
- [ ] 在 `server.ts` 增加：
  - `POST /api/network-devices/:id/config-backups`（`network_devices:backup`）
  - `GET /api/network-devices/:id/config-backups`（`network_devices:view`）
  - `GET /api/network-devices/:id/config-backups/:backupId`（元数据同 view；原文下载需 backup 权限并记录审计）
  - `GET /api/network-devices/:id/config-backups/:backupId/diff`（只比较脱敏文本，大小限制 512 KiB）
- [ ] 测试分页命令、host key、输出上限、secret 脱敏、加密/解密、hash 去重、越权 ID、删除级联和审计失败路径。
- [ ] 运行 `pnpm --filter slide-api exec vitest run src/network-devices/config-backup-service.test.ts src/security/sensitive-data.test.ts src/security/log-redaction.test.ts`。

## Task 7: 资源关系和公共 API

- [ ] 增加关系 API：`GET /api/network-devices/:id/relations`、`PUT /api/network-devices/:id/relations`，复用 ResourceService 的事务和有效期模型。
- [ ] 支持设备-服务器 `connected_to`，设备-数据库 `depends_on/serves` 只通过已存在服务器关系间接展示，避免伪造直接链路。
- [ ] 更新 OpenAPI/生成的前端 client，补齐设备、接口、观测、能力、备份和关系类型。
- [ ] 测试关系权限、重复边、过期边、删除保护、实例级访问范围过滤。
- [ ] 运行 `pnpm contracts:generate && pnpm contracts:check` 以及 `src/resources/*test.ts`。

## Task 8: 前端网络设备工作台

- [ ] 新增 `network-devices` 顶级导航和 `/network-devices` 路径；更新 `app.ts` URL allowlist、`app-render.ts` import/render、`navigation.ts` 权限映射和中英文 locale。
- [ ] `network-devices-page.ts` 提供库存、厂商/站点/状态筛选、SNMPv3 测试、采集状态和配置备份入口；写操作 UI 只包含纳管/凭据/备份采集，不出现配置下发按钮。
- [ ] `network-device-detail.ts` 提供概览、系统指标、接口、告警、关系、配置备份标签；温度和接口状态缺失时显示 quality/reason。
- [ ] `network-interface-table.ts` 使用 `<app-data-table>`、`<app-badge>` 和稳定列宽；支持接口名称、admin/oper、入出速率、errors/drops。
- [ ] `network-config-backups.ts` 只显示版本、hash、时间、大小、脱敏状态和 diff；原文下载有确认、权限和 toast。
- [ ] 测试空列表、认证失败、长接口名、超长配置、移动视口、无温度 OID、越权备份和关系跳转。
- [ ] 运行 `cd frontend && npx vitest run src/app/ui/views/network-devices-page.test.ts src/app/ui/views/network-device-detail.test.ts && npm run typecheck && npm run build`。

## Task 9: Agent 只读工具

- [ ] 新增 `list_network_devices`, `get_network_device_metrics`, `get_network_device_interfaces`, `get_network_device_alerts`, `list_network_device_backups`。
- [ ] 备份工具默认只返回 metadata 和脱敏 preview；原文读取需要显式 `network_devices:backup`、资源绑定和短时 credential reference。
- [ ] 在 security catalog 声明 `effect=read`, `network=registered-network-device`, `credentials=use`，不注册 SNMP SET 或 CLI execute。
- [ ] 测试 actor scope、工具发现、参数边界、敏感字段、审计和 DirectAdapter registry coverage。
- [ ] 运行 `pnpm --filter slide-api exec vitest run src/tools/security-catalog.test.ts src/tools/resource-filtering.test.ts src/tools/credential-bound-tools.test.ts src/adapter/__tests__/direct-adapter.test.ts`。

## Task 10: 华为真实设备 UAT

- [ ] 准备一台可回滚的华为 VRP 实验设备：SNMPv3 authPriv 用户、只读视图、SSH 只读账户、已登记 host key、允许的管理网段。
- [ ] 验证成功和失败的 SNMPv3 auth、UDP timeout、设备重启后的 uptime/counter、接口 flap、error/drop 告警和配置版本变化。
- [ ] 验证配置备份原文不能从普通 view 权限 API 获取，backup 权限下载有审计，备份 hash 可重复验证。
- [ ] 将真实设备型号、VRP 版本、MIB fixture 和测试时间写入 `docs/slide/USER-GUIDE.md`/UAT 记录；没有实验设备时标记为 blocked，不把 fixture 测试当作真实支持。

## Wave 1 验收

- [ ] 华为设备的 8 项监控能力和配置备份均有 API、UI、Agent 和 focused test 证据。
- [ ] SNMPv3 只读采集不会调用 SET；SSH 备份不会执行持久配置变更。
- [ ] 所有敏感数据在数据库、日志、API、Agent 和前端均满足脱敏/加密要求。
- [ ] 真实设备 UAT 和完整安全门禁通过后，才允许在产品文档中标记“华为网络设备支持”。
