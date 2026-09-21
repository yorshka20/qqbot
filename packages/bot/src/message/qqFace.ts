// QQ face table — the shared vocabulary behind inbound rendering, outbound markers and reactions.

import faceData from './qqFaces.json';
import type { FaceSegment, MessageSegment, TextSegment } from './types';

/**
 * `qqFaces.json` merges two tables, because neither is a superset of the other:
 *   - `sysface` (329 ids, 0–484) from NapCat's `packages/napcat-core/external/face_config.json`
 *     (https://github.com/NapNeko/NapCatQQ), extracted from the QQ NT client's own resources.
 *   - `legacy` (61 ids) from https://github.com/koishijs/QFace `lib/data.json`, which stops at
 *     id 348 but retains older faces the NapCat snapshot dropped.
 * The table published in QQ's bot docs stops at id 326 and is not usable as a source here.
 * NapCat wins every conflict: it carries the current client's renames (317 菜狗 → 菜汪,
 * 181 骚扰 → 戳一戳, 200 拜托 → 求求).
 *
 * Two id families share one namespace on the reaction API:
 *   - face ids: QQ's own faces. These are also what a `face` message segment carries.
 *   - emoji:    the emoji's decimal Unicode codepoint (👍 = 128077, ❔ = 10068).
 * Only face ids can appear in message text, so names resolve to faces alone; an emoji reaction
 * is addressed by the character itself, which keeps the two families unambiguous (24 names,
 * e.g. 爱心 and 玫瑰, exist in both).
 */
const SYSFACE = faceData.sysface as [string, string][];
const LEGACY = faceData.legacy as [string, string][];
const EMOJI = faceData.emoji as [string, string, string][];

const nameById = new Map<string, string>([...SYSFACE, ...LEGACY]);

/**
 * Names are ambiguous in two ways, and both resolve toward what the current client ships:
 * the 3D variants at ids 450–457 reuse the classic names they replace (微笑, 撇嘴, 色, 发呆,
 * 得意, 害羞, 闭嘴, 睡), and one retired face (340 热化了) shares its name with a current one
 * (482). Binding `sysface` before `legacy`, and keeping the first binding within each, picks
 * the current-client face and then its lowest id.
 */
const idByName = new Map<string, string>();
for (const [id, name] of [...SYSFACE, ...LEGACY]) {
  if (!idByName.has(name)) {
    idByName.set(name, id);
  }
}

const idByEmojiChar = new Map<string, string>(EMOJI.map(([id, char]) => [char, id]));
const charByEmojiId = new Map<string, string>(EMOJI.map(([id, char]) => [id, char]));

/** Canonical text form of a face, e.g. `[表情:头秃]`. Unknown ids degrade to `[表情:#489]`. */
const FACE_MARKER = /\[表情:([^\]\n]{1,12})\]/g;

const UNKNOWN_ID_PREFIX = '#';

/** Render a face id as the canonical token used on both the inbound and outbound side. */
export function renderFaceToken(id: number | string): string {
  const key = String(id);
  return `[表情:${nameById.get(key) ?? `${UNKNOWN_ID_PREFIX}${key}`}]`;
}

/** Resolve a face name (or a `#<id>` escape hatch) to its face id. */
export function faceIdByName(name: string): string | undefined {
  const trimmed = name.trim();
  if (trimmed.startsWith(UNKNOWN_ID_PREFIX)) {
    const raw = trimmed.slice(UNKNOWN_ID_PREFIX.length);
    return /^\d+$/.test(raw) ? raw : undefined;
  }
  return idByName.get(trimmed);
}

/**
 * Resolve a reaction target to the id the reaction API expects: a face name, a `#<id>`
 * escape hatch, a literal emoji character, or a bare numeric id from either family.
 */
export function resolveReactionId(input: string): string | undefined {
  const trimmed = input.trim();
  if (!trimmed) {
    return undefined;
  }
  if (/^\d+$/.test(trimmed)) {
    return trimmed;
  }
  return faceIdByName(trimmed) ?? idByEmojiChar.get(trimmed);
}

/** Human-readable label for a reaction id, for logs and audit trails. */
export function reactionLabel(id: number | string): string {
  const key = String(id);
  return nameById.get(key) ?? charByEmojiId.get(key) ?? key;
}

export interface FaceMarkerExpansion {
  segments: MessageSegment[];
  /** Names the model used that resolve to nothing; dropped from the text, worth logging. */
  unresolved: string[];
}

/**
 * Split text on face markers, turning each resolved one into a `face` segment.
 *
 * An unresolved name is dropped rather than passed through: the marker is a delivery
 * control token like `/skip_card`, and a token the pipeline could not act on must never
 * reach the chat as literal text.
 */
export function expandFaceMarkers(text: string): FaceMarkerExpansion {
  const segments: MessageSegment[] = [];
  const unresolved: string[] = [];
  let cursor = 0;

  const pushText = (value: string): void => {
    if (!value) {
      return;
    }
    const last = segments[segments.length - 1];
    if (last?.type === 'text') {
      (last as TextSegment).data.text += value;
      return;
    }
    segments.push({ type: 'text', data: { text: value } });
  };

  FACE_MARKER.lastIndex = 0;
  let match = FACE_MARKER.exec(text);
  while (match !== null) {
    pushText(text.slice(cursor, match.index));
    const id = faceIdByName(match[1]);
    if (id) {
      segments.push({ type: 'face', data: { id } } satisfies FaceSegment);
    } else {
      unresolved.push(match[1]);
    }
    cursor = match.index + match[0].length;
    match = FACE_MARKER.exec(text);
  }

  if (cursor === 0) {
    return { segments: [{ type: 'text', data: { text } }], unresolved };
  }

  pushText(text.slice(cursor));
  return { segments, unresolved };
}

/** Remove face markers from text bound for a surface that cannot render a face (card image, speech). */
export function stripFaceMarkers(text: string): string {
  return text.replace(FACE_MARKER, '');
}

/**
 * Every name the model may write, ordered by face id across both tables.
 *
 * Id order is the client's own — the classic set first, then each later batch in the order QQ
 * shipped it — which keeps thematically related faces adjacent and is why this is not sorted
 * alphabetically. Names bound to more than one id appear once, at their lowest id.
 */
export const FACE_VOCABULARY: readonly string[] = (() => {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const [, name] of [...SYSFACE, ...LEGACY].sort(([a], [b]) => Number(a) - Number(b))) {
    if (!seen.has(name)) {
      seen.add(name);
      names.push(name);
    }
  }
  return names;
})();

/**
 * Render the vocabulary as the name list injected into the reply prompt.
 *
 * Joined with `、` rather than a spaced separator: at ~380 entries the separator is a third of
 * the block, and the Chinese enumeration comma costs one character instead of three.
 */
export function formatFaceVocabulary(vocabulary: readonly string[] = FACE_VOCABULARY): string {
  return vocabulary.join('、');
}
