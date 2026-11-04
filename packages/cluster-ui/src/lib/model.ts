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
