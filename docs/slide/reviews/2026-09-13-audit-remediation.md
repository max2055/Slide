# 项目审计改进结果（2026-09-13）

基线：main@1d011e3。以当前代码复核 2026-09-10 的 R01–R12，未直接套用旧审计补丁。实施阶段修改保留在工作区、未提交、未部署；现有技能、AGENTS、评估文档及其它用户改动未覆盖。

## 已实施

| 条目 | 本轮处理 | 验收证据 |
|---|---|---|
| R01 Provider 配置 | Agent、常规调用与连接测试共享配置解析；显式传递 endpoint/key/model；移除环境变量写入及自动换供应商；本地无密钥模型可用，未配置时平台可启动、调用明确失败 | provider-factory 14 项；API 全量；真实可取消 OpenAI 测试服务 |
| R02 错误语义 | 实例枚举、LLM 配置读取失败不再冒充空列表；实例 GET 返回 503 稳定错误码；清理禁用、读取失败、无效配置留下的旧客户端 | instance-list-routes 8 项：401/403/200/503、权限过滤、数据库故障；Provider 失败回归 |
| R03 分析竞争 | invoke 拥有执行 deadline/cancellation；bridge 使用完整 await/catch 链；完成、失败和状态更新只接受活动前态；轮询只观察；同 envelope 完成保持幂等 | terminal lifecycle、bridge、DirectAdapter、核心 timer 回归；真实 Stop 持久化验收 |
| R04 无效代码 | 删除旧 RCA 私有执行链和专用 helper、两个占位模块、无运行入口 dreams.css；移除前端 marked、preview、cron 依赖及过时 chunk 规则 | 全量类型检查、前端测试/构建、RCA 公共入口测试 |
| R05 schema 兜底 | 删除 execution_trace 缺列后降级重写完成记录；缺少必需列明确失败 | 缺列只写一次的回归 |
| R06 弹窗 | 共享组件改用原生 modal dialog，处理深层焦点恢复、正反 Tab、Escape、背景 inert、嵌套与移除；Shadow DOM 内加入 border-box 防窄屏溢出 | Chromium 深浅主题 × 390/1280、嵌套、卸载，5 项；截图人工复核 |
| R07 设计统一 | alerts 升级规则、维护窗口、静默期迁移 app-dialog/app-form-field，删除重复 overlay 样式 | 真实浏览器验证三个表单的校验、提交 payload、成功关闭 |
| R08 类型/模块边界 | 提取 instance-list-routes，采用 Fastify handler、ActorContext 和依赖注入；保留原权限及公开 DTO 契约 | Fastify inject 行为测试、contracts:check |
| R09 测试和 CI | 以行为测试替换触达的私有方法/源码位置断言；加入 sandbox 类型/测试、dialog/dashboard 浏览器以及登录/权限/取消 qualification 作业；release 依赖这些作业 | 本地证据见下；CI YAML 已解析，远端 CI 未运行 |
| R10 timer | 请求结算清理 timer/abort listener，超时向底层传递 abort；不合作 Provider 也能结束等待；流式保留原有 timeout 策略 | core lifecycle 5 项及既有 timeout 回归、invoke cancellation/deadline 2 项 |
| R11 发布一致性 | 打包前检查构建输入相对 HEAD 的 tracked/untracked 修改，dirty 时明确拒绝，避免工作区前端搭配 HEAD 后端 | 临时 Git 仓库验证 clean、tracked dirty、untracked dirty、非构建文档变化；当前 dirty 工作区未打包 |
| R12 工程工具 | smoke 管道启用 pipefail；formatter 显式锁定 oxfmt；清理跟踪的测试输出并忽略后续产物；Vite 不监听 Playwright 输出，避免刷新测试页 | fake tsx 退出 23 经 tee 保持 23；pnpm 安装成功；lint 零错误 |

## 同根因补充（范围 v2）

新增登录门禁暴露出偏好同步的旧快照覆盖：异步读取期间用户输入用户名，返回后旧设置将其清空。仅在设置对象未改变时应用启动同步结果，保护同步期间的新修改；两个延迟响应测试覆盖“未编辑应应用”和“已编辑不得覆盖”。该修复直接阻塞 R09 的登录验收，不扩展到其它偏好架构改造。

## 验证

日志目录：/tmp/slide-remediation/。以下为真实执行结果，不将未执行的门禁计作通过。

- 四模块 TypeScript：API、frontend、agent-core、sandbox-controller 均通过；最后触达的 API/frontend 另有对应最终 typecheck。
- API 完整最终门禁：241 文件，2021 通过 / 1 失败。唯一失败是原有 docs/reviews 目录违反 phase-94-docs-structure.test.ts 的目录白名单；未删除审计产物，也未放宽或跳过最终门禁。
- Frontend：67 文件 / 389 测试通过；Agent core：10 文件 / 85 测试通过；sandbox：5 文件 / 14 测试通过。
- Dashboard 浏览器：18 项通过，覆盖近期总览筛选、权限、unknown/资源展示行为；共享弹窗 5 项及告警保存链路 1 项通过。最终窄屏截图检查了左右边界，并用 data-theme-mode 真正启用深色主题。
- 前端生产构建及 CSP：通过，保留现有 chunk 大小提示。
- lint：262 warnings / 0 errors，不以清理全仓既有 warning 扩展范围。
- contracts:check、qualification:matrix（37/37）、security:scan、security:deployment 均通过；生产依赖 audit 无已知漏洞。
- release guard 的临时仓库测试、smoke 非零退出传播、CI YAML 解析通过。
- 真实 qualification 最终 4/4 通过（qualification-final.log）：登录进入应用、未认证/无效密码拒绝、viewer 私有会话读/改/删隔离、Agent Stop 及取消终态持久化。读取与修改用例合并共享身份准备，消除第六次重复登录触发 429 的测试干扰，未修改生产限流。
- 未执行：真实供应商收费请求、真实业务数据库 smoke、发布打包/回滚、外部同步、全套 recovery/sandbox 容器资格测试；此次无部署结论。

## 保留与后续治理

- 保留 1d011e3 的监控/采集质量与 Cisco 备份行为，以及 46fab46 的总览设计。resource diagnostic 的实例读取异常分支仍保留，仅去掉冗余 strict 参数。
- 不按旧静态扫描的 44 个候选批量删除；其它共享组件迁移、全仓 strict、server.ts 全量拆分、所有源码文本测试替换继续按触达域治理，本轮不宣称完成全仓重构。
- 原工作区的 docs/reviews 归档位置仍需后续统一；该未跟踪目录不纳入本次 PR。干净提交快照的文档门禁结果见后续 PR 验证记录。
- 发布输入检查覆盖 Git 可见的源码/构建配置；外部环境和远端 CI 仍须按发布流程验证。

## 执行与资源

原计划委派 3 个子代理，均因 429 在实施前失败，实际修复由主线程完成。累计代理 3、最大深度 1、并发峰值上限 4，无后续派生。硬预算未设定；raw input、cached input、output、实际费用遥测不可用，不以内部计数冒充实测。

## 最终收尾

- 独立 MySQL 8.4 测试容器先后发生 OOM 和完整 migration 启动超过 60 秒；限定低内存配置，并将 managed Playwright 启动期限设为 180 秒后完成资格测试。生产执行超时、数据库配置与其它现有容器未修改。
- 最终资格测试在 11.5 秒内完成全部 4 项。测试专用容器及其卷已清理，API/WS/Vite 测试进程由 fixture 收尾；测试日志保留在 /tmp/slide-remediation。
- 实施阶段记录了 docs/reviews 目录规范冲突，没有将当时失败的完整门禁标记为通过，也未自动提交或发布。

## PR 验证记录（2026-09-13）

用户随后明确要求提交 PR。分支 codex/audit-remediation 基于最新 origin/main@1d011e3，仅提交本轮修复、测试、门禁和结果文档；不包含原工作区的技能/AGENTS 改动、未跟踪 docs/reviews、其它评估资料及临时产物。

使用暂存区 Git tree 导出独立快照，运行 vitest run tests/phase-94-docs-structure.test.ts，11/11 通过。此前唯一失败由原工作区未跟踪目录触发，不存在于本次 PR 内容中；没有删除原目录或修改测试白名单。其余代码未变，复用上述对应版本的验证证据，远端 CI 结果以 PR checks 为准。
