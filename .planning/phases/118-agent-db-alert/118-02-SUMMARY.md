---
phase: 118-agent-db-alert
plan: "02"
subsystem: api
tags: [agent, tools, database, connection, slide-self-mgmt]

requires:
  - phase: 109
    provides: agent-core tool system, toolCatalog registry
provides:
  - Agent tools for database instance discovery and connection retrieval
affects: [agent-ops, chat, ai-analysis]

tech-stack:
  added: []
  patterns:
    - "Agent tools follow AnyAgentTool interface with auto-registration via toolCatalog.register()"
    - "Sensitive tools (password access) use ownerOnly + dangerLevel metadata"
    - "Tool files self-register at import time via index.ts barrel export"

key-files:
  created:
    - apps/db-ops-api/src/tools/generated/slide-self-mgmt/list_database_instances.ts
    - apps/db-ops-api/src/tools/generated/slide-self-mgmt/get_instance_connection.ts
  modified:
    - apps/db-ops-api/src/tools/generated/slide-self-mgmt/index.ts

key-decisions:
  - "list_database_instances returns no passwords — safe for general Agent use"
  - "get_instance_connection returns decrypted password via getInstanceWithDecryptedPassword() — restricted by ownerOnly + dangerLevel 4"
  - "Both tools follow existing slide-self-mgmt pattern (AnyAgentTool interface, auto-registration)"

patterns-established:
  - "Agent DB tools: discovery tool (no secrets) + connection tool (with secrets, restricted)"

requirements-completed: [R1]

duration: 5min
completed: 2026-06-09
---

# Plan 118-02: Agent DB 连接工具 总结

**新增 2 个 Agent 工具，使 AI Agent 能够发现和连接数据库实例**

## 新增工具

### list_database_instances
- **功能**: 返回所有活跃实例的基本信息（id, name, db_type, host, port, health_status, environment, status）
- **权限**: 无特殊限制（不返回密码）
- **过滤**: 支持按 `db_type` 过滤（mysql, postgresql, oracle, dameng 等）

### get_instance_connection
- **功能**: 返回单个实例的完整连接信息（含解密后的 password、connection_string）
- **权限**: `ownerOnly: true` + `dangerLevel: 4`（高敏感操作）
- **参数**: `instance_id`（必需）

## 注册
- 两个工具均在 `index.ts` 中导出
- 通过 `toolCatalog.register()` 自动注册到全局工具目录
- 工具在模块导入时自动注册，无需额外初始化

## 任务完成
1. ✅ 创建 `list_database_instances` 工具
2. ✅ 创建 `get_instance_connection` 工具
3. ✅ 在 ToolCatalog 中注册（toolCatalog.register + index.ts 导出）
4. ⚠️ Agent 工具测试需在运行环境中手动验证

## 手动验证步骤
```bash
# 启动后端
cd apps/db-ops-api && npx tsx server.ts &

# 通过 Agent Chat 测试：
# 1. "列出所有数据库实例"
# 2. "获取实例 #1 的连接信息"
```

---
*Plan: 118-02*
*Completed: 2026-06-09*
