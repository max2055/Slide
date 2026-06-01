/**
 * Slide 自管理工具集 - 入口文件
 *
 * 导出所有 Slide 自管理相关工具
 */

export { checkStatusTool } from './check_status.js';
export { addDatabaseTool } from './add_database.js';
export { testConnectionTool } from './test_connection.js';
export { updateDbConfigTool } from './update_db_config.js';
export { configureLlmTool } from './configure_llm.js';
export { completeAnalysisTool } from './complete_analysis.js';

// 导出工具数组，方便批量注册
import { checkStatusTool } from './check_status.js';
import { addDatabaseTool } from './add_database.js';
import { testConnectionTool } from './test_connection.js';
import { updateDbConfigTool } from './update_db_config.js';
import { configureLlmTool } from './configure_llm.js';
import { completeAnalysisTool } from './complete_analysis.js';

export const slideSelfMgmtTools = [
  checkStatusTool,
  addDatabaseTool,
  testConnectionTool,
  updateDbConfigTool,
  configureLlmTool,
  completeAnalysisTool,
];
