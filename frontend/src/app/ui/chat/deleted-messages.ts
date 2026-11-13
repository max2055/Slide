import { getSafeLocalStorage } from "../local-storage.ts";

const PREFIX = "slide:deleted:";
const MESSAGE_PREFIX = "slide:deleted-message:";

export class DeletedMessages {
  private key: string;
  private messagePrefix: string;
  private _keys = new Set<string>();
  private unsaved = new Map<string, boolean>();

  constructor(sessionKey: string) {
    this.key = PREFIX + sessionKey;
    this.messagePrefix = MESSAGE_PREFIX + encodeURIComponent(sessionKey) + ":";
    this.refresh();
  }

  has(key: string): boolean {
    return this._keys.has(key);
  }

  delete(key: string): void {
    this.write(key, true);
  }

  restore(key: string): void {
    this.write(key, false);
  }

  clear(): void {
    this.refresh();
    for (const key of [...this._keys]) this.restore(key);
  }

  handlesStorageKey(key: string | null): boolean {
    return key === null || key === this.key || key.startsWith(this.messagePrefix);
  }

  refresh(): void {
    try {
      const storage = getSafeLocalStorage();
      if (!storage) return;
      const keys = new Set<string>();
      // Keep the old array as a baseline; per-message overrides also represent restores.
      const raw = storage.getItem(this.key);
      try {
        const legacy = raw ? JSON.parse(raw) : [];
        if (Array.isArray(legacy)) {
          for (const key of legacy) if (typeof key === "string") keys.add(key);
        }
      } catch {
        // A malformed legacy value must not hide valid per-message records.
      }
      for (let i = 0; i < storage.length; i++) {
        const storedKey = storage.key(i);
        if (!storedKey?.startsWith(this.messagePrefix)) continue;
        const key = storedKey.slice(this.messagePrefix.length);
        const value = storage.getItem(storedKey);
        if (value === "true") keys.add(key);
        else if (value === "false") keys.delete(key);
      }
      for (const [key, deleted] of this.unsaved) {
        if (deleted) keys.add(key);
        else keys.delete(key);
      }
      this._keys = keys;
    } catch {
      // Storage can be unavailable; preserve the current in-memory state.
    }
  }

  private write(key: string, deleted: boolean): void {
    if (deleted) this._keys.add(key);
    else this._keys.delete(key);
    this.unsaved.set(key, deleted);
    try {
      // Different messages never share a write key, including simultaneous tab writes.
      const storage = getSafeLocalStorage();
      if (storage) {
        storage.setItem(this.messagePrefix + key, String(deleted));
        this.unsaved.delete(key);
      }
    } catch {
      // Keep deletion usable in this tab when browser storage is unavailable.
    }
  }
}
