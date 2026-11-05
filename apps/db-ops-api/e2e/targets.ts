const DEFAULT_WEB_BASE = "http://localhost:5173";
const DEFAULT_API_BASE = "http://localhost:3000";

function resolveBase(name: string, fallback: string): string {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  const trimmed = raw.trim().replace(/\/$/, "");
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`${name} must be an absolute http(s) URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${name} must use http or https`);
  }
  if (url.username || url.password) {
    throw new Error(`${name} must not include credentials`);
  }
  return trimmed;
}

/** Page origin for Playwright baseURL. Blank falls back to the local frontend; an invalid value throws. */
export function webBaseURL(): string {
  return resolveBase("SLIDE_E2E_BASE_URL", DEFAULT_WEB_BASE);
}

/** API origin. Independent from the page origin so a frontend port change cannot silently retarget API calls. */
export function apiBaseURL(): string {
  return resolveBase("SLIDE_E2E_API_URL", DEFAULT_API_BASE);
}

export function apiURL(path: string): string {
  if (!path.startsWith("/")) throw new Error("API path must start with /");
  return `${apiBaseURL()}${path}`;
}
