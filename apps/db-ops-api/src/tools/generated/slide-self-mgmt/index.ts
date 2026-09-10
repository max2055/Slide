/**
 * Slide 自管理工具集 - 入口文件
 *
 * 导出所有 Slide 自管理相关工具
 */

export { checkStatusTool } from './check_status.js';
export { addDatabaseTool } from './add_database.js';
export { addDatabaseBatchTool } from './add_database_batch.js';
export { addNetworkDeviceTool } from './add_network_device.js';
export { testConnectionTool } from './test_connection.js';
export { updateDbConfigTool } from './update_db_config.js';
export { completeAnalysisTool } from './complete_analysis.js';
export { listDatabaseInstancesTool } from './list_database_instances.js';
export { getInstanceConnectionTool } from './get_instance_connection.js';
export { recordFeedbackTool } from './record_feedback.js';
export { listServerInstancesTool } from './server_tools.js';
export { getServerMetricsTool } from './server_tools.js';
export { getServerAlertsTool } from './server_tools.js';
export { analyzeServerHealthTool } from './server_tools.js';
export { getServerDiagnosticsTool } from './server_tools.js';
export { listResourcesTool, getResourceObservationsTool, getResourceRelationsTool, diagnoseResourceTool } from './resource_tools.js';

// 导出工具数组，方便批量注册
import { checkStatusTool } from './check_status.js';
import { addDatabaseTool } from './add_database.js';
import { addDatabaseBatchTool } from './add_database_batch.js';
import { addNetworkDeviceTool } from './add_network_device.js';
import { testConnectionTool } from './test_connection.js';
import { updateDbConfigTool } from './update_db_config.js';
import { completeAnalysisTool } from './complete_analysis.js';
import { listDatabaseInstancesTool } from './list_database_instances.js';
import { getInstanceConnectionTool } from './get_instance_connection.js';
import { recordFeedbackTool } from './record_feedback.js';
import { listServerInstancesTool } from './server_tools.js';
import { getServerMetricsTool } from './server_tools.js';
import { getServerAlertsTool } from './server_tools.js';
import { analyzeServerHealthTool } from './server_tools.js';
import { getServerDiagnosticsTool } from './server_tools.js';
import { resourceTools } from './resource_tools.js';
import { platformTools } from './platform_tools.js';

export const slideSelfMgmtTools = [
  checkStatusTool,
  addDatabaseTool,
  addDatabaseBatchTool,
  addNetworkDeviceTool,
  testConnectionTool,
  updateDbConfigTool,
  completeAnalysisTool,
  listDatabaseInstancesTool,
  getInstanceConnectionTool,
  recordFeedbackTool,
  listServerInstancesTool,
  getServerMetricsTool,
  getServerAlertsTool,
  analyzeServerHealthTool,
  getServerDiagnosticsTool,
  ...resourceTools,
  ...platformTools,
];
