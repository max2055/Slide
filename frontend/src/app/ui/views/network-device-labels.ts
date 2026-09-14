const labels: Record<string, string> = {
  device_reachability: '设备可达性', device_uptime_seconds: '运行时长', device_cpu_percent: 'CPU 使用率',
  device_memory_percent: '内存使用率', device_temperature_celsius: '设备温度', interface_oper_status: '接口运行状态',
  interface_error_rate: '接口错包速率', interface_drop_rate: '接口丢包速率', interface_in_bps: '接口入站流量', interface_out_bps: '接口出站流量',
  good: '正常', partial: '部分缺失', unknown: '未知', unsupported: '不支持', error: '异常', stale: '已过期', timeout: '超时', missing: '缺失',
  up: '启用', down: '关闭', testing: '测试中', dormant: '休眠', notPresent: '不存在', lowerLayerDown: '下层链路关闭',
  instance: '数据库', server: '服务器', network_device: '网络设备', connected_to: '连接', serves: '服务于', hosted_on: '部署于', depends_on: '依赖', runs_on: '运行于', hosts: '承载', replicates_to: '复制到',
  api: '手动配置', manual: '手动配置', discovered: '自动发现', discovery: '自动发现', inferred: '推断',
  redacted: '已脱敏', unredacted: '未脱敏', failed: '失败', running: '执行中', success: '成功',
};
export const networkDeviceLabel = (value: string): string => labels[value] ?? value;

const errors: Record<string, string> = {
  SSH_CREDENTIAL_REQUIRED: '请先编辑网络设备并配置 SSH 用户名和密码或私钥',
  SSH_CREDENTIAL_READ_FAILED: '读取 SSH 凭据失败，请检查凭据配置',
  SSH_HOST_KEY_FINGERPRINT_REQUIRED: 'SSH 主机密钥指纹格式无效，请修正或留空',
  SSH_TARGET_DENIED: 'SSH 目标不在允许的访问范围内', SSH_CONNECT_FAILED: 'SSH 连接失败，请检查地址和凭据',
  SSH_COMMAND_FAILED: 'SSH 备份命令执行失败', SSH_COMMAND_TIMEOUT: 'SSH 备份命令执行超时',
  CONFIG_BACKUP_VENDOR_UNSUPPORTED: '暂不支持此厂商的配置备份', CONFIG_OUTPUT_LIMIT: '配置内容超过大小限制', CONFIG_EMPTY: '设备返回的配置为空',
  CONFIG_BACKUP_NOT_FOUND: '配置备份不存在', CONFIG_BACKUP_STORE_UNAVAILABLE: '配置备份存储暂不可用',
  CONFIG_BACKUP_FAILED: '配置备份失败', CONFIG_BACKUP_INTERRUPTED: '备份执行中断，请检查后手动重试',
  NETWORK_DEVICE_NOT_FOUND: '网络设备不存在', NETWORK_DEVICE_OPERATION_FAILED: '网络设备操作失败',
  SNMP_AUTH_FAILED: 'SNMP 认证失败，请检查凭据', SNMP_TIMEOUT: 'SNMP 请求超时', SNMP_RESPONSE_INVALID: 'SNMP 返回的数据无效',
  SNMP_TARGET_DENIED: 'SNMP 目标不在允许的访问范围内', SNMP_TARGET_POLICY_NOT_CONFIGURED: '尚未配置 SNMP 目标访问策略',
  SNMP_UNSUPPORTED_SECURITY: '不支持此 SNMP 安全配置', COLLECTION_IN_PROGRESS: '设备正在采集，请稍后重试', COLLECTION_DISABLED: '设备已暂停自动采集',
  AUTHENTICATION_REQUIRED: '请先登录', INTERNAL_ERROR: '服务暂不可用，请稍后重试', RESOURCE_FORBIDDEN: '没有访问此资源的权限',
};
export function networkDeviceError(value: unknown, fallback = '操作失败，请稍后重试'): string {
  const message = value instanceof Error ? value.message : String(value ?? '');
  return errors[message] ?? (/\p{Script=Han}/u.test(message) ? message : fallback);
}
