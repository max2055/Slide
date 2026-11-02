import "../../src/app/styles/tokens.css";
import "../../src/app/styles/base.css";
import "../../src/app/ui/components/app-toast-container.js";
import "../../src/app/ui/views/instances-db.js";
import "../../src/app/ui/views/servers-page.js";
import "../../src/app/ui/views/network-devices-page.js";
import "../../src/app/ui/views/instance-detail.js";
import "../../src/app/ui/views/server-detail.js";
import "../../src/app/ui/views/network-device-detail.js";
import "../../src/app/ui/views/event-center.js";
import "../../src/app/ui/views/audit-center.js";
import "../../src/app/ui/components/investigation-entry.js";
import { readInvestigationEntry } from "../../src/app/ui/controllers/investigation-entry.js";
const main = document.createElement("main");
document.body.append(main, document.createElement("app-toast-container"));
document.body.style.cssText =
  "margin:0;padding:24px;background:var(--bg);color:var(--text);font-family:system-ui;box-sizing:border-box";
const tag: Record<string, string> = {
  "instances-db": "instances-page",
  servers: "servers-page",
  "network-devices": "network-devices-page",
  "instance-detail": "instance-detail-page",
  "server-detail": "server-detail",
  "network-device-detail": "network-device-detail",
  events: "event-center-page",
  "audit-center": "audit-center-page",
  investigations: "investigation-entry",
};
function render() {
  const p = new URLSearchParams(location.search);
  const tab = p.get("tab") ?? location.pathname.split("/").at(-1) ?? "instances-db";
  const el = document.createElement(tag[tab] ?? "instances-page") as any;
  if (tab === "instance-detail") el.instanceId = Number(p.get("id"));
  if (tab === "server-detail") el.serverId = Number(p.get("id") ?? p.get("serverId"));
  if (tab === "network-device-detail") el.deviceId = Number(p.get("networkDeviceId"));
  if (tab === "investigations") el.context = readInvestigationEntry(location.search);
  main.replaceChildren(el);
}
window.addEventListener("slide-navigate", (event) => {
  const d = (event as CustomEvent).detail,
    p = new URL(location.href);
  p.searchParams.set("tab", d.tab);
  if (d.id) p.searchParams.set("id", d.id);
  if (d.serverId) p.searchParams.set("id", d.serverId);
  if (d.networkDeviceId) p.searchParams.set("networkDeviceId", d.networkDeviceId);
  history.pushState({}, "", p);
  render();
});
window.addEventListener("popstate", render);
render();
