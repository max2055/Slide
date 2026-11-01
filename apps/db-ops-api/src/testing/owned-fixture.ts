/**
 * MAX-238 / NATIVE-CONFIGURATION-FLOW-R3 — owned disposable databases.
 *
 * A `CREATE DATABASE`/`DROP DATABASE` fixture must only ever destroy a schema
 * this exact run created. An environment variable, a `max238_` name prefix or a
 * PID is not proof of ownership: a neighbour can use the same port, a PID can be
 * reused, and a fixed name belongs to whoever is already there.
 *
 * The contract here is the same one the accepted R5 container lifecycle uses:
 * one run-random nonce, a handle written to disk *before* the schema exists and
 * recording the exact server identity, schema name and owner, a create that is
 * never preceded by a DROP, and a cleanup that re-verifies the handle against the
 * live server before it drops anything. Anything unknown is non-zero and keeps
 * the handle for a human instead of guessing.
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export const OWNED_FIXTURE_FORMAT = 'max238.owned-fixture.v1';
const NONCE = /^[a-z0-9]{8,64}$/;
const PURPOSE = /^[a-z][a-z0-9]{0,23}$/;

export type FixtureQuery = {
  query(sql: string, values?: unknown[]): Promise<[unknown, unknown]>;
};

export interface OwnedFixtureServer {
  server_uuid: string;
  hostname: string;
  port: number;
}

interface FixtureHandle {
  format: typeof OWNED_FIXTURE_FORMAT;
  nonce: string;
  purpose: string;
  database: string;
  owner: string;
  server: OwnedFixtureServer;
  state: 'planned' | 'created';
  created_at: string;
}

export interface OwnedFixtureOptions {
  nonce: string;
  purpose: string;
  /** Where the handle is written; never a shared/temporary path. */
  handleDir: string;
}

export interface OwnedDatabase {
  readonly nonce: string;
  readonly purpose: string;
  readonly database: string;
  readonly handlePath: string;
  /** Drop only this exact, verified schema; anything unknown throws and keeps the handle. */
  drop(): Promise<void>;
}

/** A run-random nonce; never a PID, port or fixed string. */
export const generateRunNonce = (): string => randomBytes(8).toString('hex');

const checkedNonce = (nonce: string): string => {
  if (typeof nonce !== 'string' || !NONCE.test(nonce)) {
    throw new Error(`refusing fixture without a run-random nonce (got ${String(nonce)})`);
  }
  return nonce;
};
const checkedPurpose = (purpose: string): string => {
  if (typeof purpose !== 'string' || !PURPOSE.test(purpose)) {
    throw new Error(`refusing fixture with an invalid purpose ${String(purpose)}`);
  }
  return purpose;
};

export const ownedDatabaseName = (nonce: string, purpose: string): string =>
  `max238_${checkedPurpose(purpose)}_${checkedNonce(nonce)}`;

const handlePathFor = (handleDir: string, nonce: string, purpose: string): string =>
  join(resolve(handleDir), `max238-${purpose}-${nonce}.json`);

async function serverIdentity(connection: FixtureQuery): Promise<OwnedFixtureServer> {
  const [rows] = await connection.query(
    'SELECT @@server_uuid AS server_uuid, @@hostname AS hostname, @@port AS port',
  ) as unknown as [Array<Record<string, unknown>>, unknown];
  const row = rows?.[0];
  if (!row) throw new Error('could not read the server identity');
  const server: OwnedFixtureServer = {
    server_uuid: String(row.server_uuid ?? ''), hostname: String(row.hostname ?? ''), port: Number(row.port),
  };
  if (!server.server_uuid) throw new Error('the server reported no server_uuid');
  return server;
}

const sameServer = (left: OwnedFixtureServer, right: OwnedFixtureServer): boolean =>
  left.server_uuid === right.server_uuid && left.port === right.port;

const owner = (server: OwnedFixtureServer, nonce: string, purpose: string): string =>
  createHash('sha256').update(`${OWNED_FIXTURE_FORMAT}|${server.server_uuid}|${server.port}|${nonce}|${purpose}`)
    .digest('hex');

function writeHandle(path: string, handle: FixtureHandle): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(handle, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

function readHandle(path: string): FixtureHandle {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<FixtureHandle>;
  if (parsed.format !== OWNED_FIXTURE_FORMAT || typeof parsed.nonce !== 'string'
    || typeof parsed.purpose !== 'string' || typeof parsed.database !== 'string'
    || typeof parsed.owner !== 'string' || !parsed.server || typeof parsed.server.server_uuid !== 'string'
    || (parsed.state !== 'planned' && parsed.state !== 'created')) {
    throw new Error(`fixture handle ${path} is not readable`);
  }
  return parsed as FixtureHandle;
}

async function schemaExists(connection: FixtureQuery, database: string): Promise<boolean> {
  const [rows] = await connection.query(
    'SELECT SCHEMA_NAME AS name FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?', [database],
  ) as unknown as [Array<Record<string, unknown>>, unknown];
  if (!Array.isArray(rows)) throw new Error('could not read information_schema');
  return rows.length > 0;
}

/**
 * Create one schema this run owns by nonce and pre-recorded handle.
 *
 * The handle is written before the CREATE, the CREATE never follows a DROP, and
 * a name that already exists is a refusal: it belongs to someone else.
 */
export async function createOwnedDatabase(
  connection: FixtureQuery, options: OwnedFixtureOptions,
): Promise<OwnedDatabase> {
  const nonce = checkedNonce(options.nonce);
  const purpose = checkedPurpose(options.purpose);
  const database = ownedDatabaseName(nonce, purpose);
  const handlePath = handlePathFor(options.handleDir, nonce, purpose);
  const server = await serverIdentity(connection);
  if (existsSync(handlePath)) {
    throw new Error(`refusing to reuse handle ${handlePath}: this run already recorded a database`);
  }
  const planned: FixtureHandle = {
    format: OWNED_FIXTURE_FORMAT, nonce, purpose, database, owner: owner(server, nonce, purpose), server,
    state: 'planned', created_at: new Date().toISOString(),
  };
  writeHandle(handlePath, planned);

  try {
    await connection.query(`CREATE DATABASE \`${database}\` DEFAULT CHARACTER SET utf8mb4`);
  } catch (error) {
    // A CREATE failure is only safe to forget when the schema is provably absent;
    // a refusal because it already exists keeps the handle and the neighbour.
    try {
      if (!await schemaExists(connection, database)) rmSync(handlePath, { force: true });
    } catch { /* unknown: keep the handle for a human */ }
    throw error;
  }
  writeHandle(handlePath, { ...planned, state: 'created' });

  return {
    nonce, purpose, database, handlePath,
    drop: () => dropOwnedDatabase(connection, { nonce, purpose, handleDir: options.handleDir }),
  };
}

/**
 * Drop one schema only after proving the on-disk handle describes it, this run
 * and this exact server. Anything unknown throws and leaves the handle in place.
 */
export async function dropOwnedDatabase(
  connection: FixtureQuery, options: OwnedFixtureOptions,
): Promise<void> {
  const nonce = checkedNonce(options.nonce);
  const purpose = checkedPurpose(options.purpose);
  const database = ownedDatabaseName(nonce, purpose);
  const handlePath = handlePathFor(options.handleDir, nonce, purpose);
  if (!existsSync(handlePath)) throw new Error(`refusing to drop ${database}: no handle at ${handlePath}`);
  const handle = readHandle(handlePath);
  const live = await serverIdentity(connection);
  if (handle.nonce !== nonce || handle.purpose !== purpose || handle.database !== database
    || handle.owner !== owner(live, nonce, purpose) || !sameServer(handle.server, live)) {
    throw new Error(`refusing to drop ${database}: handle ${handlePath} does not describe this run on this server`);
  }
  if (handle.state !== 'created') throw new Error(`refusing to drop ${database}: handle state is ${handle.state}`);
  await connection.query(`DROP DATABASE \`${database}\``);
  if (await schemaExists(connection, database)) {
    throw new Error(`FAILED to verify removal of ${database}; handle kept at ${handlePath}`);
  }
  rmSync(handlePath, { force: true });
}
