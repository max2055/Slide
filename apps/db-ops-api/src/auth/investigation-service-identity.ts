/** Durable identity markers using existing users columns. Provisioning is a
 * trusted operator action, never an event/model choice or an interactive API. */
export const INVESTIGATION_SERVICE_PREFIX = 'slide-investigation-';
export const INVESTIGATION_SERVICE_PASSWORD = '!slide-investigation-no-login!';
export const INVESTIGATION_SERVICE_PERMISSIONS: readonly string[] = Object.freeze([
  'chat:view', 'instance:view', 'servers:view', 'network_devices:view', 'metric:view', 'alert:view', 'config:view',
]);

export function isInvestigationServiceIdentity(username: string, passwordHash?: string): boolean {
  return username.toLowerCase().startsWith(INVESTIGATION_SERVICE_PREFIX)
    || passwordHash === INVESTIGATION_SERVICE_PASSWORD;
}

export function isValidInvestigationServiceIdentity(username: string, passwordHash: string): boolean {
  return /^slide-investigation-[a-z0-9-]{1,30}$/.test(username)
    && passwordHash === INVESTIGATION_SERVICE_PASSWORD;
}
