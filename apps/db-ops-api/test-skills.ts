/**
 * DB-Ops Skills 测试脚本
 *
 * 测试 6 个核心 DB-Ops Skills 的功能
 */

const API_BASE = 'http://localhost:3000';

// 颜色输出
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m'
};

function log(color: string, message: string) {
  console.log(`${color}${message}${colors.reset}`);
}

function success(message: string) { log(colors.green, `✅ ${message}`); }
function error(message: string) { log(colors.red, `❌ ${message}`); }
function info(message: string) { log(colors.blue, `ℹ️  ${message}`); }
function warn(message: string) { log(colors.yellow, `⚠️  ${message}`); }

async function test(endpoint: string, options?: RequestInit) {
  try {
    const response = await fetch(`${API_BASE}${endpoint}`, {
      timeout: 10000,
      ...options
    });
    const data = await response.json();
    return { ok: response.ok, status: response.status, data };
  } catch (e: any) {
    return { ok: false, status: 0, error: e.message };
  }
}

async function post(endpoint: string, body: any) {
  try {
    const response = await fetch(`${API_BASE}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      timeout: 30000
    });
    const data = await response.json();
    return { ok: response.ok, status: response.status, data };
  } catch (e: any) {
    return { ok: false, status: 0, error: e.message };
  }
}

async function runTests() {
  log(colors.cyan, '═══════════════════════════════════════════════════════════');
  log(colors.cyan, '           DB-Ops Skills 功能测试');
  log(colors.cyan, '═══════════════════════════════════════════════════════════\n');

  // 测试 1: 健康检查 API
  info('测试 1: 健康检查 API');
  const healthResult = await test('/api/health');
  if (healthResult.ok) {
    success('健康检查 API 正常');
  } else {
    error(`健康检查 API 失败：${healthResult.error || healthResult.status}`);
  }

  // 测试 2: DB-Ops Skills 元数据
  info('测试 2: DB-Ops Skills 元数据');
  const metadataResult = await test('/api/db-skills/metadata');
  if (metadataResult.ok && metadataResult.data?.skills) {
    success(`获取到 ${metadataResult.data.skills.length} 个技能:`);
    for (const skill of metadataResult.data.skills) {
      console.log(`   - ${skill.name} (${skill.category}): ${skill.toolCount} 个工具`);
    }
  } else {
    error(`Skills 元数据失败：${metadataResult.error || metadataResult.status}`);
  }

  // 测试 3: DB-Ops 工具分组
  info('测试 3: DB-Ops 工具分组');
  const groupsResult = await test('/api/db-skills/groups');
  if (groupsResult.ok && groupsResult.data?.groups) {
    success(`获取到 ${Object.keys(groupsResult.data.groups).length} 个工具分组`);
    for (const [group, tools] of Object.entries(groupsResult.data.groups)) {
      console.log(`   ${group}: ${tools.length} 个工具`);
    }
  } else {
    error(`工具分组失败：${groupsResult.error || groupsResult.status}`);
  }

  // 测试 4: 获取数据库实例列表（使用 db_list_instances 工具）
  info('测试 4: 执行 db_list_instances 工具');
  const listInstancesResult = await post('/api/db-skills/execute', {
    tool_name: 'db_list_instances',
    args: { status: 'all' }
  });
  if (listInstancesResult.ok && listInstancesResult.data?.success) {
    const instances = listInstancesResult.data.result?.instances || [];
    success(`获取到 ${instances.length} 个数据库实例`);
    for (const inst of instances.slice(0, 3)) {
      console.log(`   - ${inst.name} (${inst.db_type}): ${inst.health_status}`);
    }
  } else {
    warn(`db_list_instances 执行失败：${listInstancesResult.data?.error || '可能是没有配置实例'}`);
  }

  // 测试 5: 获取告警列表（使用 db_get_alerts 类似的接口）
  info('测试 5: 获取告警列表');
  const alertsResult = await test('/api/alerts?limit=5');
  if (alertsResult.ok) {
    success(`获取到 ${alertsResult.data?.total || 0} 条告警`);
  } else {
    warn(`告警列表失败：${alertsResult.error || alertsResult.status}`);
  }

  // 测试 6: 健康检查工具（需要实例 ID）
  info('测试 6: db_check_health 工具（需要实例 ID）');
  // 先获取实例列表，然后用第一个实例测试
  const instancesForTest = await post('/api/db-skills/execute', {
    tool_name: 'db_list_instances',
    args: { status: 'active' }
  });
  const instanceId = instancesForTest.data?.result?.instances?.[0]?.id;
  if (instanceId) {
    const healthCheckResult = await post('/api/db-skills/execute', {
      tool_name: 'db_check_health',
      args: { instance_id: instanceId }
    });
    if (healthCheckResult.ok && healthCheckResult.data?.success) {
      success(`健康检查完成：${healthCheckResult.data.result?.healthStatus} (${healthCheckResult.data.result?.healthScore}分)`);
    } else {
      warn(`健康检查失败：${healthCheckResult.data?.error || '实例可能不可用'}`);
    }
  } else {
    warn('没有可用实例进行测试');
  }

  // 测试 7: 性能指标工具
  info('测试 7: db_get_metrics 工具');
  if (instanceId) {
    const metricsResult = await post('/api/db-skills/execute', {
      tool_name: 'db_get_metrics',
      args: { instance_id: instanceId }
    });
    if (metricsResult.ok && metricsResult.data?.success) {
      success('获取性能指标成功');
      const metrics = metricsResult.data.result?.realtimeMetrics || {};
      if (metrics.cpu_usage !== undefined) {
        console.log(`   CPU: ${metrics.cpu_usage}%, 内存：${metrics.memory_usage}%, 连接：${metrics.connections}`);
      }
    } else {
      warn(`性能指标失败：${metricsResult.data?.error || '实例可能不可用'}`);
    }
  } else {
    warn('没有可用实例进行测试');
  }

  // 测试 8: 故障诊断工具
  info('测试 8: db_run_diagnosis 工具');
  if (instanceId) {
    const diagnosisResult = await post('/api/db-skills/execute', {
      tool_name: 'db_run_diagnosis',
      args: { instance_id: instanceId, diagnosis_type: 'full' }
    });
    if (diagnosisResult.ok && diagnosisResult.data?.success) {
      success(`故障诊断完成：${diagnosisResult.data.result?.summary}`);
      const issues = diagnosisResult.data.result?.issues || [];
      if (issues.length > 0) {
        console.log(`   发现 ${issues.length} 个问题`);
      }
    } else {
      warn(`故障诊断失败：${diagnosisResult.data?.error || '实例可能不可用'}`);
    }
  } else {
    warn('没有可用实例进行测试');
  }

  // 总结
  log(colors.cyan, '\n═══════════════════════════════════════════════════════════');
  log(colors.cyan, '测试完成');
  log(colors.cyan, '═══════════════════════════════════════════════════════════');
}

// 运行测试
runTests().catch(console.error);
