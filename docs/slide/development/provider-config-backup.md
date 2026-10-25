# Provider 配置备份、恢复与脱敏流程

生效日期：2026-10-25。对应 GitHub Issue #244（来源 #8 部署配置漂移的遗留项）。

本文约束 LLM Provider 配置与场景绑定的备份、恢复、回滚和验收。备份只覆盖 `llm_providers` 与 `llm_scene_bindings`；不包含用量、审计历史、其他平台配置或数据库全量备份。

## 1. 产物与安全边界

备份产物是 JSON 文本，包含：

- Provider 的非敏感字段：名称、显示名、部署方式、API 格式、Base URL、默认模型、模型列表、上下文窗口、能力标记、价格、启用/默认状态、温度、输出上限、超时、限流和配额。
- `stored_auth` 布尔值：仅说明备份时该 Provider 是否存有密钥，不包含密钥内容。
- 场景绑定：场景名、Provider 名称、模型；备份时已悬空的绑定保留为 `provider: null` + `dangling_provider_id`，避免恢复后静默改变路由。
- 元数据：格式、版本、生成时间、源数据库名、URL 脱敏记录。
- 同名 `.sha256` 校验文件。

产物**不包含**：

- `api_key_encrypted` 密文或任何明文 API Key；
- 数据库连接口令、主机账号、JWT/加密密钥；
- URL 中的 `user:password@` 与 `api_key`、`token`、`password` 等凭据查询参数。

文件权限固定为 `0600`，失败时不会留下半成品临时文件。CLI 拒绝把产物写入任何 Git 工作树（包括 linked worktree）；这是“备份产物不入仓库”的硬约束，不依赖人工自觉。

产物不是加密文件，但包含 Provider 拓扑与模型配置，仍按敏感运维资料管理：只放在受控目录，不进入版本库、聊天工具、工单附件或公共对象存储。

## 2. 命令与环境

命令从仓库根目录执行：

```bash
# 备份到默认目录（$SLIDE_PROVIDER_CONFIG_BACKUP_DIR，未设置时为 ~/.config/slide/backups/llm-provider-config）
pnpm provider-config backup

# 指定产物路径
pnpm provider-config backup --out "$HOME/.config/slide/backups/llm-provider-config/provider-config-$(date +%Y%m%dT%H%M%S).json"

# 只校验产物：校验和、格式、结构、脱敏
pnpm provider-config verify <artifact.json>

# 与当前数据库比对（只读），可选真实连接测试
pnpm provider-config verify <artifact.json> --against-db --check-connections deepseek

# 恢复演练与执行
pnpm provider-config restore <artifact.json> --dry-run
pnpm provider-config restore <artifact.json> --check-connections all

# 回滚到恢复前快照
pnpm provider-config rollback <artifact.pre-restore.*.json>

# 一次性 MySQL 演练（临时库，自动删除）
pnpm --filter slide-api exec tsx tests/provider-config-backup.mysql.ts
```

数据库连接从 `apps/db-ops-api/.env` 或进程环境读取 `DB_HOST`、`DB_PORT`、`DB_USER`、`DB_PASSWORD`、`DB_NAME`。`--database <name>` 可覆盖库名，主要用于演练或故障切换，不改变写入的凭据来源。

`--out` 与产物参数建议使用绝对路径。`pnpm provider-config` 通过 `pnpm --filter slide-api exec` 运行，相对路径以 `apps/db-ops-api` 为基准；默认输出目录始终是绝对路径。

`--check-connections` 需要 `ENCRYPTION_KEY` 可解密现有密钥。`all` 会对每个已启用且有密钥的 Provider 发一次最小请求（每 Provider 约 50 tokens），无密钥的非本地 Provider 记为 `skipped: true`；显式点名但未配置密钥的 Provider 判为失败。按实际外部调用成本使用。

`--actor` 记录到审计 `username`；默认取 `SLIDE_OPERATOR`、`USER`。生产操作应显式传入可追溯的操作者。

退出码：

| 退出码 | 含义 |
|---|---|
| 0 | 成功 |
| 2 | 参数错误 |
| 3 | 产物缺失、校验和不符、格式/结构非法、检出疑似密钥、路径在仓库内 |
| 4 | 恢复已提交，但配置/场景/连接验证未通过；使用快照回滚 |
| 1 | 数据库、审计写入或其他执行失败 |

## 3. 备份流程

1. 确认连接的是目标环境：核对 `DB_HOST`/`DB_NAME` 与运行实例的 PID → 端口 → cwd → 启动命令，避免从错误工作树或错误库备份。
2. 检查当前 Provider 配置没有正在进行的变更。
3. 执行 `pnpm provider-config backup --out <受控目录>/provider-config-<UTC 时间>.json --actor <操作者>`。
4. 记录输出中的 `sha256`、`provider_count`、`binding_count`、`redactions` 和 `audit_id`。
5. 立即执行 `pnpm provider-config verify <文件>`，要求 `secret_findings: 0`。
6. 将产物与 `.sha256` 一起放入受控备份位置，并在运维记录中登记文件名、校验和、时间、操作者。不要复制到仓库目录。

## 4. 管理员恢复流程

1. **校验产物**：`pnpm provider-config verify <文件>`，确认 `secret_findings: 0`；用手工命令再核对一次校验和：
   ```bash
   cd <产物目录> && shasum -a 256 -c <文件名>.sha256
   ```
2. **确认来源**：检查产物的 `source.database`、`created_at`、Provider 列表和 `redactions`，确认是目标环境、目标时间点的备份。
3. **试运行**：`pnpm provider-config restore <文件> --dry-run`。核对 `create`、`update`、`disable_extra`、`bindings_changed`、`bindings_delete`；计划不符合预期时停止。
4. **执行恢复**：`pnpm provider-config restore <文件> --check-connections all --actor <操作者>`。
   - 恢复前会自动生成 `<产物名>.pre-restore.<UTC 时间>.json` 和 `.sha256`；这是回滚凭据，不得删除。
   - 恢复在单个事务内完成；Provider 与场景绑定的写入、审计记录同事务提交。
5. **核对验证结果**：要求 `verification.ok: true`、`issues` 为空或只有预期的 `DANGLING_BINDING`/`CREDENTIAL_REQUIRED` 警告，并且 `connections[].success: true`。
6. **刷新运行时**：CLI 直接写数据库，运行中的 API 仍持有旧的 Provider 客户端缓存。按 PID → 端口 → cwd 核对本任务实例后优雅重启 API，或通过管理界面重新保存任一 Provider 配置触发热加载。未刷新前不能宣称运行时已生效。
7. **留存审计**：记录 `audit_id`、`verification_audit_id`、快照路径和校验和。

恢复语义：

- Provider 以 `name` 为自然键。存在则更新非敏感字段，**不触碰 `api_key_encrypted`**；不存在则新建，密钥为 `NULL`。
- 数据库中存在但产物中没有的 Provider 只被禁用（`enabled = 0`、`is_default = 0`），不删除、不清空密钥。
- 场景绑定按产物 upsert；产物中没有的绑定删除；悬空绑定按 `dangling_provider_id` 保留并在验证中给出警告。
- 跨环境恢复时，`stored_auth: true` 但当前库没有密钥的 Provider 会出现在 `providers_requiring_auth`；必须在管理界面重新录入密钥，之后重新执行 `verify --against-db --check-connections ...`。
- 同环境恢复保留原密钥；重命名 Provider 会被视为“新建 + 禁用旧项”，旧密钥无法自动关联。

## 5. 回滚

恢复后的验证失败或业务确认异常时：

```bash
pnpm provider-config rollback <artifact.pre-restore.*.json> --actor <操作者>
```

回滚也是一次受校验和保护的恢复，执行后会再次生成自己的预恢复快照和审计记录。回滚会把 Provider、启用/默认状态和场景绑定恢复到**第一次恢复前**的状态。注意：

- 回滚同样不包含密钥，依靠同名 Provider 保留现有密文；
- 备份阶段的 URL 脱敏如果改变了数据库中的 Base URL，快照保存的是脱敏后的值，回滚不会恢复 URL 中的凭据（这是有意的安全行为，凭据应改为独立配置项或由管理员重新录入）。

## 6. 脱敏检查清单

每次备份和恢复前逐项确认：

- [ ] 产物权限为 `0600`，所在目录受控；`stat -f '%Lp' <文件>`（Linux 用 `stat -c '%a'`）。
- [ ] `.sha256` 存在且 `shasum -a 256 -c` 通过。
- [ ] `pnpm provider-config verify <文件>` 输出 `secret_findings: 0`。
- [ ] 文本中不存在 `"api_key"`、`api_key_encrypted`、`v2:<12 hex>:` 密文、`"password"`、`"secret"`、`sk-` 开头的密钥、JWT、`-----BEGIN ... PRIVATE KEY-----`。
- [ ] Base URL 不含 `user:password@`；不含 `api_key`、`token`、`password`、`secret` 等查询参数。若产物有 `redactions`，确认被移除的字段符合预期。
- [ ] Provider 条目只有 `stored_auth` 布尔值，没有密钥内容。
- [ ] `source` 只有数据库名，没有数据库主机、账号或口令。
- [ ] 产物不在 `git status` 中，路径不在任何 Git 工作树内。
- [ ] 审计 `details_json` 只含计数、校验和、Provider 名称与问题码，不含配置值或凭据。
- [ ] 终端输出、截图、工单和聊天记录未粘贴产物内容或密钥。

可用的快速文本检查（不会打印匹配内容）：

```bash
grep -Eq '"api_key"|v2:[0-9a-f]{12}:|"password"|"secret"|-----BEGIN [A-Z ]*PRIVATE KEY-----' <文件> \
  && echo "疑似密钥内容，停止使用" || echo "未发现禁止模式"
```

## 7. 审计记录

备份、恢复、失败和验证都会写入 `audit_log_entries`：

| `event_type` | `action` | 说明 |
|---|---|---|
| `config_backup_access` | `llm_provider_config_backup` | 备份成功；记录产物文件名、SHA-256、大小、数量、脱敏数量 |
| `config_change` | `llm_provider_config_restore` | 恢复成功；记录产物/快照校验和、创建/更新/禁用/绑定数量和待补密钥列表 |
| `config_change` | `llm_provider_config_restore_failed` | 恢复失败；只记录规范化错误码 |
| `config_change` | `llm_provider_config_verify` | 恢复后验证或 `--against-db` 验证；记录问题码和连接测试结果 |

查询最近记录：

```sql
SELECT timestamp_ms, action, result, username, resource_id, details_json
FROM audit_log_entries
WHERE resource_type = 'llm_provider_config'
ORDER BY timestamp_ms DESC
LIMIT 20;
```

审计 `details_json` 不包含明文密钥、密文或连接口令；仍应按内部审计数据限制访问。

## 8. 演练与验收

自动化演练覆盖完整链路：

```bash
pnpm --filter slide-api exec tsx tests/provider-config-backup.mysql.ts
```

预期 5 行 `PASS`：

1. 备份产物不含密钥/密文/URL 凭据，`0600`，含校验和与脱敏记录；
2. 覆盖写保护、仓库路径拒绝、校验和被篡改时拒绝；
3. 恢复写回非敏感字段、保留密文、禁用额外 Provider、恢复绑定并通过验证；
4. 备份/恢复/验证审计行不含密钥；
5. 回滚精确恢复预恢复快照（Provider 字段、启用/默认状态、绑定）。

真实环境验收（同环境、无配置变更）：

1. `backup` 生成产物；
2. `verify` 通过，`secret_findings: 0`；
3. `restore --dry-run` 计划为 `unchanged`，无 create/update/disable；
4. `restore --check-connections <主 Provider>` 返回 `verification.ok: true`、连接 `success: true`；
5. 审计出现 backup / restore / verify 三条记录，`details_json` 无 `v2:` 密文；
6. 产物与快照均在仓库外，权限 `0600`。

演练记录模板：

```text
日期/操作者：
产物：<文件名>  SHA-256：<hash>  大小：
备份：provider_count=  binding_count=  redactions=  audit_id=
恢复：providers_created=  updated=  unchanged=  disabled_extra=
      bindings_upserted=  deleted=  dangling=
快照：<文件名>  SHA-256：
验证：verification.ok=  issues=  connections=
审计：restore audit_id=  verify audit_id=
未完成项/环境限制：
```

## 9. 禁止项

- 禁止把备份产物放进仓库、`.planning`、文档附件、聊天工具、工单或公共存储桶。
- 禁止在产物、日志、审计、截图或工单中写入明文密钥、密文、数据库口令或 URL 凭据。
- 禁止手工修改产物后恢复；校验和、结构校验和脱敏扫描会拒绝。
- 禁止跳过 `.sha256` 校验或使用来源不明的校验和值。
- 禁止不做 `--dry-run` 直接在生产恢复；禁止删除预恢复快照。
- 禁止跨环境恢复后不重新录入密钥、不做连接验证就宣称完成。
- 禁止把 `llm_providers_backup` 等历史临时表或数据库全量 dump 当作本流程的产物与验收依据。
- 禁止在恢复后不刷新运行时缓存（重启 API 或触发配置重载）就宣称已生效。
- 禁止用本流程替代数据库备份、密钥轮换或凭据泄露处置。
- 禁止在 Provider 业务高峰执行恢复：恢复会锁定 Provider 与绑定行直到事务提交。

## 10. 故障处理

| 现象 | 处理 |
|---|---|
| `CHECKSUM_MISSING` / `CHECKSUM_MISMATCH` | 从受控备份位置重新取产物与 `.sha256`；不要手工补校验和 |
| `SECRET_DETECTED` | 产物按泄露处理：停止使用、删除、按密钥泄露流程处置；不要打印或上传内容 |
| `INVALID_ARTIFACT` / `UNSUPPORTED` | 版本或结构不匹配；使用对应版本的 CLI，不要手改 |
| `PROVIDER_CONFIG_BACKUP_PATH_INSIDE_REPOSITORY` | 改到仓库外的受控目录 |
| `CREDENTIAL_REQUIRED` | 在管理界面重新录入密钥，再执行 `verify --against-db --check-connections` |
| `CONNECTION_CHECK_FAILED` | 先核对网络、Base URL、模型与供应商状态；连接失败不等于配置恢复失败，但未通过不得宣称“连接可用” |
| `DANGLING_BINDING` | 备份时即存在；恢复保留悬空引用，由管理员重新绑定场景 |
| 恢复验证失败 | 使用自动生成的预恢复快照执行 `rollback`，保留输出和审计记录 |
| 审计写入失败 | 备份会保留已写产物并报错；恢复在事务内失败会回滚。修复审计表/连接后重试 |
