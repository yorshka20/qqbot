// Trust boundary between untrusted LLM JSON and typed report data.
//
// The model intermittently omits or mistypes fields (e.g. a member highlight
// without `comment`). The renderer's escapeHtml assumes strings, so an
// `undefined` reaching it throws. These coercers guarantee every required
// string field is present and drop structurally-invalid elements (no userId /
// no title), so renderReportHTML can trust its input.

import type { FeaturedMessage, MemberHighlight, ReportTopic } from './types';

export const asString = (v: unknown): string => (typeof v === 'string' ? v : '');
export const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
export const asObject = (v: unknown): Record<string, unknown> =>
  v != null && typeof v === 'object' ? (v as Record<string, unknown>) : {};
const asNumber = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

export function normalizeTopics(v: unknown): ReportTopic[] {
  return asArray(v)
    .map((t) => {
      const o = asObject(t);
      return { title: asString(o.title), summary: asString(o.summary) };
    })
    .filter((t) => t.title !== '');
}

/** Member comments WITHOUT messageCount (batch path; real count attached later from stats). */
export function normalizeMemberComments(v: unknown): Array<{ userId: string; nickname: string; comment: string }> {
  return asArray(v)
    .map((m) => {
      const o = asObject(m);
      return { userId: asString(o.userId), nickname: asString(o.nickname), comment: asString(o.comment) };
    })
    .filter((m) => m.userId !== '');
}

/** Full member highlights WITH messageCount (LLM tool-arg path). */
export function normalizeMemberHighlights(v: unknown): MemberHighlight[] {
  return asArray(v)
    .map((m) => {
      const o = asObject(m);
      return {
        userId: asString(o.userId),
        nickname: asString(o.nickname),
        messageCount: asNumber(o.messageCount),
        comment: asString(o.comment),
      };
    })
    .filter((m) => m.userId !== '');
}

export function normalizeFeaturedMessages(v: unknown): FeaturedMessage[] {
  return asArray(v)
    .map((f) => {
      const o = asObject(f);
      return {
        userId: asString(o.userId),
        nickname: asString(o.nickname),
        content: asString(o.content),
        comment: asString(o.comment),
      };
    })
    .filter((f) => f.userId !== '');
}
