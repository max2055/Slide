---
phase: 134-deterministic-schema-bootstrap
status: planned
priority: P0
depends_on: []
plans: 2
source: Phase 131 system-level audit
---

# Phase 134：确定性 Schema 初始化与进程生命周期

## 目标

让空数据库安装、已有数据库升级、失败恢复和重复进程启动具有同一确定行为。迁移失败必须在服务接流量或启动 worker 前暴露，任何未取得监听端口/leader 资格的进程不得产生业务副作用。

## 覆盖发现

- HI-01：全新数据库无法初始化当前运行时 schema
- HI-12：取得 HTTP 端口前启动采集器、Cron 和其他副作用
- DR-03：迁移清单人工维护、吞掉错误、没有版本/checksum
- TG-03：schema validator 错误绿灯

## 锁定决策

1. `sql/migrations` 是正式 schema 事实源；`schema.sql` 不再作为独立安装路径。需要快照时由已执行迁移生成。
2. 引入迁移账本：`migration_id` 使用完整文件名，允许历史上两个 `011` 共存；记录 checksum、started_at、finished_at、status 和 error。
3. 已执行迁移文件不可重写。checksum 变化直接阻断启动；修复必须新增迁移。
4. 使用 MySQL advisory lock 或等价数据库锁串行执行迁移。DDL 失败不假装事务回滚，账本明确记录失败语句。
5. 已有环境采用显式 baseline/repair 检查，不通过 catch-and-ignore 猜测列是否存在。
6. 启动顺序固定为：配置/secret 预检 -> 数据库连接 -> migration lock/迁移 -> schema invariant -> 绑定 HTTP 与 Agent WS -> 标记 control-plane ready -> 获取 worker lease -> 启动采集/Cron/告警/清理 worker。
7. 任一步失败按逆序关闭已取得资源。SIGTERM/SIGINT 等待运行中 Operation 到安全点或释放 lease。
8. schema validator 必须在真实空 MySQL 中执行全部迁移并运行 repository/service 冒烟查询。

## 非目标

- 不把应用拆成独立微服务。
- 不引入新的外部迁移 SaaS。
- 不在本 Phase 实现业务 outbox，交由 Phase 137。

## 计划拆分

| Plan | Wave | 范围 |
|---|---:|---|
| 134-01 | 1 | 迁移账本、runner、manifest、checksum、baseline 与 schema invariant |
| 134-02 | 2 | 服务生命周期、端口/lease 顺序、空库/升级/恢复测试和运维命令 |

## Phase 退出门禁

- 空 MySQL 从零迁移后具备所有运行时表、列、索引和 FK。
- 相同迁移第二次执行为 no-op，checksum 篡改和失败迁移均阻止启动。
- 从 Phase 124/129 代表性历史快照升级成功且数据不丢失。
- 第二个后端进程端口失败时不写健康、Cron、采集或告警数据。
- schema 版本和构建版本出现在内部 readiness 诊断中。
