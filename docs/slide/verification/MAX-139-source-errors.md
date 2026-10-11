# MAX-139 源码错误整改验证

执行契约 v1（2026-10-11）：配置加载/保存、凭据保存/删除、Git 同步、快照和关联源码读取；排除 OAuth、自动续期、同步重写、生产部署、密钥生成/轮换和全站错误系统。60 分钟主动工作预算，零子代理。达到 30/48/60 分钟分别报告、停止扩展、保存检查点并停止新增工作；外部权限或必需 review 阻塞时保留恢复点。

起点：origin/main b16a752，隔离 worktree，分支 codex/MAX-139-source-errors。范围未变更（v1）。实际 raw/cached/output token 与费用：当前执行未上报，平台返回零个计量任务，标为不可用，不能视为零消耗。代理总数/深度/并发峰值：0/0/1。Goal 内部预算账本未建立，不作为真实吞吐。

## 行为与兼容性

- SOURCE_SIGNING_KEY_INVALID 保留机器码，HTTP 由 400 修正为 503；管理员详情说明 SLIDE_SOURCE_SIGNING_KEY 至少 32 字节。服务先验签名配置再拉取 Git，不读取真实密钥、不自动轮换。
- 认证拒绝沿用 SOURCE_CREDENTIAL_INVALID；有证据的权限/限流新增 SOURCE_UPSTREAM_PERMISSION_DENIED / SOURCE_UPSTREAM_RATE_LIMITED；裸 403 为 SOURCE_UPSTREAM_FORBIDDEN，不断言令牌过期。404 保留路径/私有仓库权限歧义。
- 本地 tokenExpiresAt 是本次同步授权窗口，不能证明 PAT 有效期；“已保存”明确尚未验证可用。
- API 与源码日志只接受显式错误码清单；前端只接受有界目录，不回显 HTML、stderr、堆栈、任意未知码或异常文本。未知响应使用稳定受控技术标识。
- 配置/令牌写操作不盲目重试；认证引导令牌字段、引用/配置引导字段，签名/加密故障引导管理员。只有暂时性 GET 或符合凭据/配置要求的同步提供对应重试。
- 同步失败不递增前端快照 revision；保存配置使旧快照失效。加载最新配置保留未保存字段；busy 与权限约束保留。原有已保存凭据不因认证失败而删除。
- GitHubSourceConnector / GitLabSourceConnector 为 deprecated REST 类，无生产调用，仅保留旧测试，不扩展修改。

## 覆盖矩阵

| 验收 | 证据 |
| --- | --- |
| 空/短签名密钥先于 Git，保留凭据和快照 | source-credential.test.ts 参数化回归；source-routes.test.ts 503；source-settings/source-manifest tests；Playwright 签名场景 |
| 认证、403 权限/歧义/限流、404、引用、网络/代理/TLS/存储 | git-source-connector.test.ts 受控 stderr fixtures；不向真实平台发送秘密 |
| 所有在用后端码有中文原因和恢复约定 | source-errors.test.ts 全目录参数化 + 后端清单覆盖断言；下表 |
| 未知码/文本、HTML、网络、安全详情 | source-errors.test.ts；source-manifest.test.ts；Playwright UNKNOWN_UPSTREAM/HTML_RESPONSE |
| 失败不丢原凭据与成功快照 | source-credential.test.ts + source-settings.test.ts + Playwright 认证场景 |
| 换令牌恢复、清错、状态/快照刷新 | Playwright 四种错误恢复场景；source-settings.test.ts |
| busy 防重复与未保存配置/只读限制 | source-settings.test.ts、source-credential.test.ts、既有 source-sync.spec.ts 移动/桌面 GitHub/GitLab 场景 |
| 重载保留其他输入、快照重试 | source-settings.test.ts 脏字段重载；source-manifest.test.ts HTML 后 GET 重试 |

## 有界错误目录

所有条目均由 source-errors.test.ts 验证中文主提示无 SOURCE_/Error:，未知值不回显；后端新增码由 source-routes.test.ts 验证响应分类。

| 错误码 | 中文主提示 | 恢复约定 |
| --- | --- | --- |
| `SOURCE_SIGNING_KEY_INVALID` | 服务端源码快照签名配置不完整，请联系管理员检查配置后重试 | admin |
| `SOURCE_CREDENTIAL_INVALID` | 无法读取{platform}仓库，令牌可能已过期、被撤销或缺少仓库读取权限。请输入新令牌后同步；需要保留时点击“替换已保存令牌”。 | token |
| `SOURCE_CREDENTIAL_EXPIRED` | 本次源码同步授权窗口已结束，请重新输入令牌后同步；这不代表平台令牌已过期。 | token |
| `SOURCE_UPSTREAM_FORBIDDEN` | {platform}拒绝读取仓库，可能是令牌无效、缺少读取权限或平台访问策略限制。请检查权限，必要时输入新令牌。 | token |
| `SOURCE_UPSTREAM_PERMISSION_DENIED` | {platform}明确拒绝仓库读取权限，请检查令牌的仓库范围和读取权限后重新同步。 | token |
| `SOURCE_UPSTREAM_RATE_LIMITED` | {platform}暂时限制访问频率，请稍后重新同步。 | retry |
| `SOURCE_REPOSITORY_NOT_FOUND` | 无法找到或读取{platform}仓库，请检查仓库路径及令牌读取权限；私有仓库无权访问也可能返回此错误。 | config |
| `SOURCE_REF_NOT_FOUND` | 无法读取指定分支、标签或提交，请修正引用并保存配置后重新同步。 | config |
| `SOURCE_REF_INVALID` | 分支、标签或提交格式不正确，请修正对应字段并保存。 | config |
| `SOURCE_CONFIG_INVALID` | 源码仓库配置不正确，请检查平台地址、仓库路径、Git 用户名、代理和源码目录格式后保存。 | config |
| `SOURCE_REPOSITORY_PATH_REQUIRED` | 旧 GitLab 数字 ID 已失效，请重新填写平台地址和仓库路径并保存。 | config |
| `SOURCE_ORIGIN_DENIED` | 平台地址格式不正确或不在服务端允许范围，请检查实例根地址；需要新增地址时联系管理员。 | config |
| `SOURCE_CONFIG_CHANGED` | 仓库配置已发生变化，请加载最新配置并核对后保存；当前未保存输入会保留。 | reload |
| `SOURCE_NOT_CONFIGURED` | 尚未配置源码仓库。请先填写平台地址和仓库路径并保存。 | config |
| `SOURCE_NOT_SYNCED` | 当前仓库和分支尚未同步，请先同步源码。 | sync |
| `SOURCE_SAVED_CREDENTIAL_UNAVAILABLE` | 已保存令牌无法解密，请输入新令牌并替换已保存令牌；仍失败时联系管理员检查加密配置。 | token |
| `SOURCE_CREDENTIAL_ENCRYPTION_UNAVAILABLE` | 服务端令牌加密配置不可用，请联系管理员检查加密密钥后重试。 | admin |
| `SOURCE_STORAGE_UNAVAILABLE` | 服务端源码存储不可用，请联系管理员检查数据库和存储后重试。 | admin |
| `SOURCE_SNAPSHOT_UNTRUSTED` | 源码快照校验未通过，暂时无法读取。请联系管理员检查签名和存储，确认后重新同步。 | admin |
| `SOURCE_SNAPSHOT_POLICY_CHANGED` | 源码读取策略已变化，请核对并保存配置后重新同步。 | config |
| `SOURCE_COMMIT_MISMATCH` | 获取的提交与预期不一致，请检查提交引用后重新同步。 | config |
| `SOURCE_SYNC_DEADLINE` | 源码同步超时，请检查网络或代理后重新同步。 | retry |
| `SOURCE_UPSTREAM_UNAVAILABLE` | 无法连接代码托管平台，请检查网络、代理或 TLS 证书后重新同步。 | retry |
| `SOURCE_SYNC_BUSY` | 服务端正在同步源码，请等待当前同步结束后重试。 | retry |
| `SOURCE_READ_BUSY` | 源码读取请求繁忙，请稍后重试。 | retry |
| `SOURCE_RATE_LIMITED` | 源码请求过于频繁，请稍后重试。 | retry |
| `SOURCE_ADMIN_REQUIRED` | 当前账号没有源码管理权限，请联系管理员。 | none |
| `SOURCE_READ_FORBIDDEN` | 当前账号没有源码读取权限，请联系管理员。 | none |
| `SOURCE_MODEL_EGRESS_DENIED` | 当前配置未允许模型读取源码，请由管理员检查模型读取设置。 | none |
| `SOURCE_PATH_NOT_ALLOWED` | 文件不在允许读取的源码目录内，请检查源码范围配置。 | config |
| `SOURCE_PATH_INVALID` | 源码文件路径不受支持，请选择允许目录内的文本源码文件。 | none |
| `SOURCE_QUERY_INVALID` | 源码搜索条件不正确，请修正搜索条件。 | none |
| `SOURCE_SYMBOL_INVALID` | 源码符号名称不正确，请修正名称。 | none |
| `SOURCE_REGION_INVALID` | 源码行号范围不正确，请修正起止行号。 | none |
| `SOURCE_REGION_TOO_LARGE` | 源码读取范围过大，请缩小行号范围。 | none |
| `SOURCE_FILE_COUNT_INVALID` | 没有可同步的源码文件或文件数量超限，请调整允许的源码目录并保存。 | config |
| `SOURCE_SNAPSHOT_TOO_LARGE` | 源码快照超过 32MiB 容量上限，请缩小允许的源码目录后重新同步。 | config |
| `SOURCE_FILE_TOO_LARGE` | 源码文件超过容量上限，请缩小同步范围。 | config |
| `SOURCE_BINARY_FILE` | 该文件不是可读取的文本源码，请选择其他文件。 | none |
| `SOURCE_CONTENT_INVALID` | 源码内容无法读取，请联系管理员检查快照存储。 | admin |
| `SOURCE_DUPLICATE_PATH` | 源码快照存在重复路径，请联系管理员检查同步结果。 | admin |
| `SOURCE_IDENTITY_INVALID` | 源码快照标识不正确，请联系管理员检查同步结果。 | admin |
| `SOURCE_RELEASE_INVALID` | 源码快照版本标识不正确，请联系管理员检查同步结果。 | admin |
| `SOURCE_SYNC_FAILED` | 源码同步失败，请稍后重新同步；持续失败时联系管理员并提供技术标识。 | retry |
| `SOURCE_READ_FAILED` | 源码读取失败，请稍后重试；持续失败时联系管理员并提供技术标识。 | retry |
| `SOURCE_UNAVAILABLE` | 源码服务暂时不可用，请稍后重试；持续失败时联系管理员并提供技术标识。 | retry |
| `SOURCE_NETWORK_ERROR` | 无法连接源码服务，请检查网络后重试。 | retry |
| `SOURCE_RESPONSE_INVALID` | 源码服务返回了无法识别的响应，请稍后重试；持续失败时联系管理员。 | retry |
| `SOURCE_SESSION_REQUIRED` | 登录状态已失效，请重新登录后操作源码。 | none |

## 复现命令

```sh
pnpm --filter slide-api exec vitest run src/platform/source-routes.test.ts src/platform/source-management-service.test.ts src/platform/git-source-connector.test.ts src/platform/source-credential.test.ts src/platform/source-snapshot-service.test.ts
pnpm --filter slide-frontend exec vitest run src/app/ui/views/source-settings.test.ts src/app/ui/views/source-errors.test.ts src/app/ui/views/source-manifest.test.ts
pnpm --filter slide-frontend exec playwright test source-sync.spec.ts --config playwright.audit.config.ts
pnpm --filter slide-api typecheck
pnpm --filter slide-frontend typecheck
pnpm --filter slide-frontend build
```

Focused 结果：后端 84、前端 87、浏览器 10 全部通过。浏览器截图：MAX-139-SOURCE_SIGNING_KEY_INVALID.png、MAX-139-SOURCE_CREDENTIAL_INVALID.png、MAX-139-UNKNOWN_UPSTREAM.png、MAX-139-HTML_RESPONSE.png，通过 Multica 评论附件交付。最终 gate 和 CI head/合并证据以 PR 与任务最终评论为准，不在代码中声称未取得的 CI 结果。

## 最终集成候选本地门禁

一次集成 gate：backend 3106 passed / 254 条件 skipped；frontend 757 passed；agent-core 675 passed；sandbox-controller 22 passed / 4 条件 skipped；完整 audit 浏览器 120 passed。四模块 typecheck、contracts:check、qualification:matrix、lint（0 errors）、frontend build/CSP、security:audit、security:scan 均通过。

无关失败：`bash scripts/qualification/run-agent-runtime.sh --mode deterministic` 的重复检测 benchmark p95 115.872ms（要求 <50ms）；实现与测试文件未改，源码链路无调用关系，不扩大修复范围。该测试在多模块并行门禁负载下运行，不能据此断言源码整改引入性能退化；远端 Linux CI 仍需核实。

共享提示最终采用已有 app-notice，仅重跑受影响的前端 focused tests、typecheck/build 与源码浏览器场景；不重复全量 gate。Linux MySQL/恢复/制品资格门禁交由同一 PR CI 执行，未将本地条件跳过当成通过。
