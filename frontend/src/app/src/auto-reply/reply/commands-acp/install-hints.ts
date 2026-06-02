import { existsSync } from "node:fs";
import path from "node:path";
import type { SlideConfig } from "../../../config/types.js";
import { resolveBundledPluginInstallCommandHint } from "../../../plugins/bundled-sources.js";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "../../../shared/string-coerce.js";

export function resolveAcpInstallCommandHint(cfg: SlideConfig): string {
  const configured = normalizeOptionalString(cfg.acp?.runtime?.installCommand);
  if (configured) {
    return configured;
  }
  const workspaceDir = process.cwd();
  const backendId = normalizeOptionalLowercaseString(cfg.acp?.backend) ?? "acpx";
  if (backendId === "acpx") {
    const workspaceLocalPath = path.join(workspaceDir, "extensions", "acpx");
    if (existsSync(workspaceLocalPath)) {
      return `Install the plugin from Settings → Plugins (workspace path: ${workspaceLocalPath})`;
    }
    const bundledInstallHint = resolveBundledPluginInstallCommandHint({
      pluginId: backendId,
      workspaceDir,
    });
    if (bundledInstallHint) {
      const localPath = bundledInstallHint.replace(/^Install the plugin from Settings → Plugins \(workspace path: /u, "");
      const resolvedLocalPath = path.resolve(localPath);
      const relativeToWorkspace = path.relative(workspaceDir, resolvedLocalPath);
      const belongsToWorkspace =
        relativeToWorkspace.length === 0 ||
        (!relativeToWorkspace.startsWith("..") && !path.isAbsolute(relativeToWorkspace));
      if (belongsToWorkspace && existsSync(resolvedLocalPath)) {
        return bundledInstallHint;
      }
    }
    return "Install the acpx plugin from Settings → Plugins";
  }
  return `Install and enable the plugin that provides ACP backend "${backendId}".`;
}
