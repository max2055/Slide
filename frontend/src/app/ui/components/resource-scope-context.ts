import type { DetailResourceType } from "./resource-detail-context.js";
/** Consumers refuse incomplete/invalid scopes instead of falling back to an unfiltered list. */
export function readResourceContext() {
  const p = new URLSearchParams(location.search),
    match = /^(instance|server|network_device):([1-9]\d*)$/.exec(p.get("resource") ?? "");
  const from = p.get("from"),
    to = p.get("to"),
    raw = p.get("returnTo");
  if (
    !match ||
    !Number.isSafeInteger(Number(match[2])) ||
    !from ||
    !to ||
    !Number.isFinite(Date.parse(from)) ||
    !Number.isFinite(Date.parse(to)) ||
    Date.parse(from) >= Date.parse(to)
  )
    return null;
  let returnTo = "";
  if (raw) {
    try {
      const u = new URL(raw, location.origin);
      if (
        u.origin === location.origin &&
        /^\/(?:instance-detail|server-detail|network-device-detail)(?:\/|$)/.test(u.pathname)
      )
        returnTo = u.pathname + u.search;
    } catch {}
  }
  return {
    resource: { type: match[1] as DetailResourceType, id: Number(match[2]) },
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
    returnTo,
  };
}
