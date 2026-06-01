export const GATEWAY_CLIENT_MODES = ["webchat", "cli", "sdk", "nostr", "mobile"] as const;
export const GATEWAY_CLIENT_NAMES = [
  "control-ui",
  "cli",
  "sdk",
  "nostr",
  "mobile-ios",
  "mobile-android",
] as const;

export type GatewayClientMode = (typeof GATEWAY_CLIENT_MODES)[number];
export type GatewayClientName = (typeof GATEWAY_CLIENT_NAMES)[number];
