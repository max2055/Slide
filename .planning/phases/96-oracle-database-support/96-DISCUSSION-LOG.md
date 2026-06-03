# Phase 96: Oracle Database Support - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-05-19
**Phase:** 96-oracle-database-support
**Areas discussed:** 指标注册范围, CodeMirror 方言, 实例详情页展示, Agent 工具范围, 连接方式, 功能启用边界, Oracle 详情数据选择, 连接池策略, 安全连接 (TCPS/TLS), 数据类型兼容, 采集流程集成, 字符集处理, Oracle 版本兼容性, PDB/CDB 多租户, SQL 自动补全, 测试与验证策略

---

## 指标注册范围

| Option | Description | Selected |
|--------|-------------|----------|
| 全部内置指标 | 将 oracle 添加到全部 8 个指标的 db_types | ✓ |
| 仅 Oracle 原生指标 | 仅注册 Oracle 有明确数据源的指标 | |
| Oracle 专属指标集 | 新增 Oracle 专属指标替换通用注册 | |

**User's choice:** 全部内置指标
**Notes:** Oracle 后端已有完整指标采集逻辑，全部注册即可启用

---

## Oracle 专属指标

| Option | Description | Selected |
|--------|-------------|----------|
| 新增 3 个专属指标 | tablespace_usage, sga_hit_rate, deadlock_count | ✓ |
| 不新增 | 通用 8 个指标 + 健康评分足够 | |
| 仅表空间使用率 | 仅 tablespace_usage | |

**User's choice:** 新增 3 个专属指标
**Notes:** 对齐 MySQL 已有专属指标 buffer_pool_hit_rate 的模式

---

## CodeMirror 方言策略

| Option | Description | Selected |
|--------|-------------|----------|
| 独立 Oracle 方言 | 创建独立 OracleDialect | ✓ |
| 重用/扩展 DamengDialect | 在达梦方言基础上扩展 | |
| 使用社区 Oracle 模式 | CodeMirror 社区已有模式 | |

**User's choice:** 独立 Oracle 方言

---

## OracleDialect 内容范围

| Option | Description | Selected |
|--------|-------------|----------|
| 完整方言 | PL/SQL 关键字 + 系统视图 + 函数 | ✓ |
| 仅关键字 + 系统视图 | 不含函数自动补全 | |
| Dameng 超集 | 在 DamengDialect 基础上增量添加 | |

**User's choice:** 完整方言

---

## OracleDialect 选择逻辑

| Option | Description | Selected |
|--------|-------------|----------|
| 在 SQL Console 新增分支 | db_type === 'oracle' → OracleDialect | ✓ |
| 统一方言注册表 | DialectRegistry 统一管理 | |

**User's choice:** 在 SQL Console 新增分支

---

## 实例详情页布局

| Option | Description | Selected |
|--------|-------------|----------|
| 复用现有布局 | 复用现有 6 tab 布局 | ✓ |
| 新增 Oracle 专属 tab | 聚合 SGA/PGA/表空间等 Oracle 特有信息 | |
| 增强概览 tab | 在概览中增加 Oracle 特有卡片 | |

**User's choice:** 复用现有布局

---

## Agent 工具范围

| Option | Description | Selected |
|--------|-------------|----------|
| 扩展 + 新增专属工具 | 修改 4 个现有工具 + 新增 Oracle 专属工具 | ✓ |
| 扩展现有工具 | 仅修改现有工具 enum | |
| 最小范围 | 仅 test_connection 和 add_database | |

**User's choice:** 扩展 + 新增专属工具

---

## Oracle 专属 Agent 工具

| Option | Description | Selected |
|--------|-------------|----------|
| ASH + 表空间 + AWR | 3 个 Oracle 专属工具 | ✓ |
| ASH + 表空间 | 2 个工具 | |
| 仅 ASH | 1 个工具 | |

**User's choice:** ASH + 表空间 + AWR

---

## ASH/AWR 报告输出格式

| Option | Description | Selected |
|--------|-------------|----------|
| 结构化文本摘要 | 适合 Agent 对话中快速理解 | |
| 完整 JSON 数据 | 保留原始数据 | |
| 混合格式 | 按对话需求自动选择 | |

**User's choice (Other):** 生成 HTML 格式，支持分析与下载（保留 Oracle 原生报告格式）

---

## 连接方式 (SID vs Service)

| Option | Description | Selected |
|--------|-------------|----------|
| 新增单一标识字段 | 一个字段支持 SID/Service Name | ✓ |
| SID + Service Name 双字段 | 两个字段都可填 | |
| Easy Connect 语法 | 用户直接在 host 字段输入完整串 | |

**User's choice:** 新增单一标识字段

---

## 功能启用边界

| Option | Description | Selected |
|--------|-------------|----------|
| 全部启用 | 所有已实现功能直接启用 | ✓ |
| 仅 SC 范围内启用 | 仅 roadmap 4 项 SC | |
| 与 Dameng 对齐 | 启用连接 + 指标 + SQL 控制台 + 详情页 + 健康检查 | |

**User's choice:** 全部启用

---

## Oracle 详情数据选择

| Option | Description | Selected |
|--------|-------------|----------|
| 版本 + SGA + PGA + 表空间 | 4 个关键指标 | ✓ |
| 完整性能概览 | 加上 Shared Pool 和 Library Cache 命中率 | |
| 最小展示 | 仅版本 + 活跃会话 + 数据库角色 | |

**User's choice:** 版本 + SGA + PGA + 表空间

---

## 连接池策略

| Option | Description | Selected |
|--------|-------------|----------|
| 保持现有方式 | oracledb.getConnection() 内部默认池 | |
| 显式连接池 | oracledb.createPool() 替代 getConnection() | ✓ |
| 可配置连接池 | 支持 poolMin/poolMax/poolTimeout 配置 | |

**User's choice:** 显式连接池

---

## Oracle 连接池配置

| Option | Description | Selected |
|--------|-------------|----------|
| 使用默认参数 | poolMax=4, poolMin=0, poolTimeout=60s | ✓ |
| 用户可配置 | add-instance 表单新增池参数 | |
| 全局配置 | 从 .env 读取所有 Oracle 实例共享配置 | |

**User's choice:** 使用默认参数

---

## 安全连接 (TCPS/TLS)

| Option | Description | Selected |
|--------|-------------|----------|
| 可选 TLS | instance 表新增 tls_enabled 字段 | |
| 强制 TCPS | 所有 Oracle 连接默认走 TCPS | ✓ |
| 暂不支持 | Phase 96 仅 TCP 明文 | |

**User's choice:** 强制 TCPS

---

## TLS 证书验证

| Option | Description | Selected |
|--------|-------------|----------|
| 强制验证证书 | 生产环境要求 wallet 路径+密码 | |
| 可配置验证 | 支持 TCPS 但证书验证可选 | |
| 代码支持暂不强制 | 开发/测试环境可跳过 wallet | ✓ |

**User's choice:** 代码支持暂不强制

---

## 数据类型兼容

| Option | Description | Selected |
|--------|-------------|----------|
| 配置 oracledb 类型映射 | fetchAsString/fetchAsBuffer 处理 | ✓ |
| 默认转换 | 完全依赖 oracledb 默认 | |
| 统一规范化层 | 构建 Oracle 结果规范化层 | |

**User's choice:** 配置 oracledb 类型映射

---

## 采集流程集成

| Option | Description | Selected |
|--------|-------------|----------|
| 与现有流程一致 | 无需 monitor-collector 修改 | ✓ |
| 启动时自动连接 Oracle | 预热连接避免首次遗漏 | |
| 统一重连机制 | 新增 connectAllActive() 方法 | |

**User's choice:** 与现有流程一致

---

## 字符集处理

| Option | Description | Selected |
|--------|-------------|----------|
| 依赖驱动默认 | NLS_LANG=AMERICAN_AMERICA.AL32UTF8 | ✓ |
| 实例级字符集配置 | add-instance 新增 charset 字段 | |
| 自动检测字符集 | 读取 NLS_CHARACTERSET 自动配置 | |

**User's choice:** 依赖驱动默认

---

## Oracle 版本兼容性

**User's choice (Other):** 支持 11g / 12c / 19c 三个版本
**Notes:** 11g 需要 oracledb Thick mode（Thin mode 最低 12.1）

---

## PDB/CDB 多租户

**User's choice (Other):** 不支持 PDB/CDB — 目标客户环境未使用该特性
**Notes:** 连接直接针对数据库实例

---

## SQL 自动补全

| Option | Description | Selected |
|--------|-------------|----------|
| 沿用现有模式 | 不做额外处理，与 Dameng 一致 | |
| Oracle 增强补全 | 基于 OracleDialect 关键字增强 | ✓ |

**User's choice:** Oracle 增强补全

---

## 测试与验证策略

| Option | Description | Selected |
|--------|-------------|----------|
| 单元+快照测试 | metric-registry 单元测试 + CodeMirror 快照测试 | |
| Oracle Docker 镜像 | 使用 Oracle 官方 Docker 镜像 | |
| 人工验证 | 不做自动化测试 | |

**User's choice (Other):** 用户本地有 Oracle 19c 容器用于验证，11g/12c 代码路径自行保证

---

## Claude's Discretion

- Oracle 默认端口 1521（前端已有），db_type 标识使用 'oracle'
- CodeMirror OracleDialect 结构对齐 DamengDialect 模式
- metric-registry 专属指标结构对齐 buffer_pool_hit_rate 注册模式
- ASH/AWR 工具内部使用 DBMS_WORKLOAD_REPOSITORY 包

## Deferred Ideas

- **PDB/CDB 多租户支持**: 目标客户环境未使用
- **Oracle RAC 集群**: 多节点连接管理和负载均衡
- **Oracle Data Guard**: 主备切换和灾备监控
