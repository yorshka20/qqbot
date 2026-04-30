import { promises as fs } from 'node:fs';
import path from 'node:path';
import { logger } from '@/utils/logger';

export interface CharacterBible {
  /** Self-concept section body (HTML-comment-stripped at top). */
  selfConcept: string;
  voice: string;
  /** Raw section body — NOT parsed structurally this ticket (D/E ticket job). */
  triggersRaw: string;
  reflexesRaw: string;
  boundaries: string;
  lore: string;
  /** Full original markdown including title + all chapters. */
  raw: string;
}

export const EMPTY_BIBLE: CharacterBible = Object.freeze({
  selfConcept: '',
  voice: '',
  triggersRaw: '',
  reflexesRaw: '',
  boundaries: '',
  lore: '',
  raw: '',
});

export class MissingBibleSectionError extends Error {
  constructor(
    public readonly sectionName: string,
    public readonly filePath: string,
  ) {
    super(`Character bible at ${filePath} is missing required section: ## ${sectionName}`);
    this.name = 'MissingBibleSectionError';
  }
}

const REQUIRED_SECTIONS = ['Self-concept', 'Voice', 'Triggers', 'Reflexes', 'Boundaries', 'Lore'] as const;

export interface CharacterBibleLoaderOptions {
  dataDir: string; // e.g. './data/mind'
  personaId: string;
}

/**
 * Strip leading HTML comments from a section body.
 * Comments at the very start (optionally preceded by whitespace) are removed,
 * along with any whitespace between the comment and the following content.
 * Embedded comments (after content starts) are left as-is.
 */
function stripLeadingComments(body: string): string {
  let s = body;
  // Repeatedly strip leading <!-- ... --> blocks (with surrounding whitespace)
  const leadingComment = /^\s*<!--[\s\S]*?-->\s*/;
  while (leadingComment.test(s)) {
    s = s.replace(leadingComment, '');
  }
  return s.trim();
}

/**
 * Parse a markdown string into a map from H2 section name → body text.
 * Lines before the first H2 (e.g. the H1 title) are discarded from the map
 * but preserved in `raw`.
 */
function parseSections(content: string): Map<string, string> {
  const sections = new Map<string, string>();
  const lines = content.split('\n');
  let currentSection: string | null = null;
  const buckets = new Map<string, string[]>();

  for (const line of lines) {
    const h2Match = /^## (.+)$/.exec(line);
    if (h2Match) {
      currentSection = h2Match[1].trim();
      buckets.set(currentSection, []);
    } else if (currentSection !== null) {
      buckets.get(currentSection)!.push(line);
    }
    // Lines before first H2 are discarded for section mapping
  }

  for (const [name, bodyLines] of buckets) {
    const raw = bodyLines.join('\n').trim();
    sections.set(name, stripLeadingComments(raw));
  }

  return sections;
}

export async function loadCharacterBible(opts: CharacterBibleLoaderOptions): Promise<CharacterBible> {
  const filePath = path.join(opts.dataDir, 'persona', opts.personaId, 'bible.md');

  let content: string;
  try {
    content = await fs.readFile(filePath, 'utf-8');
  } catch (err: unknown) {
    if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      logger.warn(
        `[CharacterBibleLoader] bible.md not found for persona "${opts.personaId}" at ${filePath} — using EMPTY_BIBLE`,
      );
      return EMPTY_BIBLE;
    }
    // Re-throw other fs errors (permissions, etc.)
    throw err;
  }

  const sections = parseSections(content);

  // Verify all required sections are present
  for (const required of REQUIRED_SECTIONS) {
    if (!sections.has(required)) {
      throw new MissingBibleSectionError(required, filePath);
    }
  }

  return {
    selfConcept: sections.get('Self-concept')!,
    voice: sections.get('Voice')!,
    triggersRaw: sections.get('Triggers')!,
    reflexesRaw: sections.get('Reflexes')!,
    boundaries: sections.get('Boundaries')!,
    lore: sections.get('Lore')!,
    raw: content,
  };
}
