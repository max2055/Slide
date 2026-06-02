export interface SlideConfig {
  agents?: {
    defaults?: Record<string, unknown>;
    list?: Array<Record<string, unknown>>;
  };
}

// Stub for former CLI config-file functions (Slide web app does not use config files)
export function loadConfig(): SlideConfig {
  return (typeof window !== "undefined" && (window as any).__SLIDE_CONFIG__) ?? { agents: { defaults: {}, list: [] } };
}
