/**
 * Gateway event types and constants.
 * Simplified version for Slide project.
 */

export const GATEWAY_EVENT_UPDATE_AVAILABLE = "update.available" as const;

export type GatewayUpdateAvailableEventPayload = {
  updateAvailable?: {
    version?: string;
    url?: string;
  } | null;
};
