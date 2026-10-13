/** Independent lanes; defaults never enable automatic execution. Operator-only
 * environment configuration, not event payload/model authority. */
export function investigationBridgeFlags() {
  return { manual: process.env.INVESTIGATION_MANUAL_ENABLED === 'true',
    opsAuto: process.env.INVESTIGATION_OPS_AUTO_ENABLED === 'true',
    legacy: process.env.INVESTIGATION_LEGACY_BRIDGE_ENABLED === 'true' };
}
export function databaseAlertPilotConfiguration() {
  const serviceUserId = Number(process.env.INVESTIGATION_OPS_SERVICE_USER_ID);
  const instanceIds = (process.env.INVESTIGATION_OPS_INSTANCE_IDS ?? '').split(',').filter(Boolean).map(Number);
  const configured = Number.isSafeInteger(serviceUserId) && serviceUserId > 0 && instanceIds.length > 0
    && instanceIds.length <= 20 && instanceIds.every(id => Number.isSafeInteger(id) && id > 0 && id <= 4_294_967_295)
    && new Set(instanceIds).size === instanceIds.length;
  return { configured, serviceUserId, instanceIds, policyId: 'database-alert-pilot', policyVersion: 1 as const };
}
