/** Independent lanes; defaults never enable automatic execution. Operator-only
 * environment configuration, not event payload/model authority. */
export function investigationBridgeFlags() {
  return { manual: process.env.INVESTIGATION_MANUAL_ENABLED === 'true',
    opsAuto: process.env.INVESTIGATION_OPS_AUTO_ENABLED === 'true',
    legacy: process.env.INVESTIGATION_LEGACY_BRIDGE_ENABLED === 'true' };
}
export function databaseAlertPilotConfiguration() {
  const serviceUserId = Number(process.env.INVESTIGATION_OPS_SERVICE_USER_ID);
  const ids = (key: string) => (process.env[key] ?? '').split(',').filter(Boolean).map(Number);
  const instanceIds = ids('INVESTIGATION_OPS_INSTANCE_IDS'), serverIds = ids('INVESTIGATION_OPS_SERVER_IDS'), networkDeviceIds = ids('INVESTIGATION_OPS_NETWORK_DEVICE_IDS');
  const all = [...instanceIds, ...serverIds, ...networkDeviceIds];
  const configured = Number.isSafeInteger(serviceUserId) && serviceUserId > 0 && all.length > 0
    && all.length <= 20 && all.every(id => Number.isSafeInteger(id) && id > 0 && id <= 4_294_967_295)
    && [instanceIds, serverIds, networkDeviceIds].every(values => new Set(values).size === values.length);
  return { configured, serviceUserId, instanceIds, serverIds, networkDeviceIds, policyId: 'database-alert-pilot', policyVersion: 1 as const };
}
