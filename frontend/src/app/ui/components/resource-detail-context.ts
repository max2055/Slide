export type DetailResourceType = "instance" | "server" | "network_device";
export interface DetailWindow {
  from: string;
  to: string;
}
export const detailTabs = {
  instance: "instance-detail",
  server: "server-detail",
  network_device: "network-device-detail",
};
export const listTabs = {
  instance: "instances-db",
  server: "servers",
  network_device: "network-devices",
};
const windows = new Map<string, DetailWindow>();
/** Freeze a default window once per resource entry; never borrow another resource's window. */
export function detailWindow(type: string, id: number): DetailWindow {
  const p = new URL(location.href).searchParams,
    key = `${type}:${id}`;
  const from = p.get("metricFrom"),
    to = p.get("metricTo");
  if (
    p.get("metricResource") === key &&
    from &&
    to &&
    Number.isFinite(Date.parse(from)) &&
    Number.isFinite(Date.parse(to)) &&
    Date.parse(from) < Date.parse(to)
  )
    return { from: new Date(from).toISOString(), to: new Date(to).toISOString() };
  if (!windows.has(key)) {
    const now = Date.now();
    windows.set(key, {
      from: new Date(now - 3600000).toISOString(),
      to: new Date(now).toISOString(),
    });
  }
  return windows.get(key)!;
}
export function detailReturnUrl(
  type: DetailResourceType,
  id: number,
  range = detailWindow(type, id),
) {
  const p = new URLSearchParams(location.search);
  p.delete("tab");
  p.delete("id");
  p.delete("serverId");
  p.delete("networkDeviceId");
  p.set(type === "network_device" ? "networkDeviceId" : "id", String(id));
  p.set("metricResource", `${type}:${id}`);
  p.set("metricFrom", range.from);
  p.set("metricTo", range.to);
  return `/${detailTabs[type]}?${p}`;
}
export function resourceContextUrl(
  type: DetailResourceType,
  id: number,
  tab: string,
  range = detailWindow(type, id),
) {
  const p = new URLSearchParams({
    tab,
    resource: `${type}:${id}`,
    from: range.from,
    to: range.to,
    returnTo: detailReturnUrl(type, id, range),
  });
  if (tab === "events") p.set("view", "events");
  return `${location.pathname.replace(/\/(?:instance-detail|server-detail|network-device-detail)\/?$/, "/")}?${p}`;
}
export function detailTabKeydown(event: KeyboardEvent) {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  const target = event.target as HTMLElement,
    root = event.currentTarget as HTMLElement;
  const tabs = [...root.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
  const index = tabs.indexOf(target as HTMLButtonElement);
  if (index < 0) return;
  event.preventDefault();
  const next =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? tabs.length - 1
        : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
  tabs[next]?.focus();
  tabs[next]?.click();
}
interface ListReturn {
  type: DetailResourceType;
  id: number;
  state: Record<string, string>;
  position: { page: number; left: number; top: number };
  url: string;
}
export function saveListReturn(
  type: DetailResourceType,
  id: number,
  state: Record<string, string>,
  position: ListReturn["position"],
) {
  const token = crypto.randomUUID();
  const p = new URLSearchParams({ tab: listTabs[type], restoreList: token });
  const record: ListReturn = { type, id, state, position, url: `/?${p}` };
  try {
    sessionStorage.setItem(`resource-return:${token}`, JSON.stringify(record));
  } catch {
    return "";
  }
  return token;
}
export function restoredListState(type: string): ListReturn | null {
  const token = new URL(location.href).searchParams.get("restoreList");
  if (!token || !/^[a-f0-9-]{36}$/.test(token)) return null;
  try {
    const r = JSON.parse(sessionStorage.getItem(`resource-return:${token}`) || "null");
    return r?.type === type && Number.isSafeInteger(r.id) && r.position && r.state ? r : null;
  } catch {
    return null;
  }
}
export function captureListReturn(
  host: HTMLElement,
  type: DetailResourceType,
  id: number,
  state: Record<string, string>,
) {
  const root = host.shadowRoot ?? host;
  const table = root.querySelector("resource-metrics-table") as HTMLElement & {
    capturePosition?: () => ListReturn["position"];
  };
  const token = saveListReturn(
    type,
    id,
    state,
    table?.capturePosition?.() ?? { page: 1, left: 0, top: 0 },
  );
  const url = new URL(location.href);
  url.searchParams.delete("restoreList");
  url.searchParams.delete("metricResource");
  url.searchParams.delete("metric");
  url.searchParams.delete("metricFrom");
  url.searchParams.delete("metricTo");
  url.searchParams.delete("returnTo");
  if (token) url.searchParams.set("listReturn", token);
  history.replaceState({}, "", url);
  windows.delete(`${type}:${id}`);
}
export function returnToResourceList(type: DetailResourceType): boolean {
  const token = new URL(location.href).searchParams.get("listReturn");
  if (!token || !/^[a-f0-9-]{36}$/.test(token)) return false;
  try {
    const r = JSON.parse(sessionStorage.getItem(`resource-return:${token}`) || "null");
    if (r?.type !== type) return false;
    const url = new URL(r.url, location.origin);
    if (
      url.origin !== location.origin ||
      url.pathname !== "/" ||
      url.searchParams.get("tab") !== listTabs[type]
    )
      return false;
    history.pushState({}, "", url);
    window.dispatchEvent(new CustomEvent("slide-navigate", { detail: { tab: listTabs[type] } }));
    return true;
  } catch {
    return false;
  }
}
/** Session-local navigation history must not survive account/authority changes. */
function eraseListHistory() {
  windows.clear();
  try {
    for (const key of Object.keys(sessionStorage))
      if (key.startsWith("resource-return:")) sessionStorage.removeItem(key);
  } catch {
    /* Optional storage. */
  }
}
if (typeof window !== "undefined") {
  window.addEventListener("slide-session-expired", eraseListHistory);
  window.addEventListener("slide-permissions-loaded", eraseListHistory);
}
