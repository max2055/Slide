/**
 * 自动生成的技能工具
 *
 * 生成时间：2026-04-12T13:57:59.929Z
 * 修复时间：2026-06-30 (descriptions rewritten for clarity)
 */

import type { AnyAgentTool, ToolExecutionContext, ToolResult } from "../../tools/types.js";


export const check_health_healthTool: AnyAgentTool = {
  name: "check_health_health",
  description: "快速检查实例整体健康状态，返回健康评分（health_score）和状态描述（healthy/degraded/unhealthy）",
  parameters: {
  "type": "object",
  "properties": {
    "instance_id": {
      "type": "number",
      "description": "实例 ID"
    },
    "include_details": {
      "type": "boolean",
      "default": true
    }
  },
  "required": [
    "instance_id"
  ]
},
  handler:
async (args, context?: ToolExecutionContext) => {
  const results: ToolResult[] = [];


  // Step: db_check_health
  const result0 = context?.invokeTool
    ? await context.invokeTool('db_check_health', args)
    : { success: false, error: 'invokeTool not available' } as ToolResult;
  results.push(result0);


  return {
    success: true,
    results,
    summary: context?.generateSummary?.(results) ?? ''
  };
}
};


export const check_health_instanceTool: AnyAgentTool = {
  name: "check_health_instance",
  description: "获取实例基本信息，包括数据库类型（db_type）、主机地址（host）、端口（port）、运行环境（environment）等",
  parameters: {
  "type": "object",
  "properties": {
    "instance_id": {
      "type": "number",
      "description": "实例 ID"
    }
  },
  "required": [
    "instance_id"
  ]
},
  handler:
async (args, context?: ToolExecutionContext) => {
  const results: ToolResult[] = [];


  // Step: db_get_instance
  const result0 = context?.invokeTool
    ? await context.invokeTool('db_get_instance', args)
    : { success: false, error: 'invokeTool not available' } as ToolResult;
  results.push(result0);


  return {
    success: true,
    results,
    summary: context?.generateSummary?.(results) ?? ''
  };
}
};


export const check_health_metricsTool: AnyAgentTool = {
  name: "check_health_metrics",
  description: "获取实例最近的关键性能指标，包括 CPU 使用率、内存使用率、活跃连接数、QPS、慢查询数等",
  parameters: {
  "type": "object",
  "properties": {
    "instance_id": {
      "type": "number",
      "description": "实例 ID"
    }
  },
  "required": [
    "instance_id"
  ]
},
  handler:
async (args, context?: ToolExecutionContext) => {
  const results: ToolResult[] = [];


  // Step: db_get_metrics
  const result0 = context?.invokeTool
    ? await context.invokeTool('db_get_metrics', args)
    : { success: false, error: 'invokeTool not available' } as ToolResult;
  results.push(result0);


  return {
    success: true,
    results,
    summary: context?.generateSummary?.(results) ?? ''
  };
}
};


export const generatedTools: AnyAgentTool[] = [
  check_health_healthTool,
  check_health_instanceTool,
  check_health_metricsTool
];
