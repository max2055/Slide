MAX-225 部分交付后的唯一环境阻塞交接，不推进兄弟任务，不重复派发。沿用原线程01a173cc-f3b3-7d15-afcd-df1725dfa24d。先读父单当前ledger/dispatch_state、子单正文/最终评论/checkpoint及当前运行；整批最多2含Chief，无子代理。

MAX225任务分支agent/15coder1/max-225保持起点e004b772a，当前887aa0336d1b21be980274b0a1bd60cb04fb6829。本单源码提交5c73b1d01、442ad300c，证据887aa0336；此前仅cherry-pick父候选必要源提交，没有运行时快照。草稿PR348 https://github.com/max2055/Slide/pull/348 ，source-only SHA424955697beab308d8912ff6ff008ae3984ed2c1，base codex/max-226-alert-isolation（PR345），不合并/发布。

三类共享保存入口、总开关/级别/时窗/范围fail-closed、服务身份实时核验、自动关闭禁止legacy回落、pending事务/重启恢复及持久owner已实现。真实MySQL专项10通过（此后新增预算拒绝用例尚未跑）；前序桥/资源focused73通过；pool及策略29通过，三类新测试因复用冷却期失败后独立fixture已通过；最终告警61通过；独立调查模块380通过37跳过；typecheck/contracts通过。精确内容见docs/slide/development/MAX-225/verification.md和checks.json。

完整模块回归期间共享Docker daemon开始无响应，docker ps 8秒超时，共享MySQL10秒ETIMEDOUT；真实VM验收在采集前失败，不能归因于VM本身。已停止本worktree自有测试进程，未重启共享Docker/API/MySQL。只对精确自有测试容器尝试清理，15秒超时，cleanup.json保留4个名称（有些可能已自动停止，回读后只清理自有）。共享环境所有者需协调恢复Docker/MySQL；恢复后共享一个隔离MySQL串行验证，避免同时起多个MySQL容器。不把mock/探针当真实验收。

尚未完成：新增预算拒绝SQL用例、完整gate、真实VM采集→告警→自动受理→有证据引用有效模型结论→恢复及实测用量。无真实模型发送；父ledger读取revision3 settled0/pending0/unknown0，未改账本。模型测试前必须读最新父账本、可靠预留并回读、实测结算；unknown绝不重放。资格脚本qualify-automatic-alert.ts本轮无模型，仅准备采集/准入/自然恢复段。

请审查上述四条编码标准及恢复条件；环境恢复后仅让原MAX225负责人继续同一任务和分支，不创建重复任务，不推进MAX228。MAX225当前blocked，不能因有PR就in_review。不要自动重启共享服务或把未完成标为通过。若本轮仍不能恢复，用一次明确的环境事件/成员回复条件接续，避免分钟轮询/重复唤醒。
