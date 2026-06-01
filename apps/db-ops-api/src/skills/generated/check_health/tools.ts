/**
 * 自动生成的技能工具
 *
 * 生成时间：2026-04-12T13:57:59.929Z
 */

import type { AnyAgentTool } from "../tools/types.js";


export const check_health_healthTool: AnyAgentTool = {
  name: "check_health_health",
  description: "检查health的快速命令",
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
async (args) => {
  const results = [];

  
  // Step: db_check_health
  const result0 = await this.invokeTool('db_check_health', args);
  results.push(result0);
  

  return {
    success: true,
    results,
    summary: this.generateSummary(results)
  };
}
};


export const check_health_instanceTool: AnyAgentTool = {
  name: "check_health_instance",
  description: "检查health的快速命令",
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
async (args) => {
  const results = [];

  
  // Step: db_get_instance
  const result0 = await this.invokeTool('db_get_instance', args);
  results.push(result0);
  

  return {
    success: true,
    results,
    summary: this.generateSummary(results)
  };
}
};


export const check_health_metricsTool: AnyAgentTool = {
  name: "check_health_metrics",
  description: "检查health的快速命令",
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
async (args) => {
  const results = [];

  
  // Step: db_get_metrics
  const result0 = await this.invokeTool('db_get_metrics', args);
  results.push(result0);
  

  return {
    success: true,
    results,
    summary: this.generateSummary(results)
  };
}
};


export const generatedTools: AnyAgentTool[] = [
  check_health_healthTool,
  check_health_instanceTool,
  check_health_metricsTool
];
