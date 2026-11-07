export const TASK_TABS = ['chat', 'topology', 'result'] as const;
export type TaskTab = (typeof TASK_TABS)[number];

export const SETTINGS_GROUPS = ['workers', 'templates', 'projects', 'concurrency', 'daemon', 'console'] as const;
export type SettingsGroup = (typeof SETTINGS_GROUPS)[number];

export const TASK_VIEWS = ['run'] as const;
export type TaskView = (typeof TASK_VIEWS)[number];

export type AppLocation =
  | { page: 'home' }
  | { page: 'inbox' }
  | { page: 'task'; taskId: string; workerId: string | null; tab: TaskTab | null }
  | { page: 'settings'; group: SettingsGroup };

function parseTab(search: string): TaskTab | null {
  const value = new URLSearchParams(search).get('tab');
  return TASK_TABS.find((tab) => tab === value) ?? null;
}

export function parseView(search: string): TaskView | null {
  const value = new URLSearchParams(search).get('view');
  return TASK_VIEWS.find((view) => view === value) ?? null;
}

/** Topology tab of a task, showing that task's own run flow instead of the job graph. */
export function runViewPath(taskId: string): string {
  return `${taskPath(taskId, 'topology')}&view=run`;
}

function decode(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

export function parseAppLocation(pathname: string, search: string): AppLocation {
  const parts = pathname.split('/').filter((part) => part.length > 0);
  const [head, id, sub, workerSegment] = parts;

  if (head === 'inbox' && parts.length === 1) {
    return { page: 'inbox' };
  }
  if (head === 't' && id !== undefined) {
    const taskId = decode(id);
    if (taskId === null) {
      return { page: 'home' };
    }
    if (parts.length === 2) {
      return { page: 'task', taskId, workerId: null, tab: parseTab(search) };
    }
    if (parts.length === 4 && sub === 'w' && workerSegment !== undefined) {
      const workerId = decode(workerSegment);
      if (workerId !== null) {
        return { page: 'task', taskId, workerId, tab: parseTab(search) };
      }
    }
    return { page: 'home' };
  }
  if (head === 'settings' && parts.length <= 2) {
    const group = SETTINGS_GROUPS.find((candidate) => candidate === id) ?? SETTINGS_GROUPS[0];
    return { page: 'settings', group };
  }
  return { page: 'home' };
}

export function homePath(): string {
  return '/';
}

export function inboxPath(): string {
  return '/inbox';
}

function withTab(path: string, tab: TaskTab | undefined): string {
  return tab ? `${path}?tab=${tab}` : path;
}

export function taskPath(taskId: string, tab?: TaskTab): string {
  return withTab(`/t/${encodeURIComponent(taskId)}`, tab);
}

/** `workerId` is the child run's task id, not a worker id: conversation, events and messages are keyed by task, an exited worker may be gone from `/workers`, and a queued child has no worker yet. */
export function workerPath(taskId: string, workerId: string, tab?: TaskTab): string {
  return withTab(`/t/${encodeURIComponent(taskId)}/w/${encodeURIComponent(workerId)}`, tab);
}

export function settingsPath(group: SettingsGroup = SETTINGS_GROUPS[0]): string {
  return `/settings/${group}`;
}

/** Where Esc / back goes: worker → its task, task / inbox / settings → home. */
export function parentPath(location: AppLocation): string {
  if (location.page === 'task' && location.workerId !== null) {
    return taskPath(location.taskId);
  }
  return homePath();
}

export interface OverlayState {
  composing: boolean;
  ticket: { id: string; file: string | null } | null;
  log: boolean;
  created: string | null;
}

export function parseOverlay(search: string): OverlayState {
  const params = new URLSearchParams(search);
  const ticketId = params.get('ticket');
  return {
    composing: params.get('new') === '1',
    ticket: ticketId ? { id: ticketId, file: params.get('file') } : null,
    log: params.get('log') === '1',
    created: params.get('created') || null,
  };
}

export interface OverlayPatch {
  new?: boolean;
  ticket?: { id: string; file?: string } | null;
  log?: boolean;
  created?: string | null;
}

/** Applies a patch to the overlay keys and leaves every other parameter alone; returns the new search string ('' or '?…'). */
export function withOverlay(search: string, patch: OverlayPatch): string {
  const params = new URLSearchParams(search);
  if (patch.new !== undefined) {
    if (patch.new) {
      params.set('new', '1');
    } else {
      params.delete('new');
    }
  }
  if (patch.ticket !== undefined) {
    params.delete('ticket');
    params.delete('file');
    if (patch.ticket) {
      params.set('ticket', patch.ticket.id);
      if (patch.ticket.file) {
        params.set('file', patch.ticket.file);
      }
    }
  }
  if (patch.log !== undefined) {
    if (patch.log) {
      params.set('log', '1');
    } else {
      params.delete('log');
    }
  }
  if (patch.created !== undefined) {
    if (patch.created) {
      params.set('created', patch.created);
    } else {
      params.delete('created');
    }
  }
  const text = params.toString();
  return text ? `?${text}` : '';
}
