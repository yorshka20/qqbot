import { useSyncExternalStore } from 'react';

export type ThemeChoice = 'dark' | 'light' | 'system';

const THEME_KEY = 'cluster-ui.theme';

const systemLight = window.matchMedia('(prefers-color-scheme: light)');
const listeners = new Set<() => void>();

function readChoice(): ThemeChoice {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    return stored === 'light' || stored === 'system' ? stored : 'dark';
  } catch {
    return 'dark';
  }
}

let choice = readChoice();

function apply(): void {
  document.documentElement.dataset.theme = resolved();
  const background = getComputedStyle(document.documentElement).getPropertyValue('--bg');
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', background);
}

export function applyStoredTheme(): void {
  apply();
  systemLight.addEventListener('change', apply);
}

export function setTheme(next: ThemeChoice): void {
  choice = next;
  try {
    localStorage.setItem(THEME_KEY, next);
  } catch {
    // The choice then lasts for this page view.
  }
  apply();
  for (const listener of listeners) {
    listener();
  }
}

export function useThemeChoice(): ThemeChoice {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => choice,
  );
}

function resolved(): 'dark' | 'light' {
  return choice === 'system' ? (systemLight.matches ? 'light' : 'dark') : choice;
}

export function useResolvedTheme(): 'dark' | 'light' {
  return useSyncExternalStore((listener) => {
    listeners.add(listener);
    systemLight.addEventListener('change', listener);
    return () => {
      listeners.delete(listener);
      systemLight.removeEventListener('change', listener);
    };
  }, resolved);
}
