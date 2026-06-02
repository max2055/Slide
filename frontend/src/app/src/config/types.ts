/**
 * Backward-compatibility type stub for OpenClawConfig.
 *
 * The original `config/types.openclaw.js` was removed during OpenClaw
 * migration cleanup (Phase 115). This stub preserves the type name so
 * that live modules (auto-reply, infra) can still reference it without
 * import errors. It covers the subset of properties actually accessed
 * across the codebase as of Phase 115.
 */

export interface OpenClawConfig {
  agents?: {
    defaults?: Record<string, unknown>;
    list?: Array<Record<string, unknown>>;
  };
  session?: Record<string, unknown>;
  update?: {
    auto?: unknown;
    channel?: unknown;
    checkOnStart?: unknown;
  };
  bindings?: unknown;
}
