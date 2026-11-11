import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DeletedMessages } from './deleted-messages.ts';

beforeEach(() => {
  const data = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    get length() { return data.size; },
    key: (index: number) => [...data.keys()][index] ?? null,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => data.set(key, value),
    removeItem: (key: string) => data.delete(key),
    clear: () => data.clear(),
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('MAX-638 / #642 cross-tab deletion', () => {
  it('retains distinct deletions made from stale copies before storage events arrive', () => {
    const a = new DeletedMessages('one');
    const b = new DeletedMessages('one');
    a.delete('a'); b.delete('b');
    const refreshed = new DeletedMessages('one');
    expect(refreshed.has('a')).toBe(true);
    expect(refreshed.has('b')).toBe(true);
    a.refresh(); b.refresh();
    expect(a.has('b')).toBe(true); expect(b.has('a')).toBe(true);
  });
  it('restores one message without erasing another deletion from a stale tab', () => {
    const a = new DeletedMessages('one');
    a.delete('a');
    const b = new DeletedMessages('one');
    a.delete('b'); b.restore('a');
    const refreshed = new DeletedMessages('one');
    expect(refreshed.has('a')).toBe(false); expect(refreshed.has('b')).toBe(true);
    b.delete('c');
    a.refresh(); expect(a.has('a')).toBe(false); expect(a.has('c')).toBe(true);
  });
  it('reads legacy arrays and keeps restores across reloads and later writes', () => {
    localStorage.setItem('slide:deleted:one', JSON.stringify(['a', 'b', 42]));
    const a = new DeletedMessages('one'); const b = new DeletedMessages('one');
    expect(a.has('a')).toBe(true); expect(a.has('42')).toBe(false);
    a.restore('a'); b.delete('c');
    const refreshed = new DeletedMessages('one');
    expect(refreshed.has('a')).toBe(false); expect(refreshed.has('b')).toBe(true); expect(refreshed.has('c')).toBe(true);
    refreshed.clear();
    const cleared = new DeletedMessages('one');
    for (const key of ['a', 'b', 'c']) expect(cleared.has(key)).toBe(false);
  });
  it('isolates session names including separators and only handles matching events', () => {
    const a = new DeletedMessages('a'); const b = new DeletedMessages('a:b');
    a.delete('b:c'); b.delete('c'); a.restore('b:c');
    expect(new DeletedMessages('a:b').has('c')).toBe(true);
    expect(a.handlesStorageKey('slide:deleted-message:a%3Ab:c')).toBe(false);
    expect(b.handlesStorageKey('slide:deleted-message:a%3Ab:c')).toBe(true);
    expect(a.handlesStorageKey('slide:deleted:a')).toBe(true);
    expect(a.handlesStorageKey(null)).toBe(true);
  });
  it('ignores malformed legacy data while reading per-message state', () => {
    localStorage.setItem('slide:deleted:one', '{');
    new DeletedMessages('one').delete('a');
    expect(new DeletedMessages('one').has('a')).toBe(true);
  });
  it('converges for competing delete/restore operations on the same message', () => {
    const a = new DeletedMessages('one'); const b = new DeletedMessages('one');
    a.delete('a'); b.restore('a'); a.refresh();
    expect(a.has('a')).toBe(false);
    b.delete('a'); a.refresh(); expect(a.has('a')).toBe(true);
  });
});

it('retains local state on quota failure and can persist a later operation', () => {
  const a = new DeletedMessages('one');
  const set = vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('quota'); });
  a.delete('a'); a.refresh(); expect(a.has('a')).toBe(true);
  a.restore('a'); a.refresh(); expect(a.has('a')).toBe(false);
  set.mockRestore();
  a.delete('a'); a.refresh(); expect(new DeletedMessages('one').has('a')).toBe(true);
});
