import { createRequire } from 'node:module';
import type { Connection } from 'dmdb';

interface LoginParser {
  processServerVersion(version: string, connection: Connection): void;
}

const require = createRequire(import.meta.url);
const serverVersions = new WeakMap<Connection, string>();
let observerInstalled = false;

export function observeDamengServerVersions(): void {
  if (observerInstalled) return;
  observerInstalled = true;
  try {
    // dmdb parses the server release during login but does not expose it on the
    // connection. SQL views return the DM8 product label and build metadata.
    const { Login } = require('dmdb/src/net/msg/login.js') as { Login?: LoginParser };
    if (!Login || typeof Login.processServerVersion !== 'function') return;
    const processVersion = Login.processServerVersion;
    Login.processServerVersion = function (version, connection) {
      processVersion.call(this, version, connection);
      if (typeof version === 'string') serverVersions.set(connection, version);
    };
  } catch {
    // A different driver layout leaves the release unknown and keeps login available.
  }
}

export function getDamengServerVersion(connection: Connection): string | undefined {
  return serverVersions.get(connection);
}
