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
// Memory cache (populated asynchronously on first import)
// ---------------------------------------------------------------------------

let _cache: BrandingConfig | null = null;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function _loadFromApi(): Promise<void> {
  try {
    const resp = await fetch("/api/branding/config");
    if (resp.ok) {
      _cache = (await resp.json()) as BrandingConfig;
    }
  } catch {
    // API unavailable — keep using DEFAULTS
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

// ---------------------------------------------------------------------------
// Kick off async fetch on first import (non-blocking)
// ---------------------------------------------------------------------------

_loadFromApi();
