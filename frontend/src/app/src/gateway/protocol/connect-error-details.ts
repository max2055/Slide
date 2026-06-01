export const ConnectErrorDetailCodes = {
  AUTH_TOKEN_MISSING: "AUTH_TOKEN_MISSING",
  AUTH_TOKEN_MISMATCH: "AUTH_TOKEN_MISMATCH",
  AUTH_BOOTSTRAP_TOKEN_INVALID: "AUTH_BOOTSTRAP_TOKEN_INVALID",
  AUTH_PASSWORD_MISSING: "AUTH_PASSWORD_MISSING",
  AUTH_PASSWORD_MISMATCH: "AUTH_PASSWORD_MISMATCH",
  AUTH_RATE_LIMITED: "AUTH_RATE_LIMITED",
  PAIRING_REQUIRED: "PAIRING_REQUIRED",
  CONTROL_UI_DEVICE_IDENTITY_REQUIRED: "CONTROL_UI_DEVICE_IDENTITY_REQUIRED",
  DEVICE_IDENTITY_REQUIRED: "DEVICE_IDENTITY_REQUIRED",
} as const;

export function readConnectErrorDetailCode(details: unknown): string | null {
  if (!details || typeof details !== "object") {
    return null;
  }
  const code = (details as { code?: unknown }).code;
  if (typeof code === "string") {
    return code;
  }
  return null;
}

export function readConnectErrorRecoveryAdvice(details: unknown): string | null {
  if (!details || typeof details !== "object") {
    return null;
  }
  const advice = (details as { recovery?: unknown } | { advice?: unknown }).recovery ??
    (details as { advice?: unknown }).advice;
  if (typeof advice === "string") {
    return advice;
  }
  return null;
}
