/** Scheduled reports always describe exactly one target of the matching type. */
export function assertReportTarget(config: { type: unknown; instance_id?: unknown; server_id?: unknown }): void {
  const { type, instance_id, server_id } = config;
  const validId = (id: unknown) => typeof id === 'number' && Number.isSafeInteger(id) && id > 0;
  if (type === 'server_health') {
    if (!validId(server_id) || instance_id != null) throw new Error('REPORT_CONFIG_SERVER_TARGET_INVALID');
  } else if (!['health', 'performance', 'slow_query', 'capacity'].includes(type as string)
    || !validId(instance_id) || server_id != null) {
    throw new Error('REPORT_CONFIG_INSTANCE_TARGET_INVALID');
  }
}
