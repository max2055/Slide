# MAX-88 Candidate Final 验证记录

## 范围与版本

前置 PR #95 已合并，起点和当时最新 main 均为 `6eb8be58524946d00be043cd83a253c61e44def0`；相对设计基线 `07b3e6ce458b0b4576d356a97d78ab17df3ddd66` 仅增加 T1。本阶段实施 §2.2–2.5 的 candidate/repetition/history 部分，不实现 T3 的完整续写拼接、统一恢复预算，或 T4–T6 的上下文、长任务和真实 provider soak。

默认 enforce；调用者可在 run 开始时固定 `supervisorMode: 'observe'`，检测不增加模型/工具调用。不切换模型、不使用 LLM judge。通过 guard 只表示回复可接受，不证明业务语义正确。

## 实现与失败回归

- `runtime-supervisor.test.ts` 初次运行 3 failed / 5 passed：原实现把重复正文和空答补救中的重复正文标 completed，且未使用后续正常答案。修复后该组及扩展用例通过。
- 所有无工具响应经过同一 classifier；检查 provider error/finishReason、未执行工具意图、空答、复读、length。复读最多两次补救，耗尽 `MODEL_REPETITION_LOOP`；步数先耗尽则 `MAX_MODEL_STEPS`，不伪造完成。
- 检测最多 100k 字符，保留数字差异，最多八个当前 run 指纹。相似度 >92% 还需同一证据 epoch；相同或 A/B/A 工具结果不算新证据。既有工具连续签名 guard 未改动。
- 恢复提醒只进入 provider projection。被拒绝候选不进入 messages/checkpoint；拒绝 hook 发出可为空的累计快照。模型请求返回或取消后的迟到 stream callback 被丢弃。
- ChatResponse、controller 保留显式空串；排队 delta 不能恢复旧文本。失败/取消/catch/保存失败读取安全文本。合法 provider 中断 partial 保持原有行为。
- 子代理非 completed 映射 failed 并保留 reason；invoke 失败不再因 thinking 非空广播 complete。completion service 拒绝失败 resolution，并保护 completion pending 不被通用失败收尾覆盖，仍使用原事务。
- 原始 7 组 trace 保存在 `legacy-runtime-traces.snap`；当前 snapshots 仅变更复读、空答补救重新分类及 provider error resolution 三组。

## A2 冻结评测

数据：`packages/agent-core/src/__tests__/fixtures/text-repetition.json`。固定 210 个正常样本、30 个高置信异常；明确标注类别及期望。这是合成回归集，不是生产流量抽样，不将其外推为生产误拒率。

| 类型 | 样本 | 误拒 | 漏检 |
|---|---:|---:|---:|
| 中文短答 | 30 | 0 | 0 |
| 正常诊断文字 | 30 | 0 | 0 |
| SQL | 30 | 0 | 0 |
| JSON | 30 | 0 | 0 |
| 表格 | 30 | 0 | 0 |
| 日志 | 30 | 0 | 0 |
| 用户明确要求重复 | 30 | 0 | 0 |
| 高置信段落复读 | 15 | 0 | 0 |
| 高置信行内复读 | 15 | 0 | 0 |

正常样本误拒 0/210，异常漏检 0/30。另覆盖空白、短中文、代码块后复读、长输入上限、数字变化、三次相邻重复、合法重复、证据更新和相同结果轮询。结构化输出豁免是保守的兼容决定，不声称能识别结构化内容的语义循环。

## 验证命令与结果

2026-09-29，macOS / Node 24.18.0 / pnpm 11.19.0：

- `pnpm -r test`：agent-core 368、API 2686、frontend 541、sandbox 22 passed；API 129、sandbox 4 skipped。跳过项没有记作通过。
- 随后自审补充数字变化、代码块后复读和 invoke 终态保护，重跑受影响检查：核心模块 370 passed；API 四个直接相关文件 68 passed。最后补充三次相邻重复阈值用例，focused core 261 passed。最终完整 head 由 PR CI 再验证。
- 三个受影响 package 的 `typecheck` 通过；`pnpm lint` 0 errors（既有 warnings）；`pnpm contracts:check`、`pnpm qualification:matrix`（37/37）、frontend production build/CSP 检查通过。
- `DB_HOST=127.0.0.1 DB_PORT=<isolated-port> DB_USER=root DB_PASSWORD='' pnpm --filter slide-api exec tsx tests/durable-completion.integration.ts`：独立 MySQL 8.4 容器、随机专用数据库、真实本地 WS；脚本记录 PID、端口、cwd、启动命令和 commit。测试库、WS 和会话临时目录在 finally 清理。

真实 MySQL/WS 六组通过：

1. assistant INSERT 失败：回滚、pending intent、失败重试、重启恢复，无重复。
2. terminal UPDATE 失败：同样回滚并在重连 watch 后恢复；pending 不被 finish(failed) 覆盖。
3. 生成中断线：一次模型调用，数据库提交后才发布最终完成。
4. 复读三次：明确撤回为空、一次失败，无 assistant DB 记录；重启后 history/replay 不含坏正文；下一请求 context 不含坏正文，正常恢复只发布一次 complete。
5. COMMIT 成功但确认丢失：重放确认 completed，持久化答案唯一。
6. 两个 service 并发完成：消息幂等；取消先到时不能完成。

前端验证为 jsdom gateway/controller 队列测试；真实浏览器交互及当前部署 provider 的资格测试属于 T6，未在本阶段冒充完成。

## 资源

未设置硬预算；未委派子代理（总数 0、深度 0、并发峰值 1）。实际 raw/cached input、output 和费用遥测不可用，不以内部上下文或估算冒充实测。
