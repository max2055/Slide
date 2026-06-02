/**
 * Single source of truth for Slide branding strings.
 * Always import from here; never hardcode CLI names, env prefixes, or product names.
 */

/** CLI binary name shown to users (e.g., "slide") */
export const CLI_NAME = "slide" as const;

/** Human-readable product name (e.g., "Slide") */
export const PRODUCT_NAME = "Slide" as const;

/** Prefix for environment variables (e.g., "SLIDE") */
export const ENV_PREFIX = "SLIDE" as const;

/** State directory name (e.g., ".slide") */
export const STATE_DIR = ".slide" as const;

/** Build env var name from suffix: buildEnvVar("STATE_DIR") => "SLIDE_STATE_DIR" */
export function buildEnvVar(suffix: string): string {
  return `${ENV_PREFIX}_${suffix}`;
}

/** Build Symbol key within product namespace: buildSymbolKey("foo") => "slide.foo" */
export function buildSymbolKey(key: string): string {
  return `${PRODUCT_NAME.toLowerCase()}.${key}`;
}

/** Build CLI command display text: buildCliCmd("update") => "slide update" */
export function buildCliCmd(sub?: string): string {
  return sub ? `${CLI_NAME} ${sub}` : CLI_NAME;
}

/** Build User-Agent header string: buildUserAgent() => "Slide-Gateway/1.0" */
export function buildUserAgent(): string {
  return `${PRODUCT_NAME}-Gateway/1.0`;
}
