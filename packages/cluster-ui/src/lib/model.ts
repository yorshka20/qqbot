const CLAUDE = /^claude-([a-z]+)-(\d+)-(\d+)$/i;
const GPT = /^gpt-(\d+(?:\.\d+)?)-([a-z]+)$/i;

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

/** A model id as a person reads it; an unrecognised id is shown as the daemon reported it. */
export function modelDisplayName(id: string | undefined): string {
  if (!id) {
    return '未知';
  }
  const claude = id.match(CLAUDE);
  if (claude) {
    const [, family, major, minor] = claude;
    return `Claude ${capitalize(family)} ${major}.${minor}`;
  }
  const gpt = id.match(GPT);
  if (gpt) {
    const [, version, variant] = gpt;
    return `GPT-${version} ${capitalize(variant)}`;
  }
  return id;
}

/** The display name without its vendor prefix, for a row too narrow for "Claude Opus 5.5". */
export function modelShortName(id: string | undefined): string {
  return modelDisplayName(id).replace(/^Claude /, '');
}

/** What a run ran on: the model the worker reported, else the template, for a backend that reports none. */
export function runModelName(task: { model?: string; workerTemplate?: string }): string {
  return task.model ? modelShortName(task.model) : (task.workerTemplate ?? '未知');
}
