export const GATEWAY_EVENT_UPDATE_AVAILABLE = "update.available" as const;

export type GatewayUpdateAvailableEventPayload = {
  updateAvailable: { currentVersion: string; latestVersion: string; channel: string } | null;
};
