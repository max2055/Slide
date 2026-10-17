export interface BulkResource {
  type: "instance" | "server" | "network_device";
  id: number;
  label: string;
}
const selected = new Map<string, BulkResource>();
const key = (ref: Pick<BulkResource, "type" | "id">) => `${ref.type}:${ref.id}`;
const changed = () => window.dispatchEvent(new Event("slide-bulk-selection-changed"));
/** An in-memory basket only; server permissions and compatibility are always authoritative. */
export const bulkSelection = {
  values: () => [...selected.values()],
  has: (ref: Pick<BulkResource, "type" | "id">) => selected.has(key(ref)),
  toggle(ref: BulkResource) {
    if (selected.has(key(ref))) selected.delete(key(ref));
    else if (selected.size < 100) selected.set(key(ref), ref);
    changed();
  },
  clear() {
    selected.clear();
    changed();
  },
};
window.addEventListener("slide-permissions-loaded", () => bulkSelection.clear());
window.addEventListener("slide-session-expired", () => bulkSelection.clear());
