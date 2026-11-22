import type { DatabaseLogCollectionResult } from '../database-log-service.js';
import type { CronCompletion } from './cron-run-store.js';

export const DATABASE_LOG_COLLECTION_HANDLER = 'database.logs.collect';
export const DATABASE_LOG_COLLECTION_DESCRIPTION = '采集 MySQL 错误日志与 PostgreSQL 统计异常信号';

export function databaseLogCollectionCompletion(data: DatabaseLogCollectionResult): CronCompletion {
  const unavailable = {
    PLATFORM_STORAGE_UNAVAILABLE: '平台数据库不可用',
    INSTANCE_ENUMERATION_UNAVAILABLE: '实例列表不可用',
    NO_SUPPORTED_INSTANCES: '没有启用且支持日志采集的数据库实例',
  };
  const incomplete = data.failed > 0 || data.unavailable > 0;
  return {
    status: data.reason || (incomplete && !data.succeeded) ? 'failure' : incomplete ? 'partial' : 'success',
    summary: data.reason ? unavailable[data.reason]
      : `数据库日志采集完成：成功 ${data.succeeded}，源不可用 ${data.unavailable}，失败 ${data.failed}（实例数）`,
    result: { handler: DATABASE_LOG_COLLECTION_HANDLER, data },
  };
}
