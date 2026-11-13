# 分析存储删除契约

自动分析配置以 JSON 类型保存；重复保存更新值和类型，保留原行 id、description、updated_by，不修改历史迁移。

显式删除分析记录时，同一 MySQL 事务锁定主记录及派发记录，再清理匹配 analysis_id 的 admission key、attempt、dispatch 和主记录。任一步失败全部回滚。具有派发记录的 pending、running、unknown 禁止删除；unknown 必须先按既有对账流程确认结果。没有派发记录的历史记录沿用原删除语义。

派发请求快照及尝试记录保留至用户成功删除对应分析记录，不设置独立历史审计保留期；成功删除后数据库不再保留这些快照。当前没有新增按天数自动到期清理能力，记录未删除时无固定最大保留天数。已有工作流/发件箱仅含分析标识的调度信息继续按其生命周期保留，本修改不删除共享队列审计。备份、外部模型与运行时会话不在此数据库删除事务范围。

验证入口：显式注入 ANALYSIS_TEST_MYSQL_PORT / ANALYSIS_TEST_MYSQL_PASSWORD，执行 slide-api 的 src/analysis/analysis-recovery.mysql.test.ts（独占 schema，结束后删除），其中 #309/#310 用例覆盖配置元数据、五种状态、并发写入及失败回滚。
