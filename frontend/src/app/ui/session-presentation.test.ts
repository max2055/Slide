import { describe, expect, it } from 'vitest';
import {
  parseSessionKey, resolveSessionDisplayName, isCronSessionKey,
  resolveSessionOptionGroups, countHiddenCronSessions,
} from './session-presentation.ts';

const row = (key: string, extra = {}) => ({ key, kind: 'direct' as const, updatedAt: null, ...extra });
const groups = (rows: ReturnType<typeof row>[], current = '', state = {}) =>
  resolveSessionOptionGroups(state as any, current, { sessions: rows } as any);
const labels = (result: ReturnType<typeof groups>) => result.flatMap(g => g.options.map(o => o.label));

// Characterization expectations captured against main before extraction.
describe('session presentation compatibility', () => {
  it.each([
    ['main', '', 'Main Session'], ['agent:main:main', '', 'Main Session'],
    ['agent:a:subagent:b', 'Subagent:', 'Subagent:'],
    ['cron:job', 'Cron:', 'Cron Job:'], ['agent:a:cron:job', 'Cron:', 'Cron Job:'],
    [' CRON:job ', 'Cron:', 'Cron Job:'],
    ['agent:a:bluebubbles:direct:user', '', 'iMessage · user'],
    ['agent:a:custom:direct:user', '', 'Custom · user'],
    ['agent:a:telegram:group:room', '', 'Telegram Group'],
    ['agent:a:custom:group:room', '', 'Custom Group'],
    ['slack:legacy', '', 'Slack Session'], ['email', '', 'Email Session'],
    ['subagent:bare', '', 'subagent:bare'], ['AGENT:a:CRON:job', '', 'AGENT:a:CRON:job'],
    ['unknown', '', 'unknown'], ['', '', ''],
  ])('parses %s without changing legacy casing semantics', (key, prefix, fallbackName) => {
    expect(parseSessionKey(key)).toEqual({ prefix, fallbackName });
  });

  it.each([
    ['agent:a:cron:job', { label: ' Label ', displayName: 'Display' }, 'Cron: Label'],
    ['agent:a:cron:job', { label: 'cron: Already' }, 'cron: Already'],
    ['agent:a:subagent:b', { displayName: ' Worker ' }, 'Subagent: Worker'],
    ['main', { label: 'main', displayName: ' Display ' }, 'Display'],
    ['main', { label: ' ', displayName: 'main' }, 'Main Session'],
    ['unknown', {}, 'unknown'],
  ])('resolves label precedence for %s', (key, extra, expected) => {
    expect(resolveSessionDisplayName(key, row(key, extra))).toBe(expected);
  });

  it.each([
    ['cron:a', true], [' AGENT:A:CRON:x ', true], ['agent::a:cron:x', true],
    ['agent:a:cron', false], ['x:cron:a', false], ['', false], ['main', false],
  ])('detects cron key %s', (key, expected) => expect(isCronSessionKey(key)).toBe(expected));

  it('handles null/empty lists and appends a missing current session', () => {
    expect(resolveSessionOptionGroups({} as any, '', null)).toEqual([]);
    expect(groups([])).toEqual([]);
    expect(groups([], 'agent:a:missing')).toEqual([{ id: 'agent:a', label: 'a', options: [
      { key: 'agent:a:missing', title: 'agent:a:missing', scopeLabel: 'missing', label: 'missing' },
    ] }]);
  });

  it('preserves first-seen group/option order, last duplicate row data, and agent name priority', () => {
    const result = groups([
      row('agent:b:z'), row('legacy'), row('agent:a:x'), row('agent:b:y'),
      row('agent:b:z', { label: 'Last' }),
    ], 'agent:c:new', { agentsList: { agents: [
      { id: ' B ', name: 'Name', identity: { name: ' Identity ' } },
      { id: 'a', name: 'Alpha' }, { id: 'c', name: 'c' },
    ] } });
    expect(result.map(g => [g.id, g.label])).toEqual([
      ['agent:b', 'Identity (b)'], ['other', 'Other Sessions'], ['agent:a', 'Alpha (a)'], ['agent:c', 'c'],
    ]);
    expect(labels(result)).toEqual(['Last', 'y', 'legacy', 'x', 'new']);
  });

  it('filters cron/global/unknown except the current row and supports showing cron', () => {
    const rows = [row('agent:a:cron:x'), row('cron:y'), row('global', { kind: 'global' }),
      row('unknown', { kind: 'unknown' }), row('normal')];
    expect(labels(groups(rows))).toEqual(['normal']);
    expect(labels(groups(rows, 'global'))).toEqual(['global', 'normal']);
    expect(labels(groups(rows, 'unknown'))).toEqual(['unknown', 'normal']);
    expect(labels(groups(rows, 'cron:y'))).toEqual(['cron:y', 'normal']);
    expect(labels(groups(rows, '', { sessionsHideCron: false }))).toEqual(['cron:x', 'cron:y', 'normal']);
  });

  it('uses scoped keys without labels and preserves localized labels', () => {
    expect(labels(groups([row('agent:a:main'), row('agent:a:cron:x', { label: ' 每日巡检 ' }),
      row('agent:a:subagent:b', { displayName: '数据库助手' })], '', { sessionsHideCron: false })))
      .toEqual(['main', 'Cron: 每日巡检', 'Subagent: 数据库助手']);
  });

  it('disambiguates within a group then across agents', () => {
    expect(labels(groups([row('agent:a:x', { label: 'Same' }), row('agent:a:y', { label: 'Same' }),
      row('agent:b:x', { label: 'Same' }), row('agent:b:y', { label: 'Same' })])))
      .toEqual(['a / Same · x', 'a / Same · y', 'b / Same · x', 'b / Same · y']);
  });

  it('resolves collisions introduced by prefixing, then falls back to full keys', () => {
    expect(labels(groups([row('agent:a:x', { label: 'Same' }), row('agent:b:x', { label: 'Same' }),
      row('legacy', { label: 'a / Same' })])))
      .toEqual(['a / Same · x', 'b / Same', 'a / Same · legacy']);
    expect(labels(groups([row('agent:A:x', { label: 'Same' }), row('agent:a:x', { label: 'Same' })])))
      .toEqual(['a / Same · x · agent:A:x', 'a / Same · x · agent:a:x']);
  });

  it('does not mutate frozen input or share output mutations across calls', () => {
    const rows = Object.freeze([Object.freeze(row('agent:a:x', { label: 'Same' })),
      Object.freeze(row('agent:a:y', { label: 'Same' }))]);
    const sessions = Object.freeze({ sessions: rows });
    const state = Object.freeze({ sessionsHideCron: false,
      agentsList: Object.freeze({ agents: Object.freeze([Object.freeze({ id: 'a', name: 'Alpha' })]) }) });
    const before = JSON.stringify({ sessions, state });
    const first = resolveSessionOptionGroups(state as any, '', sessions as any);
    first[0].options[0].label = 'changed';
    expect(labels(resolveSessionOptionGroups(state as any, '', sessions as any))).toEqual(['Same · x', 'Same · y']);
    expect(JSON.stringify({ sessions, state })).toBe(before);
  });
});

it('counts hidden cron rows without counting the current session', () => {
  expect(countHiddenCronSessions('', null)).toBe(0);
  expect(countHiddenCronSessions('cron:x', { sessions: [row('cron:x'), row('agent:a:cron:y'), row('normal')] })).toBe(1);
});
