import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SessionManager } from '../session.js';

// #692: real filesystem probe, synthetic content only; umask is restored per test.
describe.skipIf(process.platform === 'win32')('session JSONL permissions (#692)', () => {
  let workspace: string;
  let previousUmask: number;
  let manager: SessionManager;
  let directory: string;
  let file: string;
  const mode = (target: string) => fs.statSync(target).mode & 0o777;

  beforeEach(() => {
    previousUmask = process.umask(0o022);
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'slide-session-permissions-'));
    manager = new SessionManager(workspace);
    directory = path.join(workspace, '.slide', 'sessions');
    file = path.join(directory, manager.safeKey('synthetic') + '.jsonl');
  });

  afterEach(() => {
    process.umask(previousUmask);
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it('creates private directory even when listing before the first save', async () => {
    expect(await manager.listSessions()).toEqual([]);
    expect(mode(directory)).toBe(0o700);
  });

  it.each([false, true])('creates private JSONL with fsync=%s and round-trips facts', async (fsync) => {
    const session = manager.getOrCreate('synthetic');
    session.addMessage('user', 'synthetic question');
    session.addMessage('assistant', 'synthetic answer');
    session.metadata = { marker: 'synthetic metadata' };
    await manager.save(session, { fsync });
    expect(mode(directory)).toBe(0o700);
    expect(mode(file)).toBe(0o600);
    manager.invalidate('synthetic');
    const loaded = manager.getOrCreate('synthetic');
    expect(loaded.messages).toEqual(session.messages);
    expect(loaded.metadata).toEqual(session.metadata);
    expect(fs.readdirSync(directory)).toEqual([path.basename(file)]);
  });

  it('tightens an existing wide directory and file on the next save', async () => {
    const session = manager.getOrCreate('synthetic');
    session.addMessage('user', 'synthetic retained fact');
    await manager.save(session);
    fs.chmodSync(directory, 0o755);
    fs.chmodSync(file, 0o666);
    const before = fs.readFileSync(file, 'utf8').split('\n')[0];
    await manager.save(session);
    expect(mode(directory)).toBe(0o700);
    expect(mode(file)).toBe(0o600);
    expect(fs.readFileSync(file, 'utf8').split('\n')[0]).toBe(before);
  });

  it('repairs legacy/corrupt JSONL privately while retaining valid messages', () => {
    fs.mkdirSync(directory, { recursive: true, mode: 0o755 });
    fs.writeFileSync(file, [
      JSON.stringify({ role: 'user', content: 'synthetic legacy fact' }),
      '{broken',
      JSON.stringify({ __meta__: true, sessionKey: 'synthetic', metadata: { marker: 'retained' } }),
      '',
    ].join('\n'), { mode: 0o644 });
    const loaded = manager.getOrCreate('synthetic');
    expect(loaded.messages.map(m => m.content)).toEqual(['synthetic legacy fact']);
    expect(loaded.metadata.marker).toBe('retained');
    expect(mode(file)).toBe(0o600);
    expect(mode(directory)).toBe(0o700);
    manager.invalidate('synthetic');
    expect(manager.getOrCreate('synthetic').messages).toEqual(loaded.messages);
    expect(fs.readdirSync(directory)).toEqual([path.basename(file)]);
  });
});
