import { constants, openSync, closeSync, fstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export class ResourceManifestError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

// Private values and native error messages must never appear in diagnostics.
function restrictedFile(file, repository) {
  let fd;
  try {
    if (typeof file !== 'string' || !path.isAbsolute(file)) throw new Error();
    const resolved = realpathSync(file);
    const relative = path.relative(realpathSync(repository), resolved);
    if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) throw new Error();
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) throw new Error();
    return readFileSync(fd, 'utf8');
  } catch {
    throw new ResourceManifestError('RESOURCE_FILE_UNSAFE_OR_UNREADABLE');
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function loadTestResource({ enabled = false, resource, env = process.env, repository = process.cwd() } = {}) {
  // Default test collection neither reads private files nor discovers shared DBs.
  if (!enabled) return undefined;
  if (!env.SLIDE_TEST_RESOURCE_MANIFEST) throw new ResourceManifestError('SLIDE_TEST_RESOURCE_MANIFEST_REQUIRED');
  if (!resource || !/^[a-z][a-z0-9-]*$/.test(resource)) throw new ResourceManifestError('LOGICAL_RESOURCE_REQUIRED');
  let manifest;
  try {
    manifest = JSON.parse(restrictedFile(env.SLIDE_TEST_RESOURCE_MANIFEST, repository));
  } catch (error) {
    if (error instanceof ResourceManifestError) throw error;
    throw new ResourceManifestError('RESOURCE_MANIFEST_INVALID');
  }
  if (manifest.version !== 1 || !Object.hasOwn(manifest.resources ?? {}, resource)) throw new ResourceManifestError('RESOURCE_NOT_CONFIGURED');
  const selected = manifest.resources[resource];
  if (!selected || typeof selected !== 'object' || !selected.owner || !['database', 'vm', 'model'].includes(selected.kind)) throw new ResourceManifestError('RESOURCE_ENTRY_INVALID');
  if (selected.kind === 'database') {
    let profiles;
    try { profiles = JSON.parse(restrictedFile(selected.profilesFile, repository)); }
    catch (error) {
      if (error instanceof ResourceManifestError) throw error;
      throw new ResourceManifestError('RESOURCE_PROFILES_INVALID');
    }
    if (typeof selected.profile !== 'string' || !Object.hasOwn(profiles, selected.profile)) throw new ResourceManifestError('RESOURCE_PROFILE_MISSING');
    const profile = profiles[selected.profile];
    if (!profile || typeof profile.host !== 'string' || typeof profile.user !== 'string' || typeof profile.password !== 'string'
      || !Number.isInteger(profile.port) || profile.port < 1 || profile.port > 65535) throw new ResourceManifestError('RESOURCE_PROFILE_INVALID');
    return { ...selected, connection: profile };
  }
  if (selected.kind === 'vm') {
    if (typeof selected.host !== 'string' || typeof selected.user !== 'string' || !Number.isInteger(selected.port)
      || selected.port < 1 || selected.port > 65535) throw new ResourceManifestError('RESOURCE_ENTRY_INVALID');
    const password = restrictedFile(selected.passwordFile, repository).trimEnd();
    if (!password) throw new ResourceManifestError('RESOURCE_SECRET_EMPTY');
    return { ...selected, password };
  }
  // This validates readability only. Model routing/decryption and budget locking
  // remain the responsibility of the existing application and shared ledger.
  restrictedFile(selected.envFile, repository);
  restrictedFile(selected.budgetLedger, repository);
  return selected;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 3 || args[0] !== '--real' || args[1] !== '--resource') throw new ResourceManifestError('USAGE: --real --resource <logical-name>');
    const repository = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    loadTestResource({ enabled: true, resource: args[2], repository });
    console.log('Resource manifest: selected resource readable; no network request made.');
  } catch (error) {
    console.error(error instanceof ResourceManifestError ? error.code : 'RESOURCE_CHECK_FAILED');
    process.exitCode = 1;
  }
}
