---
name: check_health
description: 检查health的快速命令
metadata: {}
---

# check_health

检查health的快速命令

**自动生成时间**: 2026-04-12T13:57:59.929Z

## 何时使用

- 当需要重复执行相同或相似的任务时
- 当想要快速完成某个操作时

## 工具列表

### check_health_health

检查health的快速命令

**参数**:
- `instance_id`: 实例 ID
- `include_details`: boolean

**返回值**:
```json
{
  "success": boolean,
  "results": array,
  "summary": string
}
```

### check_health_instance

检查health的快速命令

**参数**:
- `instance_id`: 实例 ID

**返回值**:
```json
{
  "success": boolean,
  "results": array,
  "summary": string
}
```

### check_health_metrics

检查health的快速命令

**参数**:
- `instance_id`: 实例 ID

**返回值**:
```json
{
  "success": boolean,
  "results": array,
  "summary": string
}
```


## 使用示例

```
check_health()
```

## 相关工具

- `db_check_health`
- `db_get_instance`
- `db_get_metrics`

## 注意事项

> ⚠️ 此技能由 AI 自动生成，请根据实际需求调整实现

