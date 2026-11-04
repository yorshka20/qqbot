import { parseRunView, type RunView } from './runs';
import type { RunWindow } from './window';

/** What only this browser knows: the composer's last choice, the run tab, the overview controls. */
const COMPOSER_KEY = 'cluster-ui.composer';
const RUN_VIEW_KEY = 'cluster-ui.run-view';
const OVERVIEW_KEY = 'cluster-ui.overview';
const SIDEBAR_KEY = 'cluster-ui.sidebar-open';

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Private mode or a full quota: the state simply lasts for this page view.
  }
}

interface ComposerChoice {
  project?: string;
  template?: string;
}

/** The composer's last project/template, read once when it opens. */
export function readComposerChoice(): ComposerChoice {
  return read<ComposerChoice>(COMPOSER_KEY, {});
}

export function rememberComposerChoice(choice: ComposerChoice): void {
  write(COMPOSER_KEY, choice);
}

export function readRunView(): RunView {
  return parseRunView(read<string | null>(RUN_VIEW_KEY, null)) ?? 'chat';
}

export function rememberRunView(view: RunView): void {
  write(RUN_VIEW_KEY, view);
}

export interface OverviewChoice {
  window: RunWindow;
  liveOnly: boolean;
}

const DEFAULT_OVERVIEW: OverviewChoice = { window: '24h', liveOnly: false };

export function readOverviewChoice(): OverviewChoice {
  const saved = read<Partial<OverviewChoice>>(OVERVIEW_KEY, {});
  const window = saved.window === '24h' || saved.window === '7d' || saved.window === 'all' ? saved.window : null;
  return { window: window ?? DEFAULT_OVERVIEW.window, liveOnly: saved.liveOnly === true };
}

export function rememberOverviewChoice(choice: OverviewChoice): void {
  write(OVERVIEW_KEY, choice);
}

export function readSidebarOpen(): boolean {
  return read<boolean>(SIDEBAR_KEY, true);
}

export function rememberSidebarOpen(open: boolean): void {
  write(SIDEBAR_KEY, open);
}
