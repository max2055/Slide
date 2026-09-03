# 环境变量依赖审计

本审计覆盖生产运行代码和部署清单；测试、qualification 脚本以及 npm/Vite 自带变量不计入产品配置。

## 结论

环境变量应只承载进程启动前必须确定、不能安全写入数据库，或由部署边界控制的配置。需要管理员日常调整、应持久化并在线生效的产品策略应进入 `system_config`。

本次已将以下配置迁移到系统设置，默认值保持原来的 300 秒：

| 原环境变量 | 系统设置键 | 生效方式 |
| --- | --- | --- |
| `SERVER_COLLECTION_INTERVAL_MS` | `monitor.server_collection_interval_seconds` | 保存后重置服务器采集定时器 |
| `NETWORK_DEVICE_COLLECTION_INTERVAL_MS` | `monitor.network_device_collection_interval_seconds` | 保存后重置网络设备采集定时器 |

管理员可在“设置 > 采集设置”中维护这两项。取值范围为 10 至 86400 秒。

## 保留为环境变量

| 类别 | 变量 | 评估 |
| --- | --- | --- |
| 基础设施连接 | `DB_HOST`、`DB_PORT`、`DB_USER`、`DB_PASSWORD`、`DB_NAME` | 控制面数据库建立前即需要，不能依赖 `system_config` |
| 监听与进程角色 | `PORT`、`BACKEND_PORT`、`API_PORT`、`AGENT_WS_PORT`、`NODE_ENV` | 进程启动和编排层配置 |
| 密钥与首次引导 | `JWT_SECRET_KEY`、`ENCRYPTION_KEY`、`AGENT_APPROVAL_HMAC_KEY`、`INITIAL_ADMIN_USERNAME`、`INITIAL_ADMIN_PASSWORD` | 不应明文持久化到业务配置表 |
| 沙箱边界 | `SANDBOX_CONTROLLER_URL`、`SANDBOX_CONTROLLER_SECRET`、`SANDBOX_IMAGES`、`SANDBOX_EXECUTION_PROFILES`、`SANDBOX_WORKSPACE_ROOT`、`SANDBOX_RESTRICTED_NETWORK`、`SANDBOX_NETWORK_IMAGE`、`SANDBOX_MAX_CONCURRENT_JOBS`、`SANDBOX_CONTROLLER_PORT` | 独立进程和部署安全边界，应用设置不应削弱它 |
| 出站与运行时防护 | `OUTBOUND_ALLOWED_HOSTS`、`CORS_ORIGINS`、`AGENT_WS_MAX_PAYLOAD_BYTES`、`AGENT_WS_FRAMES_PER_WINDOW`、`AGENT_WS_RATE_WINDOW_MS`、`AGENT_WS_AUTH_TIMEOUT_MS`、`AGENT_MAX_MESSAGE_CHARS`、`AGENT_MAX_CONCURRENT_RUNS`、`AGENT_RUN_TIMEOUT_MS`、`AGENT_MAX_ITERATIONS`、`AGENT_MAX_TOOL_RESULT_CHARS` | 部署级安全上限，修改应经过重启和运维审查 |
| 文件与可执行资源 | `AGENT_WORKSPACE`、`PROMPT_VERSIONS_DIR`、`AGENT_SKILL_DIRS`、`AGENT_SKILL_DIGESTS`、`AGENT_SKILL_ALLOWLISTS`、Oracle 客户端相关变量 | 与挂载、镜像或可信文件边界绑定 |
| 外部服务引导 | `ANTHROPIC_API_KEY`、`ANTHROPIC_MODEL` | 保留为未配置数据库提供商时的兼容回退；日常模型配置优先使用模型配置页 |
| Agent Core 兼容参数 | `NANOBOT_LLM_TIMEOUT_S`、`NANOBOT_STREAM_IDLE_TIMEOUT_S`、`AGENT_LOOP_THRESHOLD` | 库级/进程级保护参数，调用方显式配置优先 |
| 提示词部署选择 | `PROMPT_VERSION`、`PROMPT_AB_TEST`、`PROMPT_HOT_RELOAD`、`ANALYSIS_MODEL_VERSION` | 版本选择、审计标签和文件监听行为，属于发布配置 |

技能清单声明的任意动态密钥变量也继续由环境注入；这类名称来自技能元数据，不能安全地统一迁入业务配置表。

## 后续适合迁移的产品策略

`SESSION_RETENTION_DAYS`、`SESSION_MAX_MESSAGES`、`SESSION_CLEANUP_BATCH_SIZE` 控制会话数据生命周期和清理批次，性质上属于管理员策略。建议后续迁入独立的“数据保留”系统设置，并在迁移前补齐删除影响说明、上下限和审计记录；它们不与采集频率共用接口，避免把不相关策略耦合在一次更新中。

## 已排除

`QUALIFICATION_*`、`SMOKE_*`、`PLAYWRIGHT_*`、`VITE_*`、`npm_package_version` 仅服务测试、构建或包元数据，不属于运行中的系统设置。
