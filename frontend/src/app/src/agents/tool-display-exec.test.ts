import { describe, expect, it } from 'vitest';
import { resolveExecDetail } from './tool-display-exec.ts';
import { optionValue, splitShellWords, trimLeadingEnv } from './tool-display-exec-shell.ts';

describe('MAX-462 / #405 command summaries', () => {
  it.each(['git', 'npm', 'pnpm', 'yarn', 'bun'].flatMap(bin =>
    ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'unknown'].map(key => [bin, key]),
  ))('keeps %s %s textual', (bin, key) => {
    expect(resolveExecDetail({ command: `${bin} ${key}` })).toBe(`run ${bin} ${key} · \`${bin} ${key}\``);
  });

  it('preserves ordinary, pipeline and multi-stage summaries', () => {
    expect(resolveExecDetail({ command: 'git status' })).toContain('check git status');
    expect(resolveExecDetail({ command: 'npm install' })).toContain('install dependencies');
    expect(resolveExecDetail({ command: 'git constructor | npm __proto__; git status && npm install' }))
      .toContain('run git constructor -> run npm __proto__ → check git status → install dependencies');
  });
});

describe('MAX-483 / #702 env and option values', () => {
  it.each([
    ['env -u FOO git status', ['git', 'status']],
    ['env -C /work git status', ['git', 'status']],
    ['env -S "git status"', ['git', 'status']],
    ['env -S "git -C /work" status', ['git', '-C', '/work', 'status']],
    ['env --unset=FOO --chdir=/work git status', ['git', 'status']],
    ['env --split-string="git status"', ['git', 'status']],
    ['env -uFOO -C/work git status', ['git', 'status']],
    ['env -Sgit status', ['git', 'status']],
    ['env -i -u FOO -C /work BAR=1 git status', ['git', 'status']],
    ['env -- git status', ['git', 'status']],
    ['FOO=1 git status', ['git', 'status']],
    ['git status', ['git', 'status']],
  ])('finds the command in %s', (command, expected) => {
    expect(trimLeadingEnv(splitShellWords(command))).toEqual(expected);
    expect(resolveExecDetail({ command })).toContain('check git status');
  });

  it.each(['-u', '-C', '-S', '--unset', '--chdir', '--split-string'])('handles missing env %s values', option => {
    expect(trimLeadingEnv(['env', option])).toEqual([]);
    expect(resolveExecDetail({ command: `env ${option}` })).toBeTypeOf('string');
  });

  it('retains negative values without mistaking another option for a value', () => {
    expect(optionValue(['head', '-n', '-5', 'file'], ['-n'])).toBe('-5');
    expect(resolveExecDetail({ command: 'head -n -5 file' })).toContain('show first -5 lines of file');
    expect(optionValue(['head', '-n', '--verbose'], ['-n'])).toBeUndefined();
    expect(resolveExecDetail({ command: 'head -n 5 file' })).toContain('show first 5 lines of file');
  });
});
