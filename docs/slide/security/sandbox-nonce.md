# Sandbox 请求去重

controller 复用 MySQL 单张 InnoDB 表，不引入新服务、执行状态机或结果缓存。HMAC 协议不变；去重保证最多执行一次，不保证执行成功。认领成功后即使作业失败也不释放 nonce。

部署前执行 `apps/db-ops-api/sql/migrations/096_sandbox_request_nonces.sql`。为 controller 配置专用账号，只授予 `slide.sandbox_request_nonces` 的 SELECT、INSERT、DELETE 权限；不要使用 API 或 root 账号。Compose 通过 `SANDBOX_NONCE_DB_USER/PASSWORD` 注入，独立部署另需 HOST、NAME，可选 PORT（默认 3306）。所有同 secret 副本必须连接同一权威写库。缺配置启动失败；表缺失、超时、连接故障返回 503，绝不降级到内存。健康检查只表示进程存活，不表示数据库可用。

数据库要求 autocommit=1、InnoDB、innodb_flush_log_at_trx_commit=1；不能把可能丢失已确认事务的异步副本无条件提升为写库。controller 本机及数据库均检查 ±30 秒窗口；需要正常时间同步。清理使用数据库时钟，每分钟最多删除 1000 条严格过期记录，保留至少认领后 60 秒；清理故障仅累积旧记录，恢复后继续清理。持续高于清理吞吐时应监控表大小并安排同条件批量清理。

数据库正常重启保留去重记录。若恢复旧快照、回滚或丢失去重数据，先停所有入口至少 60 秒并留时钟余量（或轮换所有客户端和 controller 的 secret），再恢复流量。数据库断连恢复后新请求可以继续，已认领请求仍拒绝。503 可能表示提交结果不明，不能假定未执行并自动重新签名重发，应核实作业结果。

生产实际副本数和数据库持久性配置尚需部署者核对；本变更不执行生产部署。
