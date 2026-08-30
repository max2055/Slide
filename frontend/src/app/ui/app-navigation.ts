import type { Tab } from "./navigation.ts";

type NavigationContext = {
  id?: unknown;
  session?: unknown;
  serverId?: unknown;
  networkDeviceId?: unknown;
};

/** Build the URL after a cross-view navigation event without dropping detail context. */
export function buildNavigationUrl(currentUrl: URL | string, tab: Tab, context: NavigationContext = {}): URL {
  const { id, session, serverId, networkDeviceId } = context;
  const effectiveServerId = serverId ?? (tab === "server-detail" ? id : undefined);
  const effectiveNetworkDeviceId = networkDeviceId ?? (tab === "network-device-detail" ? id : undefined);
  const effectiveInstanceId = tab === "instance-detail" ? id : undefined;
  const url = new URL(currentUrl.toString());

  url.searchParams.set("tab", tab);
  if (effectiveServerId) url.searchParams.set("id", String(effectiveServerId));
  else if (effectiveInstanceId) url.searchParams.set("id", String(effectiveInstanceId));
  else url.searchParams.delete("id");
  if (effectiveNetworkDeviceId) url.searchParams.set("networkDeviceId", String(effectiveNetworkDeviceId));
  else url.searchParams.delete("networkDeviceId");
  if (session) url.searchParams.set("session", String(session));
  else url.searchParams.delete("session");
  if (tab !== "docs") url.hash = "";
  return url;
}
