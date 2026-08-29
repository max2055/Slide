import oracledb from 'oracledb';

let initialized = false;
let initializationError: Error | undefined;

/**
 * node-oracledb 6 defaults to Thin mode, which cannot connect to Oracle 11g.
 * Thick mode is opt-in in source deployments because Oracle Instant Client is
 * separately licensed; the production API image bundles a validated ARM64
 * client and enables Thick mode through its image/Compose defaults.
 */
export function initializeOracleClient(env: NodeJS.ProcessEnv = process.env): void {
  if (initialized || !oracledb.thin) return;
  const requestedMode = env.NODE_ORACLEDB_DRIVER_MODE?.trim().toLowerCase();
  const libDir = env.NODE_ORACLEDB_CLIENT_LIB_DIR?.trim();
  const shouldUseThick = requestedMode === 'thick' || (requestedMode === undefined && Boolean(libDir));
  if (!shouldUseThick) {
    initialized = true;
    return;
  }

  try {
    oracledb.initOracleClient(libDir ? { libDir } : {});
    initialized = true;
    console.log(`[Oracle] Thick mode enabled${libDir ? ` (libDir=${libDir})` : ''}`);
  } catch (error) {
    initializationError = error instanceof Error ? error : new Error(String(error));
    initialized = true;
    console.error('[Oracle] Thick mode initialization failed:', initializationError.message);
  }
}

export function ensureOracleClientReady(): void {
  if (initializationError) {
    throw new Error(`ORACLE_THICK_MODE_UNAVAILABLE: ${initializationError.message}`);
  }
}

export function formatOracleConnectionError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('NJS-138')) {
    return 'ORACLE_LEGACY_SERVER_REQUIRES_THICK_MODE: Oracle 11g requires Thick mode. Configure NODE_ORACLEDB_DRIVER_MODE=thick, install Oracle Instant Client 19c or compatible, and set NODE_ORACLEDB_CLIENT_LIB_DIR (or LD_LIBRARY_PATH).';
  }
  if (message.includes('DPI-1047') || message.includes('ORACLE_THICK_MODE_UNAVAILABLE')) {
    return `ORACLE_THICK_MODE_UNAVAILABLE: Oracle Instant Client is not available. Install a compatible client and configure NODE_ORACLEDB_CLIENT_LIB_DIR (or LD_LIBRARY_PATH). Details: ${message}`;
  }
  return message;
}
