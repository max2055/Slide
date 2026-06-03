---
created: 2026-05-09T07:10:39.302Z
title: 定时任务改为可配置，不要硬编码在 server.ts
area: backend
files:
  - apps/db-ops-api/server.ts
  - apps/db-ops-api/.env
---

## Problem

server.ts 中硬编码了多个 CronJob 实例（TopSQL 自动分析、告警 RCA、故障诊断），以及监控采集、告警评估等定时任务。当前只能通过 ENABLE_AUTO_AI_ANALYSIS 环境变量粗暴开关，不够灵活：
- 无法单独控制每个 CronJob 的启停
- 无法调整执行间隔
- 没有统一的定时任务管理 / 状态查看能力
- 新增定时任务需要改代码

## Solution

1. 设计一个统一的 CronJob 配置模型（存储在数据库 `cron_jobs` 表或配置文件中）
2. 每个任务支持：name、enabled、interval、timezone、handler
3. 后端提供 CRUD API + 运行时状态查询
4. 前端提供定时任务管理页面（列表、启停、查看日志）
5. 将现有硬编码的 CronJob 迁移到该配置系统中
