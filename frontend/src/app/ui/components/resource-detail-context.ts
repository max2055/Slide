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
export function detailResourceId(type: DetailResourceType): number | null {
  const { pathname, searchParams } = new URL(location.href);
  if (!pathname.replace(/\/$/, "").endsWith(`/${detailTabs[type]}`)) return null;
  const raw = type === "network_device" ? searchParams.get("networkDeviceId") ?? searchParams.get("id") : searchParams.get("id");
  const id = Number(raw);
  return raw && /^[1-9]\d*$/.test(raw) && Number.isSafeInteger(id) ? id : null;
}

export function readDetailTab<T extends string>(type: DetailResourceType, id: number, tabs: readonly T[]): T {
  if (detailResourceId(type) !== id) return tabs[0];
  const p = new URLSearchParams(location.search);
  const explicit = p.get("detailTab");
  const selected = explicit ?? (p.get("metricResource") === `${type}:${id}` ? "metrics" : null);
  return tabs.find(tab => tab === selected) ?? tabs[0];
}

const approvedDetailEntries = new WeakMap<HTMLElement, string>();

export function selectDetailTab(host: HTMLElement, active: string, tab: string, apply: () => void, fromHistory = false) {
  if (tab === active) return;
  const config = (host.shadowRoot ?? host).querySelector("resource-collection-section") as
    import("./resource-collection-section.js").ResourceCollectionSection | null;
  if (!fromHistory) {
    const destination = new URL(location.href);
    destination.searchParams.set("detailTab", tab);
    const select = () => { history.pushState(history.state, "", destination); apply(); };
    if (config) config.confirmDiscard(select);
    else select();
    return;
  }
  if (!config) { apply(); return; }

  const browser = window.navigation;
  const target = browser?.currentEntry?.key;
  if (target && approvedDetailEntries.get(host) === target) {
    approvedDetailEntries.delete(host);
    apply();
    return;
  }
  const origin = config.editorHistoryKey;
  let applied = false;
  let restored: Promise<NavigationHistoryEntry | null> | undefined;
  config.confirmDiscard(() => {
    if (!restored || !target) { applied = true; apply(); return; }
    void restored.then(entry => {
      if (!entry || !config.isConnected || browser.currentEntry?.key !== origin) return;
      approvedDetailEntries.set(host, target);
      return browser.traverseTo(target).finished.catch(() => {
        if (approvedDetailEntries.get(host) === target) approvedDetailEntries.delete(host);
      });
    });
  });
  if (!applied && origin && target && target !== origin) {
    // popstate has already moved the history cursor. Return to the editor entry
    // while the dialog is open, leaving both URLs and history states intact.
    restored = browser.traverseTo(origin).finished.catch(() => null);
  }
}

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
  if (!p.has("detailTab") && new URLSearchParams(location.search).get("metricResource") !== `${type}:${id}`) {
    p.set("detailTab", "overview");
  }
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
  url.searchParams.delete("listReturn");
  url.searchParams.delete("detailTab");
  url.searchParams.delete("metricResource");
  url.searchParams.delete("metric");
  url.searchParams.delete("metricFrom");
  url.searchParams.delete("metricTo");
  url.searchParams.delete("returnTo");
  if (token) {
    url.searchParams.set("listReturn", token);
    url.searchParams.set("restoreList", token);
  }
  history.replaceState(history.state, "", url);
  windows.delete(`${type}:${id}`);
}
function savedListUrl(type: DetailResourceType): URL | null {
  const token = new URL(location.href).searchParams.get("listReturn");
  if (!token || !/^[a-f0-9-]{36}$/.test(token)) return null;
  try {
    const r = JSON.parse(sessionStorage.getItem(`resource-return:${token}`) || "null");
    if (r?.type !== type || r.id !== detailResourceId(type)) return null;
    const url = new URL(r.url, location.origin);
    if (
      url.origin !== location.origin ||
      url.pathname !== "/" ||
      url.searchParams.get("tab") !== listTabs[type]
    )
      return null;
    return url;
  } catch {
    return null;
  }
}

export function returnToResourceList(type: DetailResourceType, edit?: { id: number; section: 'ssh' }): boolean {
  const url = savedListUrl(type) ?? (edit ? new URL(`/?tab=${listTabs[type]}`, location.origin) : null);
  if (!url) return false;
  url.pathname = `/${listTabs[type]}`;
  if (edit) {
    url.searchParams.set('edit', String(edit.id));
    url.searchParams.set('editSection', edit.section);
  }
  history.pushState({}, "", url);
  window.dispatchEvent(new PopStateEvent("popstate"));
  return true;
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
