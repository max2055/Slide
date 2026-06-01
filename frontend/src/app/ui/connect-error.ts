import { normalizeLowercaseStringOrEmpty } from "./string-coerce.ts";

type ErrorWithMessage = {
  message?: unknown;
};

function normalizeErrorMessage(message: unknown): string {
  if (typeof message === "string") return message;
  if (message instanceof Error && typeof message.message === "string") return message.message;
  return "unknown error";
}

export function formatConnectError(error: unknown): string {
  const message = error && typeof error === 'object'
    ? normalizeErrorMessage((error as ErrorWithMessage).message)
    : normalizeErrorMessage(error);
  const normalized = normalizeLowercaseStringOrEmpty(message);
  if (normalized === "fetch failed" || normalized === "failed to fetch" || normalized === "connect failed") {
    return "connection failed";
  }
  return message;
}
