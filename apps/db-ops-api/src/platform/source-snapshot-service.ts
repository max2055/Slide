import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, rename, rm, lstat, realpath } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import ts from 'typescript';
import { parse as parseYaml } from 'yaml';

export interface SourceBinding { commitSha: string; treeDigest: string }
export interface SourceIdentity { releaseId: string; commitSha: string; projectId: string }
export interface SourceFile { path: string; content: string }
export interface SourceManifest extends SourceIdentity {
  schemaVersion: 1; treeDigest: string; createdAt: string;
  files: Array<{ path: string; digest: string; bytes: number }>;
  signature: string;
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const MAX_FILE_BYTES = 512 * 1024;
const MAX_SNAPSHOT_BYTES = 32 * 1024 * 1024;
const MAX_FILES = 4000;

function releaseName(value: string): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(value)) throw new Error('SOURCE_RELEASE_INVALID');
  return value;
}
export function assertSourcePath(path: string): void {
  if (typeof path !== 'string' || path.length > 512 || !/^[a-zA-Z0-9_./-]+$/.test(path)
    || path.split('/').some(part => !part || part === '.' || part === '..' || part.startsWith('.'))
    || /(^|\/)(node_modules|dist|coverage|secrets)(\/|$)/i.test(path)
    || !/\.(ts|tsx|js|mjs|cjs|json|sql|yaml|yml|sh|md|html|css)$/.test(path)) throw new Error('SOURCE_PATH_INVALID');
}
export function assertSourceContent(content: string, path = ''): void {
  if (Buffer.byteLength(content) > MAX_FILE_BYTES || content.includes('\0')) throw new Error('SOURCE_FILE_TOO_LARGE');
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:glpat-|gh[pousr]_|sk-(?:ant-)?)[a-zA-Z0-9_-]{16,}|(?:password|passwd|secret|token|api[_-]?key)["']?\s*[:=]\s*["'`][^"'`\r\n]{4,}["'`]|[a-z]+:\/\/[^\s/:]+:[^\s/@]+@/i.test(content)) throw new Error('SOURCE_SENSITIVE_CONTENT');
  if (/\.(json|ya?ml)$/.test(path)) {
    let parsed: unknown;
    try { parsed = path.endsWith('.json') ? JSON.parse(content) : parseYaml(content, { maxAliasCount: 0 }); }
    catch { throw new Error('SOURCE_CONFIG_UNSCANNABLE'); }
    const sensitive = /password|passwd|pwd|secret|token|api[_-]?key|authorization|credential|private[_-]?key|connection[_-]?string/i;
    const visit = (value: unknown): void => {
      if (!value || typeof value !== 'object') return;
      for (const [key, child] of Object.entries(value)) {
        if (sensitive.test(key) && child !== null && child !== undefined
          && (typeof child !== 'string' || child.trim())) throw new Error('SOURCE_SENSITIVE_CONTENT');
        visit(child);
      }
    };
    visit(parsed);
  }
}
export function describeSourceFiles(input: SourceFile[]) {
  return [...input].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
    .map(file => ({ path: file.path, digest: hash(file.content), bytes: Buffer.byteLength(file.content) }));
}

export class SourceSnapshotService {
  constructor(private readonly root: string, private readonly signingKey: string) {
    if (Buffer.byteLength(signingKey) < 32) throw new Error('SOURCE_SIGNING_KEY_INVALID');
  }
  private sign(manifest: Omit<SourceManifest, 'signature'>): string {
    return createHmac('sha256', this.signingKey).update(JSON.stringify(manifest)).digest('hex');
  }
  async publish(identity: SourceIdentity, input: SourceFile[]): Promise<SourceManifest> {
    releaseName(identity.releaseId);
    if (!/^[a-f0-9]{40}$/.test(identity.commitSha) || !/^[0-9]{1,20}$/.test(identity.projectId)) throw new Error('SOURCE_IDENTITY_INVALID');
    if (!input.length || input.length > MAX_FILES) throw new Error('SOURCE_FILE_COUNT_INVALID');
    const paths = new Set<string>(); let total = 0;
    for (const file of input) {
      assertSourcePath(file.path); assertSourceContent(file.content, file.path);
      if (paths.has(file.path)) throw new Error('SOURCE_DUPLICATE_PATH'); paths.add(file.path);
      total += Buffer.byteLength(file.content);
    }
    if (total > MAX_SNAPSHOT_BYTES) throw new Error('SOURCE_SNAPSHOT_TOO_LARGE');
    const sorted = input;
    const files = describeSourceFiles(input);
    const unsigned = { schemaVersion: 1 as const, ...identity, treeDigest: hash(JSON.stringify(files)), createdAt: new Date().toISOString(), files };
    const manifest = { ...unsigned, signature: this.sign(unsigned) };
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const staging = await mkdtemp(join(this.root, '.staging-'));
    try {
      for (const file of sorted) {
        const dest = join(staging, file.path); await mkdir(dirname(dest), { recursive: true, mode: 0o700 });
        await writeFile(dest, file.content, { flag: 'wx', mode: 0o400 });
      }
      await writeFile(join(staging, 'manifest.json'), JSON.stringify(manifest), { flag: 'wx', mode: 0o400 });
      await rename(staging, join(this.root, identity.releaseId));
      return manifest;
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      if (['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) {
        const existing = await this.manifest(identity.releaseId, manifest);
        if (existing.projectId !== identity.projectId) throw new Error('SOURCE_SNAPSHOT_UNTRUSTED');
        for (const file of existing.files) await this.content(identity.releaseId, file);
        return existing;
      }
      throw error;
    }
  }
  private async checkedFile(releaseId: string, path: string): Promise<string> {
    const base = resolve(this.root, releaseName(releaseId));
    const candidate = join(base, path);
    for (const segment of [base, ...path.split('/').map((_, index, parts) => join(base, ...parts.slice(0, index + 1)))]) {
      if ((await lstat(segment)).isSymbolicLink()) throw new Error('SOURCE_SNAPSHOT_UNTRUSTED');
    }
    const actual = await realpath(candidate); const root = await realpath(base);
    if (!actual.startsWith(root + sep)) throw new Error('SOURCE_SNAPSHOT_UNTRUSTED');
    return actual;
  }
  async manifest(releaseId: string, binding: SourceBinding): Promise<SourceManifest> {
    try {
      const path = await this.checkedFile(releaseId, 'manifest.json');
      if ((await lstat(path)).size > 2 * 1024 * 1024) throw new Error('SOURCE_SNAPSHOT_UNTRUSTED');
      const manifest = JSON.parse(await readFile(path, 'utf8')) as SourceManifest;
      const { signature, ...unsigned } = manifest;
      if (!/^[a-f0-9]{64}$/.test(signature) || !timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(this.sign(unsigned), 'hex'))
        || manifest.schemaVersion !== 1 || manifest.releaseId !== releaseId || manifest.commitSha !== binding.commitSha || manifest.treeDigest !== binding.treeDigest
        || manifest.treeDigest !== hash(JSON.stringify(manifest.files))) throw new Error('SOURCE_SNAPSHOT_UNTRUSTED');
      return manifest;
    } catch { throw new Error('SOURCE_SNAPSHOT_UNTRUSTED'); }
  }
  private async content(releaseId: string, file: SourceManifest['files'][number]): Promise<string> {
    assertSourcePath(file.path);
    try {
      const path = await this.checkedFile(releaseId, file.path);
      const size = (await lstat(path)).size;
      if (size !== file.bytes || size > MAX_FILE_BYTES) throw new Error('SOURCE_SNAPSHOT_UNTRUSTED');
      const content = await readFile(path, 'utf8');
      if (hash(content) !== file.digest) throw new Error('SOURCE_SNAPSHOT_UNTRUSTED');
      assertSourceContent(content, file.path); return content;
    } catch { throw new Error('SOURCE_SNAPSHOT_UNTRUSTED'); }
  }
  async read(releaseId: string, binding: SourceBinding, path: string, startLine: number, endLine: number) {
    assertSourcePath(path);
    if (!Number.isSafeInteger(startLine) || !Number.isSafeInteger(endLine) || startLine < 1 || endLine < startLine || endLine - startLine >= 200) throw new Error('SOURCE_REGION_INVALID');
    const manifest = await this.manifest(releaseId, binding); const file = manifest.files.find(file => file.path === path);
    if (!file) throw new Error('SOURCE_PATH_NOT_ALLOWED');
    const lines = (await this.content(releaseId, file)).split('\n');
    if (startLine > lines.length) throw new Error('SOURCE_REGION_INVALID');
    const content = lines.slice(startLine - 1, endLine).join('\n');
    if (Buffer.byteLength(content) > 16 * 1024) throw new Error('SOURCE_REGION_TOO_LARGE');
    return { path, startLine, endLine: Math.min(endLine, lines.length), content, fileDigest: file.digest, commitSha: binding.commitSha, interpretation: 'implementation-intent' as const };
  }
  async search(releaseId: string, binding: SourceBinding, query: string) {
    if (typeof query !== 'string' || !query.trim() || query.length > 128) throw new Error('SOURCE_QUERY_INVALID');
    const manifest = await this.manifest(releaseId, binding); const matches: Array<{ path: string; line: number; fileDigest: string }> = [];
    for (const file of manifest.files) {
      const lines = (await this.content(releaseId, file)).split('\n');
      for (let i = 0; i < lines.length; i++) if (lines[i].includes(query)) {
        matches.push({ path: file.path, line: i + 1, fileDigest: file.digest }); if (matches.length === 50) return matches;
      }
    }
    return matches;
  }
  async symbols(releaseId: string, binding: SourceBinding, name: string) {
    if (!/^[A-Za-z_$][A-Za-z0-9_$]{0,127}$/.test(name)) throw new Error('SOURCE_SYMBOL_INVALID');
    const manifest = await this.manifest(releaseId, binding); const results: Array<{ name: string; path: string; line: number; kind: string }> = [];
    for (const file of manifest.files.filter(file => /\.[cm]?[jt]sx?$/.test(file.path))) {
      const source = ts.createSourceFile(file.path, await this.content(releaseId, file), ts.ScriptTarget.Latest, true);
      const visit = (node: ts.Node) => {
        if (results.length >= 50) return;
        if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isVariableDeclaration(node) || ts.isMethodDeclaration(node) || ts.isTypeAliasDeclaration(node)) && node.name?.getText(source) === name) {
          results.push({ name, path: file.path, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1, kind: ts.SyntaxKind[node.kind] });
        }
        ts.forEachChild(node, visit);
      };
      visit(source); if (results.length >= 50) break;
    }
    return results;
  }
}
