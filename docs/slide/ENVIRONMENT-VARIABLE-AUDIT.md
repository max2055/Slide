# 环境变量依赖审计

本审计覆盖生产运行代码和部署清单；测试、qualification 脚本以及 npm/Vite 自带变量不计入产品配置。

## 结论

环境变量只承载进程启动前必须确定、不能安全写入数据库，或由部署边界控制的配置。管理员日常调整的业务策略应由对应领域模型持久化，而不是重复放入环境变量或通用系统设置。

`SERVER_COLLECTION_INTERVAL_MS` 和 `NETWORK_DEVICE_COLLECTION_INTERVAL_MS` 已删除。服务器、数据库实例和网络设备统一使用 `metric_definitions.default_interval` 作为采集频率来源；采集器内部的短周期心跳只扫描到期指标，不代表业务采集频率，也不对外配置。

## 保留为环境变量

| 类别 | 变量 | 评估 |
| --- | --- | --- |
| 基础设施连接 | `DB_HOST`、`DB_PORT`、`DB_USER`、`DB_PASSWORD`、`DB_NAME` | 控制面数据库建立前即需要，不能依赖数据库内配置 |
| 监听与进程角色 | `PORT`、`BACKEND_PORT`、`API_PORT`、`AGENT_WS_PORT`、`NODE_ENV` | 进程启动和编排层配置 |
| 密钥与首次引导 | `JWT_SECRET_KEY`、`ENCRYPTION_KEY`、`AGENT_APPROVAL_HMAC_KEY`、`INITIAL_ADMIN_USERNAME`、`INITIAL_ADMIN_PASSWORD` | 不应明文持久化到业务配置表 |
| 沙箱边界 | `SANDBOX_CONTROLLER_URL`、`SANDBOX_CONTROLLER_SECRET`、`SANDBOX_IMAGES`、`SANDBOX_EXECUTION_PROFILES`、`SANDBOX_WORKSPACE_ROOT`、`SANDBOX_RESTRICTED_NETWORK`、`SANDBOX_NETWORK_IMAGE`、`SANDBOX_MAX_CONCURRENT_JOBS`、`SANDBOX_CONTROLLER_PORT` | 独立进程和部署安全边界，应用设置不应削弱它 |
| 出站与运行时防护 | `OUTBOUND_ALLOWED_HOSTS`、`CORS_ORIGINS`、`AGENT_WS_MAX_PAYLOAD_BYTES`、`AGENT_WS_FRAMES_PER_WINDOW`、`AGENT_WS_RATE_WINDOW_MS`、`AGENT_WS_AUTH_TIMEOUT_MS`、`AGENT_MAX_MESSAGE_CHARS`、`AGENT_MAX_CONCURRENT_RUNS`、`AGENT_RUN_TIMEOUT_MS`、`AGENT_MAX_ITERATIONS`、`AGENT_MAX_TOOL_RESULT_CHARS` | 部署级安全上限，修改应经过重启和运维审查 |
| 文件与可执行资源 | `AGENT_WORKSPACE`、`PROMPT_VERSIONS_DIR`、`AGENT_SKILL_DIRS`、`AGENT_SKILL_DIGESTS`、`AGENT_SKILL_ALLOWLISTS`、Oracle 客户端相关变量 | 与挂载、镜像或可信文件边界绑定 |
| 外部服务引导 | `ANTHROPIC_API_KEY`、`ANTHROPIC_MODEL` | 保留为未配置数据库提供商时的兼容回退；日常模型配置优先使用模型配置页 |
| Agent Core 保护参数 | `NANOBOT_LLM_TIMEOUT_S`、`NANOBOT_STREAM_IDLE_TIMEOUT_S`、`AGENT_LOOP_THRESHOLD` | 库级或进程级保护参数，调用方显式配置优先 |
| 提示词部署选择 | `PROMPT_VERSION`、`PROMPT_AB_TEST`、`PROMPT_HOT_RELOAD`、`ANALYSIS_MODEL_VERSION` | 版本选择、审计标签和文件监听行为，属于发布配置 |

技能清单声明的动态密钥变量继续由环境注入；这类名称来自技能元数据，不能安全地统一迁入业务配置表。

## 后续业务策略

`SESSION_RETENTION_DAYS`、`SESSION_MAX_MESSAGES`、`SESSION_CLEANUP_BATCH_SIZE` 控制会话数据生命周期和清理批次，适合后续迁入独立的“数据保留”领域设置。该工作与指标采集调度无直接关系，不纳入本次变更。

## 已排除

`QUALIFICATION_*`、`SMOKE_*`、`PLAYWRIGHT_*`、`VITE_*`、`npm_package_version` 仅服务测试、构建或包元数据，不属于运行中的系统设置。
