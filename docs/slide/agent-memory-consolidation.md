# Memory consolidation 数据保留契约

`Consolidator.consolidateToMemory(store, batchLimit?)` 不调用模型；每次处理最老的一批历史，默认和最大批次为 50。有限批次后未消费项仍在 history 中，需要调用者再次显式消费；不存在自动后台 drain。参数此前未使用，现在作为正整数批次上限。`summarize` 保持原展示语义，不是消费或知识提取。

## 存储与恢复

- `.slide/history.jsonl` 存储稳定 ID 的 `memory-history-v1` envelope；公开读取返回 `{index, id, entry}`，原始 `entry` 内容不变。`index` 保留旧 API 的瞬时行偏移语义，不能持久化为新消费游标。旧裸 JSONL 在第一次写入或消费前迁移；重复 payload 仍具有不同来源 ID。
- `.slide/consolidation-pending.json` 冻结本批次 IDs、内容和 hash。恢复优先完成此 journal，即使这次调用的批次上限更小。损坏 journal/history、同 ID 内容变更或 archive hash 不一致会报错，不能当空历史清理。
- `.slide/memory-archive/<batch hash>.json` 是不可变的来源归档；`MEMORY.md` 是兼容展示，保留原文本，每批有 hash marker 防止重启后重复附加。
- archive 和 MEMORY 完成 durable write 后才写 `.slide/consolidation-cursor.json`，其中 `lastSourceId` 是稳定来源 ID；cursor 是最近完成的归档边界，不是瞬时行号，也不是唯一恢复依据。最后重读当前 history，只移除本批次 IDs；快照后的 append 保留。
- 文件采用独立临时文件、fsync、rename 和目录 fsync；失败保留 journal，下一次调用可恢复。cursor 更新后 history 清理失败，也不会丢数据或重复发布。本策略不宣称文件系统提供跨文件原子事务或外部 exactly-once。

`compactHistory(keepCount)` 保持“保留近期条目”的公开入口，先归档有限高水位前缀再删除已消费 IDs；新的 append 留待以后处理。`clearHistory()` 仍是显式删除入口；存在 pending journal 时拒绝清空，须先恢复消费。原 MEMORY.md、SOUL.md、AGENTS.md 和 USER.md 读取入口保留。

同一进程的多个 MemoryStore、Consolidator 实例使用共享 workspace 锁；归档期间 append 可继续，MEMORY 发布与手动更新串行。**不支持多个进程同时写同一个 workspace**；重启恢复要求旧进程已退出。直接文件编辑、跨进程并发和旧二进制写入新 envelope 不在兼容保证内。回退前先完成 pending journal、停止写入并备份 history/archive；不要让旧 binary 将 envelope 当裸业务 entry。此阶段没有接入业务自动记忆或改变执行 Runtime。

## 验证

基线/目标 `6c22d2a51d7bf17ec3cd36526032671b104849dd`。聚焦回归覆盖 51/1000 源、旧文件重复行、写/rename/cursor/ack 故障、实际子进程退出、并发 append/store/update、跨批次高水位、显式 clear 与损坏数据。每个源 ID 必须在 durable archive 或未消费 history 中；重复调用的 archive 和 MEMORY marker 均幂等。整链 MySQL/WS/UI 验收属于 MAX-97 后续阶段，不以这些文件级测试代替。
