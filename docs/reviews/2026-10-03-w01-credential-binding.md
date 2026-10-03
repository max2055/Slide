# MAX-108 / W01 验收证据

范围版本：父任务 v2，W01 / A01。基线：`7916d44f3fb4ca82a1a2735298efa441b4c4550f`。
实现分支：`codex/MAX-108-credential-destination`。精确交付 head 与 PR URL 记录在任务交付评论。

## 实施边界

- 两入口 `/api/llm/test`、`/api/llm/models` 均要求 `llm:manage`。
- 先读取不含明文 Key 的供应商配置，再按规范化 origin 和批准的完整基础路径比较地址，最后才读取保存 Key；不按供应商名称推导信任。
- 默认端口、主机大小写和尾斜杠可规范化。代理基础路径必须相等，兄弟路径、嵌套路径、协议/端口/主机变化均不允许复用保存 Key。
- 无 Key、空白和常见掩码值均不是显式草稿 Key。新地址需要有权限的配置更新或本次显式草稿 Key。
- Key 解密前再次核对供应商配置快照；并发地址、格式、部署类型或 Key 变化返回 409，避免旧地址与新 Key 混用。
- OpenAI/Anthropic SDK 使用注入的 fetch 禁止重定向；模型发现和 Ollama 同样拒绝重定向。允许本地、私有服务和代理子路径。
- 沿用现有昂贵操作限流（每入口每 IP 10 次/分钟），限制请求体 16 KiB、Key 4096 字符、URL 2048 字符。连接测试最大 50 输出 token、15 秒超时，SDK 测试不自动重试。
- 错误只返回固定诊断码，不透传供应商响应正文或凭证存储异常；模型参数目录和未知模型确认逻辑未扩展。

## 失败复现与修复证据

先提取可注入的连接测试路由（保留原有缺失权限/任意目的地址行为），再添加测试。
初始执行 `pnpm --filter slide-api exec vitest run src/llm/credential-destination-policy.test.ts`：26 用例中 19 失败。
失败覆盖普通登录角色应返回 403、跨 origin/非批准子路径应拒绝、空白及掩码 Key 不能绕过保存凭证绑定。
修复后的最终后端门禁包含全部新增回归；真实 HTTP receiver 测试确认未经批准的 receiver 收到的请求数为 0。

真实传输覆盖 DeepSeek、StepFun、MiMo、Anthropic 的 SDK/模型列表请求、草稿 Key、保存 Key、同 origin/跨 origin 的 307 重定向、供应商 401 正文脱敏，以及无凭证本地 Ollama。
每次重定向只出现一次原请求，没有后续跳转或 SDK 自动重试。权限与地址拒绝用例同时断言未读取 Key、未调用出站依赖。

## 最终验证

环境：macOS、Node `v24.18.0`、pnpm `11.19.0`，按 lockfile 安装。
存储使用内存夹具或 mock；供应商使用本地临时端口 HTTP receiver；仅假 Key。未加载实际 `.env`、未重启用户服务、未调用付费模型。

| 命令 | 结果 |
| --- | --- |
| `pnpm -r typecheck` | 后端、前端、agent-core、sandbox-controller 全部通过 |
| `pnpm -r test` + 契约清单补齐后的 `pnpm --filter slide-api test` | 后端 2870、前端 554、agent-core 635、sandbox-controller 22 用例通过；后端 129、sandbox-controller 4 用例按既有条件跳过 |
| `pnpm --filter slide-frontend exec vitest run src/app/ui/views/llm-config.test.ts` | 12 用例通过（也包含在全量前端测试中） |
| `pnpm --filter slide-frontend test:browser` | 47 Chromium 用例通过，包含 W01 三个供应商流程与既有 390/1280px 配置流程 |
| `pnpm build` | 通过；CSP 检查通过；存在既有大型 chunk 提示 |
| `pnpm contracts:check` | 生成契约与源码一致 |
| `pnpm qualification:matrix` | 37/37 finding 映射通过；映射不代表外部环境已验收 |
| `pnpm security:scan` | 通过 |
| `pnpm security:audit` | 无已知依赖漏洞 |
| `pnpm lint`、`git diff --check` | 0 lint error，265 条警告；新增六个路由/策略/receiver/浏览器测试文件 focused lint 为 0 警告 |

全量单测最初仅契约测试的预期路径清单缺少新文档路由，修正并补权限/409/429 契约断言后重跑后端门禁；未重复运行已通过且未受后续改动影响的其他模块。

浏览器 W01 流程使用实际路由 handler（Fastify inject）、实际 SDK 与 receiver，以及内存配置更新夹具：加载保存模型 → 保存 Key 测试 → 改地址拒绝且不读取 Key → 草稿 Key 加载/测试 → 保存配置并清空输入框 → 保存后无回传 Key 测试。三个供应商页面错误均为 0。

## 未验证项与交付条件

- 未对真实供应商、生产数据库或实际私有代理做请求验证；不将假 receiver 结果宣称为供应商认证。
- GitHub 的八个完整 CI job、环境资格测试及 PR 合并状态由交付 PR 和父任务审查记录提供；本地结果不替代这些门禁。
- 无新增数据库迁移、批量凭证重加密或历史数据清理。未发现/调查历史实际异常调用，不宣称已有凭证泄露。
- 回滚无数据恢复步骤；若需回退发布，必须保留等效授权、地址绑定与重定向保护，禁止以撤销校验兼容旧行为。
- 硬预算未设定；raw input、cached input、output、实际费用遥测不可用。子代理 0，最大子代理深度 0，线程并发峰值 1。
