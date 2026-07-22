export const CONTROL_UI_BOOTSTRAP_CONFIG_PATH = "/__slide/control-ui-config.json";

export type ControlUiEmbedSandboxMode = "strict" | "scripts" | "trusted";

export type ControlUiBootstrapConfig = {
  basePath?: string;
  embedSandbox?: ControlUiEmbedSandboxMode;
  assistantName?: string;
  assistantAvatar?: string;
  assistantAgentId?: string;
  serverVersion?: string;
  localMediaPreviewRoots?: string[];
  allowExternalEmbedUrls?: boolean;
  [key: string]: unknown;
};
