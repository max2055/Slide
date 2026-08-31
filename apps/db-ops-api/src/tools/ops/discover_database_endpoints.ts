import type { AnyAgentTool } from '../types.js';
import { toolCatalog } from '../catalog.js';
import { databaseNetworkScanService } from '../../security/database-network-scan-service.js';

export const discoverDatabaseEndpointsTool: AnyAgentTool = {
  name: 'discover_database_endpoints',
  description: '在预配置的受限网络中发现网段内开放的数据库端口；仅执行固定的数据库端口扫描，不接受任意命令或镜像。首次调用若返回 approvalId，审批通过后必须在相同网段和 profile 的重试中携带该 ID。',
  parameters: {
    type: 'object',
    properties: {
      cidr: { type: 'string', description: '待扫描的 IPv4 CIDR，例如 10.17.12.0/24' },
      profile: { type: 'string', enum: ['common_databases'], description: '预置数据库端口集合' },
      approvalId: { type: 'string', description: '首次调用返回的服务端审批 ID；审批通过后重试时携带' },
    },
    required: ['cidr', 'profile'],
  },
  requiredPermissions: ['network:discover'],
  requiresApproval: true,
  dangerLevel: 4,
  readOnly: false,
  group: 'agent_security',
  handler: async (args) => databaseNetworkScanService.scan({
    cidr: args.cidr as string,
    profile: args.profile as string,
  }),
};

toolCatalog.register(discoverDatabaseEndpointsTool);
