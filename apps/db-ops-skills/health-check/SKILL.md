---
name: health-check
description: 数据库健康检查快速命令
command-dispatch: tool
command-tool: db_health_check
command-arg-mode: raw
user-invocable: true
---

# 健康检查技能

这个技能提供快速执行数据库健康检查的能力。

## 使用方法

```
/health-check --instance_id=1
/health-check --db_type=mysql
```

## 技能说明

此技能会：
1. 检查指定实例或数据库类型的健康状态
2. 生成健康评分
3. 提供性能指标摘要

## 相关工具

- `db_health_check` - 执行健康检查
- `db_get_metrics` - 获取性能指标
- `db_get_instance` - 获取实例信息
