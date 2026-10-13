# T06 恢复：历史分页、授权缓存与真实浏览器 qualification

2026-10-13，MAX-148；恢复基线 main `0a2296ac38e45bff5ea72680a03d46f5893c9ee8`，已包含父核验的 T05-C / PR160。保留原 PR159 五个产品提交与本任务托管起始 `8e6b3869` 历史，当前运行始终位于 `agent/15astra/max-148`，未 switch/reset/force。原 d74 保留分支未改动。原 [T06 验证](t06-validation.md) 是前次失败的历史记录，本文件记录本次增量。

## 已关闭的直接缺口

- 合法 snapshot 不再推进 `contentEpoch`。同一调查内的初始/刷新快照允许已授权的旧页 HTTP 响应合并；断线/撤权仍推进 epoch，切换/销毁仍推进 generation。游标比较继续拒绝重复/迟到分页，客户端仅观察事实，不产生结果或写 Run 终态。
- 读取最新成果时按不可变 ID 合并已加载版本，保留旧页游标；断线清空后重新取得当前授权的最新页与新游标。刷新快照不会丢失已加载 V1 或使用户重复加载同一旧页。
- 创建/转换表单在权限事件、Session 切换及销毁时擦除目标/资源/时间等草稿，并使旧提交失效；HTTP 撤权使工作空间移除创建组件。迟到的接受响应不能导航到原调查，也不能恢复草稿。普通关闭的未知接受核对沿原 body/幂等键保留；撤权边界失效时不允许它重新公开内容。
- 专用 Playwright config 不启动通用平台服务，spec 独占随机 SQL schema 与临时 HTTP/WS/Vite。代理包括 `/__slide` 均指向自身服务，不连接其他工作树。快照门闩只在测试夹具中暂停真实服务返回，旧页 route.fetch 读取真实生产 HTTP 响应，不生成假 Parts/结果。
- CI `browser-qualification` 的既有 MySQL8.4 service 现在运行完整 T06 spec，retries=0。截图/失败 trace 进入专用 artifact。仅 Provider/只读工具数据为合成夹具，零新增外部模型调用。

## RED/GREEN 与真实验收

原 controller 的三个 focused 反例稳定失败：初始快照/重连快照丢弃 `oldest`、最新成果 refresh 丢失旧版本或重置游标。同一控制器目标修复后21/21；新增表单四项反例修复前4/4失败、修复后4/4通过。托管分支保留对应 RED/GREEN checkpoint 提交。

在可逆源码覆盖中，用原 controller `c1fa9a31` 运行相同真实浏览器时序：初始/重连旧页均 HTTP200，快照已发送后才交付旧页，两项均因 `延迟分页 000` 缺失而失败。finally 恢复当前 controller，无 reset、无重试。此 focused RED 的未选中项目不计为完整验收 skip。

最终完整 T06 浏览器 **18 passed / 0 failed / 0 skipped / 0 observationErrors**，每场景检查新 observationErrors，结束检查 workerErrors。snapshot/replay 的所有非授权异常都进入错误记录，不只记录旧幂等冲突。授权拒绝保持失败关闭。覆盖原12项及新增6项：

- 创建→正式 Worker/Executor→工具→取消→新 Run→独立结果版本→刷新；六种 Run 状态和 partial/outcome_unknown 映射沿既有契约，根因/恢复不自动升级。
- 1600 三列、1024 证据 dialog、390 单栏无横向溢出/导航遮盖，Escape 和焦点恢复；加载/空/错误/无权限、兼容普通 Chat 取消与深链。
- 普通 Chat 直接发送，无表单前置；转换前后真实 SQL 为同 Session、每个原 message_id 全表只一行。刷新/真实 WS 重连后的 SQL 消息 ID 与顺序不变，Provider/工具调用计数不增。
- 205条 canonical history 分页、排序、去重、刷新与真实重连；门闩确定性控制初始快照和重连刷新在旧页读取与交付之间到达。
- 两个反例延迟真实旧页 HTTP200，随后 SQL 撤权或实际列表切换。等待控制器的实际分页 promise 结束后检查：迟到内容不恢复；撤权同时检查原控制器所有敏感缓存与创建弹窗草稿清空。HTTP404与WS4001可先后竞争，均是有效失败关闭边界，不依赖哪条错误文案先显示。
- 到期证据 HTTP metadata tombstone、原文请求410/`EVIDENCE_EXPIRED`、SQL raw_json=NULL/expired_at、原hash与历史引用保留；刷新后仍显示原文过期、根因待验证。
- 22次正式独立 request/Run产生22个不可变成果版本，真实分页20→22；选项ID/顺序与SQL一致，snapshot刷新保留V1选择，重连/刷新重新授权并可加载旧页。

开发期间新安全测试曾因只预期WS撤权文案、而HTTP404先返回失败；对齐合法撤权语义并等待实际迟到promise结束。新增转换重连测试还曾在HTTP历史已可见、WS观察未建立时发送disconnect，未产生断线事件；增加 `online && refreshing===undefined` 就绪条件。保留失败历史，不用盲重跑或重试次数掩盖问题。

## 本次模块检查

| 检查 | 当前结果 |
|---|---|
| 前端 Vitest | 98文件，785 passed，0skip |
| 既有浏览器 `test:browser` | 120 passed，0skip |
| T06 实际 MySQL/JWT/HTTP/WS/Chromium | 18 passed，0skip |
| `security:agent` | 17文件，187 passed，0skip |
| 前端 typecheck/build/CSP | 通过；保留既有大chunk提示 |
| lint | 0 errors；既有全仓 warnings 不视为通过数量 |
| contracts:check | 通过，未改公开契约 |
| qualification:matrix | 37/37映射通过；映射不是A01–A18验收 |
| security:scan、diff check | 通过 |

实测环境：自建 loopback mysql:8.4、正式 MigrationRunner、随机schema、实时JWT/主体/资源授权、生产Fastify routes/DirectAdapter、MysqlWorkflowStore/WorkerRuntime和InvestigationExecutor。未使用生产数据库/真实设备/外部Provider；T04原5/6停发授权不转授。每个夹具关闭Vite/HTTP/WS/Worker，DROP自身schema；本次自建容器收尾停止。三尺寸截图、RED/GREEN/完整浏览器日志和当前源码hash随Issue评论交付。编码token/费用实测遥测不可用，无硬预算、无子代理。

## 出口与依赖

本次只提交原PR159的前端独立增量，不另建PR/Issue、不改后端/schema/server/auth/ledger/executor。托管历史含私有.multica及旧产物，交付tree从main生成，只覆盖原PR产品文件与本次frontend/CI/验证材料；原PR head是交付commit父节点，正常fast-forward push保留原五个产品commit；交付不包含私有文件。产品文件逐个hash须与当前托管树一致。

**完整T06/P1/V1尚未交付。** Profiles只读设置事实仍待T03-D独立PR的父Review/CI/普通merge/main；调查策略/预算/用量成本事实待后续T07-C。本任务未消费未合并端点、未硬编码伪配置、未删除既定设置要求。T06保持部分交付in_review，PR159保留draft，等待父全量审查与设置依赖；不合并、不放行stage8–10。当前head CI另以实际GitHub记录交付，不用原796af46c的8/8冒充本次结果。完整T12/A01–A18 gate不变。
