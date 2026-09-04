/** Register a network device in inventory without passing credentials through the Agent channel. */

import type { AnyAgentTool, ToolResult } from '../../types.js';
import { toolCatalog } from '../../catalog.js';
import { networkDeviceDatabaseService } from '../../../network-devices/network-device-database-service.js';

interface AddNetworkDeviceArgs {
  name: string;
  host: string;
  vendor?: 'huawei' | 'cisco';
  label?: string;
  site?: string;
  model?: string;
  os_version?: string;
  serial_number?: string;
  snmp_port?: number;
  ssh_port?: number;
}

const CREDENTIAL_FIELDS = new Set([
  'password', 'credential', 'credential_ref', 'credential_value', 'community',
  'authSecret', 'auth_secret', 'privacySecret', 'privacy_secret', 'ssh', 'snmp', 'snmpv2c', 'snmpv3',
]);

export const addNetworkDeviceTool: AnyAgentTool = {
  name: 'slide_add_network_device',
  description: '将 Huawei 或 Cisco 网络设备登记到 Slide 资源列表；凭据需在网络设备页面另行配置',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: '网络设备名称' },
      host: { type: 'string', description: '网络设备 IP 地址或主机名' },
      vendor: { type: 'string', description: '设备厂商，默认 huawei', enum: ['huawei', 'cisco'], default: 'huawei' },
      label: { type: 'string', description: '显示标签（可选）' },
      site: { type: 'string', description: '站点（可选）' },
      model: { type: 'string', description: '设备型号（可选）' },
      os_version: { type: 'string', description: '操作系统版本（可选）' },
      serial_number: { type: 'string', description: '序列号（可选）' },
      snmp_port: { type: 'number', description: 'SNMP 端口，默认 161', default: 161 },
      ssh_port: { type: 'number', description: 'SSH 端口，默认 22', default: 22 },
    },
    required: ['name', 'host'],
  },
  group: 'db_ops',
  requiresApproval: false,
  dangerLevel: 3,
  requiredPermissions: ['network_devices:manage'],
  handler: async (args, context): Promise<ToolResult> => {
    if (Object.keys(args).some((key) => CREDENTIAL_FIELDS.has(key))) {
      return {
        success: false,
        status: 'error',
        error: '禁止向 Agent Tool 传递网络设备明文凭据',
        errorCode: 'PLAINTEXT_CREDENTIAL_DENIED',
        next_actions: ['先登记设备，再在网络设备页面配置 SNMP/SSH 凭据'],
      };
    }
    const validationError = validateArgs(args);
    if (validationError) {
      return { success: false, status: 'error', error: validationError, errorCode: 'INVALID_ARGUMENTS' };
    }
    if (!context?.actor) {
      return { success: false, status: 'error', error: '缺少认证执行上下文', errorCode: 'MISSING_ACTOR' };
    }

    const input = args as unknown as AddNetworkDeviceArgs;
    const host = input.host.trim().toLowerCase();
    const snmpPort = input.snmp_port ?? 161;
    try {
      const existing = (await networkDeviceDatabaseService.getAllDevices())
        .find((device) => device.host.toLowerCase() === host && device.snmp_port === snmpPort);
      if (existing) return existingResult(existing.id, existing.name);

      const created = await networkDeviceDatabaseService.createDevice({
        name: input.name.trim(),
        host,
        vendor: input.vendor ?? 'huawei',
        label: optionalText(input.label),
        site: optionalText(input.site),
        model: optionalText(input.model),
        osVersion: optionalText(input.os_version),
        serialNumber: optionalText(input.serial_number),
        snmpPort,
        sshPort: input.ssh_port ?? 22,
        collectionEnabled: false,
        createdBy: context.actor.userId,
      });
      if (!created.success || !created.deviceId) {
        return {
          success: false,
          status: 'error',
          error: `网络设备纳管失败：${created.error ?? 'NETWORK_DEVICE_OPERATION_FAILED'}`,
          errorCode: 'CREATE_NETWORK_DEVICE_FAILED',
          details: { terminal: false, retryable: true },
          next_actions: ['检查目标地址和网络设备存储状态后重试'],
        };
      }
      return {
        success: true,
        status: 'success',
        data: { networkDeviceId: created.deviceId, name: input.name.trim(), credentialStatus: 'pending_credentials' },
        artifacts: { networkDeviceId: created.deviceId },
        summary: `已将网络设备 "${input.name.trim()}" 登记到资源列表，等待配置凭据`,
        details: { networkDeviceId: created.deviceId, host, snmpPort, terminal: false, retryable: false },
        next_actions: ['在网络设备页面配置 SNMP 凭据；需要配置备份时再配置 SSH 凭据（主机密钥指纹可选）'],
      };
    } catch {
      return {
        success: false,
        status: 'error',
        error: '网络设备纳管失败',
        errorCode: 'ADD_NETWORK_DEVICE_FAILED',
        details: { terminal: false, retryable: true },
        next_actions: ['检查网络设备存储状态后重试'],
      };
    }
  },
};

function validateArgs(args: Record<string, unknown>): string | null {
  if (typeof args.name !== 'string' || !args.name.trim()) return 'name 不能为空';
  if (typeof args.host !== 'string' || !args.host.trim()) return 'host 不能为空';
  if (args.vendor !== undefined && args.vendor !== 'huawei' && args.vendor !== 'cisco') return 'vendor 必须是 huawei 或 cisco';
  for (const key of ['snmp_port', 'ssh_port'] as const) {
    if (args[key] !== undefined && (!Number.isInteger(args[key]) || Number(args[key]) < 1 || Number(args[key]) > 65535)) {
      return `${key} 必须是 1-65535 之间的整数`;
    }
  }
  return null;
}

function optionalText(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

function existingResult(id: number, name: string): ToolResult {
  return {
    success: false,
    status: 'warning',
    error: `该地址已被网络设备 "${name}" 纳管`,
    errorCode: 'NETWORK_DEVICE_EXISTS',
    data: { networkDeviceId: id, name, credentialStatus: 'existing' },
    artifacts: { networkDeviceId: id },
    details: { networkDeviceId: id, terminal: true, retryable: false },
    next_actions: [`复用已有网络设备 ID ${id}，不要重复纳管`],
  };
}

toolCatalog.register(addNetworkDeviceTool);
