/**
 * Single source of truth for Slide branding strings.
 *
 * Compile-time defaults + runtime overrides from backend API.
 * All consumers use getter functions so values update immediately
 * when the user changes branding settings (no reload needed).
 *
 * Always import getter functions from here; never hardcode branding strings.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

import { apiClient, authFetch } from '../../api/index.js';

/** Shape returned by GET /api/branding/config */
export interface BrandingConfig {
  cli_name: string;
  product_name: string;
  env_prefix: string;
  state_dir: string;
}

// ---------------------------------------------------------------------------
// Compile-time defaults (fallback when DB is unavailable)
// ---------------------------------------------------------------------------

const DEFAULTS = {
  CLI_NAME: "slide",
  PRODUCT_NAME: "Slide",
  ENV_PREFIX: "SLIDE",
  STATE_DIR: ".slide",
} as const;

// ---------------------------------------------------------------------------
// Memory cache (loaded when authentication is ready)
// ---------------------------------------------------------------------------

let _cache: BrandingConfig | null = null;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

let requestVersion = 0;
let activeRequest: AbortController | null = null;
const listeners = new Set<() => void>();

/** Subscribe to cache replacement, including logout reset. */
export function subscribeBranding(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function notifyConsumers(): void {
  for (const listener of listeners) listener();
}

/** Invalidate pending reads before another authentication session can start. */
export function resetBrandingCache(): void {
  activeRequest?.abort();
  activeRequest = null;
  requestVersion++;
  _cache = null;
  notifyConsumers();
}

async function _loadFromApi(): Promise<void> {
  activeRequest?.abort();
  activeRequest = null;
  const version = ++requestVersion;
  if (typeof window === "undefined") return;
  const controller = new AbortController();
  activeRequest = controller;
  try {
    if (!apiClient.getToken()) return;
    const session = apiClient.getSessionContext();
    const resp = await authFetch("/api/branding/config", { signal: controller.signal });
    if (!resp.ok) return;
    const data: unknown = await resp.json();
    if (version !== requestVersion || session !== apiClient.getSessionContext() || !apiClient.getToken()) return;
    if (!data || typeof data !== "object") return;
    const config = data as BrandingConfig;
    if (![config.cli_name, config.product_name, config.env_prefix, config.state_dir]
      .every(value => typeof value === "string")) return;
    _cache = config;
    notifyConsumers();
  } catch {
    // One attempt per explicit refresh; keep defaults or the last valid snapshot.
  } finally {
    if (activeRequest === controller) activeRequest = null;
  }
}

// ---------------------------------------------------------------------------
// Public getters (all existing import points use these)
// ---------------------------------------------------------------------------

/** CLI binary name shown to users (e.g., "slide") */
export function getCliName(): string {
  return _cache?.cli_name ?? DEFAULTS.CLI_NAME;
}

/** Human-readable product name (e.g., "Slide") */
export function getProductName(): string {
  return _cache?.product_name ?? DEFAULTS.PRODUCT_NAME;
}

/** Prefix for environment variables (e.g., "SLIDE") */
export function getEnvPrefix(): string {
  return _cache?.env_prefix ?? DEFAULTS.ENV_PREFIX;
}

/** State directory name (e.g., ".slide") */
export function getStateDir(): string {
  return _cache?.state_dir ?? DEFAULTS.STATE_DIR;
}

// ---------------------------------------------------------------------------
// Helper functions (signatures stay unchanged, internally use getters)
// ---------------------------------------------------------------------------

/** Build env var name from suffix: buildEnvVar("STATE_DIR") => "SLIDE_STATE_DIR" */
export function buildEnvVar(suffix: string): string {
  return `${getEnvPrefix()}_${suffix}`;
}

/** Build Symbol key within product namespace: buildSymbolKey("foo") => "slide.foo" */
export function buildSymbolKey(key: string): string {
  return `${getProductName().toLowerCase()}.${key}`;
}

/** Build CLI command display text: buildCliCmd("update") => "slide update" */
export function buildCliCmd(sub?: string): string {
  const name = getCliName();
  return sub ? `${name} ${sub}` : name;
}

/** Build User-Agent header string: buildUserAgent() => "Slide-Gateway/1.0" */
export function buildUserAgent(): string {
  return `${getProductName()}-Gateway/1.0`;
}

// ---------------------------------------------------------------------------
// Cache management (used by branding-settings component)
// ---------------------------------------------------------------------------

/**
 * Force-refresh the runtime cache from the backend API.
 * Called after branding settings are saved so changes take effect immediately.
 */
export async function refreshBrandingCache(): Promise<void> {
  await _loadFromApi();
}

/** Return the current snapshot (defaults merged with any cached overrides). */
export function getBrandingSnapshot(): BrandingConfig {
  return {
    cli_name: getCliName(),
    product_name: getProductName(),
    env_prefix: getEnvPrefix(),
    state_dir: getStateDir(),
  };
}
