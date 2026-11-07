import { describe, expect, test } from 'bun:test';
import {
  type AppLocation,
  homePath,
  inboxPath,
  parentPath,
  runViewPath,
  parseAppLocation,
  parseOverlay,
  parseView,
  SETTINGS_GROUPS,
  settingsPath,
  taskPath,
  withOverlay,
  workerPath,
} from './routes';

function parsePath(path: string): AppLocation {
  const [pathname, query = ''] = path.split('?');
  return parseAppLocation(pathname, query ? `?${query}` : '');
}

describe('parseAppLocation', () => {
  test('round-trips every builder', () => {
    expect(parsePath(homePath())).toEqual({ page: 'home' });
    expect(parsePath(inboxPath())).toEqual({ page: 'inbox' });
    expect(parsePath(taskPath('t1'))).toEqual({ page: 'task', taskId: 't1', workerId: null, tab: null });
    expect(parsePath(taskPath('t1', 'topology'))).toEqual({ page: 'task', taskId: 't1', workerId: null, tab: 'topology' });
    expect(parsePath(workerPath('t1', 't2', 'result'))).toEqual({
      page: 'task',
      taskId: 't1',
      workerId: 't2',
      tab: 'result',
    });
    for (const group of SETTINGS_GROUPS) {
      expect(parsePath(settingsPath(group))).toEqual({ page: 'settings', group });
    }
  });

  test('round-trips ids with special characters', () => {
    const id = 'a/b c?d#e%f';
    expect(parsePath(taskPath(id))).toEqual({ page: 'task', taskId: id, workerId: null, tab: null });
    expect(parsePath(workerPath(id, '测试/子'))).toEqual({ page: 'task', taskId: id, workerId: '测试/子', tab: null });
  });

  test('unknown paths are home', () => {
    expect(parsePath('/nope')).toEqual({ page: 'home' });
    expect(parsePath('/t')).toEqual({ page: 'home' });
    expect(parsePath('/t/a/x/b')).toEqual({ page: 'home' });
    expect(parsePath('/t/a/w')).toEqual({ page: 'home' });
    expect(parsePath('/inbox/extra')).toEqual({ page: 'home' });
    expect(parsePath('/t/%E0%A4%A')).toEqual({ page: 'home' });
  });

  test('an invalid tab is null', () => {
    expect(parsePath('/t/a?tab=bogus')).toEqual({ page: 'task', taskId: 'a', workerId: null, tab: null });
  });

  test('an unknown settings group is the first group', () => {
    expect(parsePath('/settings/zzz')).toEqual({ page: 'settings', group: SETTINGS_GROUPS[0] });
    expect(parsePath('/settings')).toEqual({ page: 'settings', group: SETTINGS_GROUPS[0] });
  });
});

describe('parentPath', () => {
  test('a worker goes to its task, everything else to home', () => {
    expect(parentPath({ page: 'task', taskId: 'a b', workerId: 'c', tab: 'chat' })).toBe(taskPath('a b'));
    expect(parentPath({ page: 'task', taskId: 'a', workerId: null, tab: null })).toBe('/');
    expect(parentPath({ page: 'inbox' })).toBe('/');
    expect(parentPath({ page: 'settings', group: 'daemon' })).toBe('/');
    expect(parentPath({ page: 'home' })).toBe('/');
  });
});

describe('overlays', () => {
  test('parse reads new, ticket and log', () => {
    expect(parseOverlay('?new=1&ticket=T-1&file=plan.md&log=1')).toEqual({
      composing: true,
      ticket: { id: 'T-1', file: 'plan.md' },
      log: true,
      created: null,
    });
    expect(parseOverlay('')).toEqual({ composing: false, ticket: null, log: false, created: null });
  });

  test('withOverlay sets and clears keys and keeps the others', () => {
    expect(withOverlay('', { new: true })).toBe('?new=1');
    expect(withOverlay('?tab=result', { log: true })).toBe('?tab=result&log=1');
    expect(withOverlay('?new=1&tab=chat', { new: false })).toBe('?tab=chat');
    expect(withOverlay('?new=1', { new: false })).toBe('');
    expect(withOverlay('', { ticket: { id: 'T-1', file: 'a b.md' } })).toBe('?ticket=T-1&file=a+b.md');
    expect(withOverlay('?ticket=T-1&file=x', { ticket: null })).toBe('');
    expect(withOverlay('?ticket=T-1&file=x', { ticket: { id: 'T-2' } })).toBe('?ticket=T-2');
  });

  test('created round-trips and clears', () => {
    const search = withOverlay('?tab=chat', { created: 'T-9' });
    expect(search).toBe('?tab=chat&created=T-9');
    expect(parseOverlay(search).created).toBe('T-9');
    expect(withOverlay(search, { created: null })).toBe('?tab=chat');
  });
});

describe('view param', () => {
  test('parses run and ignores anything else', () => {
    expect(parseView('?tab=topology&view=run')).toBe('run');
    expect(parseView('?view=other')).toBeNull();
    expect(parseView('')).toBeNull();
  });

  test('runViewPath keeps the topology tab and round-trips', () => {
    const path = runViewPath('a/b');
    const [pathname, query] = path.split('?');
    expect(parseAppLocation(pathname, `?${query}`)).toEqual({
      page: 'task',
      taskId: 'a/b',
      workerId: null,
      tab: 'topology',
    });
    expect(parseView(`?${query}`)).toBe('run');
  });
});
