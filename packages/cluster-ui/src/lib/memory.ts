/** What only this browser knows: the composer's last choice. */
const COMPOSER_KEY = 'cluster-ui.composer';

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
