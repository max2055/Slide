# 表结构快照批次与升级

快照仍以 `(instance_id, snapshot_time)` 标识批次，时间精度为毫秒，保持历史列表和按时间比较接口的 Date 序列化兼容。保存时在专用连接中开始事务，锁住 `database_instances` 对应行，再读取该实例最近已提交的快照时间。新批次时间取应用当前时间与上一批次时间加一毫秒中的较大值。锁持有到全部列提交，因此跨进程、跨连接池同秒采集也不会复用批次时间；应用时钟回退时仍递增。高频采集或时钟回退时该值是逻辑批次时间，可能暂时超前于实际墙钟。

插入按每 500 列分块，整批使用一个事务。失败回滚，不删除历史，也不自动重放结果未知的请求。读取只看已提交批次；最新表详情与表列表采用相同的实例最新批次，不回退到已删除表的历史记录。空采集继续沿用原有错误语义，不生成空批次。

部署使用现有数据库迁移入口执行新增的 `156_schema_snapshot_batch_precision.sql`，把原 DATETIME 前向升级为 DATETIME(3)，保留非空、默认值和字段注释。已有秒级时间原值保留，历史读取和精确时间比较继续可用。不要改写已应用迁移的校验和。升级期间须暂停旧版快照采集写入，迁移完成并切换全部写入进程后再恢复采集；旧版写入者不遵守新锁协议。迁移涉及表结构锁，按现有部署窗口执行。历史上已经混批的数据没有足够信息拆分，需要重新采集形成新基线。

默认回归：仓库根目录执行 `pnpm --filter slide-api exec vitest run src/schema-database-service.test.ts src/schema-service.pg.test.ts`。

真实 MySQL 回归使用任务独占随机 schema（自动创建并清理），明确注入 `SNAPSHOT_MYSQL_TEST=1`、`SNAPSHOT_MYSQL_HOST`、`SNAPSHOT_MYSQL_PORT`、`SNAPSHOT_MYSQL_USER` 和 `SNAPSHOT_MYSQL_PASSWORD` 后，从仓库根目录执行 `pnpm --filter slide-api exec vitest run src/schema-database-service.mysql.test.ts`。账号需要在测试端创建/删除 schema、迁移和触发器的权限。该用例默认不读取应用 .env 或本机凭据，不操作共享业务库；显式启用却缺少端口或账号时立即失败。
