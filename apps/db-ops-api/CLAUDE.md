# Slide db-ops-api 开发注意事项

## 待修复
- **self-mgmt 空壳工具**: `tools/generated/slide-self-mgmt/check_status.ts` 的 DB/LLM 检查返回占位数据；`configure_llm.ts` 6 个 handler 均为 TODO。已有功能完整的 `llm-config/index.ts` 可用作委托源

## 已修复
- **认证**: `auth-database-service.ts` 已使用 bcrypt.compare()，遗留 SHA-256 兼容路径
- **slide_complete_analysis**: 已实现于 `tools/generated/slide-self-mgmt/complete_analysis.ts`，4 个服务引用
- **LLM 配置工具**: `tools/generated/llm-config/index.ts` 6 个工具全部实现，18 个测试
- **DB 连接自动恢复**: Phase 99 — checkConnectionAlive/reconnect/_withAutoReconnect
- **SQL 历史持久化**: Phase 97 — sql_execution_history 表 + DatabaseAuditLogStore
- **Dameng/Oracle 执行**: sql-executor 已支持 4 种 DB 类型，数组行转对象行
- **SQL 控制台**: 历史全部实例筛选、按 db_type 引用标识符、左侧栏始终可见
