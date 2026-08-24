import type { InlineCueSyntax } from './TTSProvider';

/**
 * A cue is a short bracketed marker inside a speech script: `[happy]`,
 * `[whispering]`, `[sighing]`, `[break]`. The length bound and the ban on
 * nested brackets / newlines keep prose that merely contains a bracket from
 * being mistaken for a cue.
 */
const CUE_PATTERN = /\[([^[\]\n]{1,48})\]/g;

/** Collapse the horizontal whitespace a removed cue leaves behind. */
function collapseGaps(text: string): string {
  return text.replace(/[ \t]{2,}/g, ' ').trim();
}

/** The spoken content of a script, with every delivery cue removed. */
export function stripCues(text: string): string {
  return collapseGaps(text.replace(CUE_PATTERN, ''));
}

/** Render a speech script into the wire text a backend actually understands. */
export function renderCues(text: string, syntax: InlineCueSyntax): string {
  return syntax === 'brackets' ? text : stripCues(text);
}

/** Cues found in a script, in order of appearance (duplicates kept). */
export function listCues(text: string): string[] {
  return [...text.matchAll(CUE_PATTERN)].map((m) => m[1]);
}
