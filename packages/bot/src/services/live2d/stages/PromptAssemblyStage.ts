// PromptAssemblyStage — produces the LLM-ready message list for this run.
//
// Layered structure (mirrors the main conversation pipeline):
//
//   [system] base      — persona + cross-scene rules + tag DSL + actions + anti-repeat
//                        stable across all avatar sources (cache-friendly prefix).
//   [system] scene     — THIS source's task framing + scene-specific hard limits
//                        (e.g. "1-2 sentences ≤ 50 chars" for bilibili batches).
//   [user/assistant] × N — few-shot examples (source-specific, role-based).
//                          Teaches output format + character voice + tag usage
//                          pattern more reliably than prose examples in system.
//   [user/assistant] × M — real rolling history from Live2DSessionService.
//   [user] final       — memory_context + rag_context + <current_query>.
//                        Mirrors the main pipeline: `<current_query>` is the
//                        outer semantic envelope added by the assembler, and
//                        the user_frame template fills it with natural-language
//                        framing (e.g. "用户说：\n{input}" for /avatar,
//                        "直播间最新状态：\n{input}" for bilibili). No XML-ish
//                        inner wrappers — avoids double-nesting and keeps the
//                        few-shot / history / final-turn formats consistent.
//
// Context slots populated:
//   - `availableActions`, `systemPrompt` (for logging / back-compat tests —
//     `systemPrompt` is the concatenated base+scene joined with a separator)
//   - `threadId`   → the session thread id owning this scope (used by
//     LLMStage to append the user input + reply on success)
//   - `messages`   → the final ChatMessage[] that LLMStage forwards to the LLM

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { formatActionsForPrompt } from '@qqbot/avatar';
import { inject, injectable } from 'tsyringe';
import type { PromptManager } from '@/ai/prompt/PromptManager';
import type { FewShotExample } from '@/ai/prompt/PromptMessageAssembler';
import { PromptMessageAssembler } from '@/ai/prompt/PromptMessageAssembler';
import { renderAvatarPartials } from '@/ai/prompt/renderAvatarPartials';
import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import { formatMemoryMarkdown, type MemorySpeakerSection } from '@/memory/formatMemoryMarkdown';
import { GROUP_MEMORY_USER_ID, type MemoryService } from '@/memory/MemoryService';
import { logger } from '@/utils/logger';
import { getRepoRoot } from '@/utils/repoRoot';
import type { AvatarSessionService } from '@/integrations/avatar/AvatarSessionService';
import type { AvatarBatchSender, Live2DSource } from '@/integrations/avatar/types';
import type { Live2DContext, Live2DStage } from '../Live2DStage';

/**
 * Template names for each source's scene + user-frame + few-shot example
 * set. Kept as a table so adding a new source is one row.
 *
 * `livemode-private-batch` mocks bilibili — reuse the same "react to a
 * batch of danmaku" framing so idle-triggered runs stay in the same
 * conversational frame as real-danmaku runs (history continuity > idle-
 * specific framing).
 */
interface SourceTemplates {
  sceneTemplate: string;
  userFrameTemplate: string;
  exampleFile: string;
}

const TEMPLATES_BY_SOURCE: Record<Live2DSource, SourceTemplates> = {
  'avatar-cmd': {
    sceneTemplate: 'avatar.scenes.avatar-cmd',
    userFrameTemplate: 'avatar.user-frames.avatar-cmd',
    exampleFile: 'prompts/avatar/examples/avatar-cmd.json',
  },
  'bilibili-danmaku-batch': {
    sceneTemplate: 'avatar.scenes.bilibili-batch',
    userFrameTemplate: 'avatar.user-frames.bilibili-batch',
    exampleFile: 'prompts/avatar/examples/bilibili-batch.json',
  },
  'livemode-private-batch': {
    sceneTemplate: 'avatar.scenes.bilibili-batch',
    userFrameTemplate: 'avatar.user-frames.bilibili-batch',
    exampleFile: 'prompts/avatar/examples/bilibili-batch.json',
  },
};

const BASE_SYSTEM_TEMPLATE = 'avatar.base.system';

@injectable()
export class PromptAssemblyStage implements Live2DStage {
  readonly name = 'prompt-assembly';
  private readonly messageAssembler = new PromptMessageAssembler();
  /**
   * Cache parsed examples per source. Files are read once on first use
   * (cheap to parse, but saves the FS call on every danmaku batch).
   * Falsy cache entries (empty array) are valid — "no examples" is a
   * legitimate configuration.
   */
  private readonly exampleCache = new Map<Live2DSource, FewShotExample[]>();

  constructor(
    @inject(DITokens.PROMPT_MANAGER) private promptManager: PromptManager,
    @inject(DITokens.AVATAR_SESSION_SERVICE) private sessionService: AvatarSessionService,
  ) {}

  async execute(ctx: Live2DContext): Promise<void> {
    if (!ctx.avatar) return;

    ctx.availableActions = formatActionsForPrompt(ctx.avatar.listActions());

    // Resolve the shared avatar fragments (persona, tag-spec, action list,
    // anti-repeat) once so the base template can compose them in. Partials
    // that fail to render are returned as empty strings — the base template
    // still renders with blank slots rather than aborting the whole run.
    const partials = renderAvatarPartials(this.promptManager, ctx.availableActions);

    const templates = TEMPLATES_BY_SOURCE[ctx.input.source];
    if (!templates) {
      logger.error(`[Live2D/prompt-assembly] no template mapping for source="${ctx.input.source}"`);
      ctx.skipped = true;
      ctx.skipReason = 'prompt-render-failed';
      return;
    }

    let baseSystem: string;
    let sceneSystem: string;
    let framedQuery: string;
    try {
      // Use the shared base-system renderer so `currentDate` / `adminUserId`
      // get injected identically to the main pipeline (PromptManager.renderBasePrompt).
      // Extra vars (partials, availableActions) ride through via overrides.
      const rendered = this.promptManager.renderBaseSystemTemplate(BASE_SYSTEM_TEMPLATE, {
        availableActions: ctx.availableActions,
        ...partials,
      });
      if (!rendered) {
        throw new Error(`base-system template "${BASE_SYSTEM_TEMPLATE}" missing and no fallback available`);
      }
      baseSystem = rendered;
      sceneSystem = this.promptManager.render(templates.sceneTemplate, {
        availableActions: ctx.availableActions,
        ...partials,
      });
      framedQuery = this.promptManager.render(templates.userFrameTemplate, {
        input: ctx.input.text,
      });
    } catch (err) {
      logger.error(`[Live2D/prompt-assembly] template render failed (source=${ctx.input.source}):`, err);
      ctx.skipped = true;
      ctx.skipReason = 'prompt-render-failed';
      return;
    }

    // Back-compat + debug: expose the concatenated system text so callers
    // (and the existing stage tests) can inspect the full system prompt in
    // one string. LLMStage prefers `ctx.messages` when present, so this
    // never actually drives the LLM request.
    ctx.systemPrompt = `${baseSystem}\n\n${sceneSystem}`;

    // Few-shot examples for this source. Missing / malformed files are
    // treated as "no examples" — the pipeline should still run without
    // them, just with a bit less behavioral priming.
    const fewShotExamples = this.loadExamples(ctx.input.source, templates.exampleFile);

    // Session thread: lazily created on first use per (source, scope).
    const scope = this.resolveScope(ctx);
    ctx.threadId = this.sessionService.ensureThread(ctx.input.source, scope);
    const historyEntries = this.sessionService.getHistoryEntries(ctx.threadId);

    // Optional memory context. MemoryService expects a `groupId` — reuse the
    // session's groupId so memory is scoped to this Live2D session, not to
    // any real QQ group. When MemoryService isn't in the container (tests,
    // minimal deployments), skip silently.
    const memoryContext = await this.resolveMemoryContext(ctx);

    ctx.messages = this.messageAssembler.buildNormalMessages({
      baseSystem,
      sceneSystem,
      fewShotExamples,
      historyEntries,
      finalUserBlocks: {
        memoryContext,
        currentQuery: framedQuery,
      },
    });
  }

  /**
   * Derive a sub-scope for multi-tenant sources. avatar-cmd is global by
   * design; bilibili-danmaku-batch could carry a roomId in meta when
   * multi-room support lands; livemode would carry the userId.
   */
  private resolveScope(ctx: Live2DContext): string | undefined {
    const meta = ctx.input.meta ?? {};
    const roomId = meta.roomId;
    if (typeof roomId === 'string' && roomId) return roomId;
    const scope = meta.scope;
    if (typeof scope === 'string' && scope) return scope;
    return undefined;
  }

  /**
   * Load + parse the source's few-shot JSON file once, then cache. Any
   * error (missing file, bad JSON, wrong shape) falls back to an empty
   * list — the scene system prompt still fully describes the task, so
   * missing examples degrade gracefully.
   */
  private loadExamples(source: Live2DSource, relativePath: string): FewShotExample[] {
    const cached = this.exampleCache.get(source);
    if (cached) return cached;

    let examples: FewShotExample[] = [];
    try {
      const absolute = resolve(getRepoRoot(), relativePath);
      const raw = readFileSync(absolute, 'utf-8');
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        throw new Error(`expected JSON array, got ${typeof parsed}`);
      }
      examples = parsed
        .filter((it): it is { role: string; content: string } => {
          return (
            typeof it === 'object' &&
            it !== null &&
            typeof (it as { role?: unknown }).role === 'string' &&
            typeof (it as { content?: unknown }).content === 'string'
          );
        })
        .filter((it) => it.role === 'user' || it.role === 'assistant')
        .map((it) => ({ role: it.role as 'user' | 'assistant', content: it.content }));
    } catch (err) {
      logger.debug(
        `[Live2D/prompt-assembly] examples load skipped (non-fatal) source=${source} path=${relativePath}:`,
        err,
      );
      examples = [];
    }

    this.exampleCache.set(source, examples);
    return examples;
  }

  private async resolveMemoryContext(ctx: Live2DContext): Promise<string | undefined> {
    const container = getContainer();
    if (!container.isRegistered(DITokens.MEMORY_SERVICE)) return undefined;
    try {
      const memoryService = container.resolve<MemoryService>(DITokens.MEMORY_SERVICE);
      const groupId = ctx.threadId ? this.groupIdFromThread(ctx) : '';
      if (!groupId) return undefined;

      // Group memory: one lookup regardless of source. Use the batch-wide
      // text (avatar-cmd utterance or danmaku summary) as the RAG query —
      // group-scope facts care about the *scene*, not any single speaker.
      const groupLookup = memoryService.getFilteredMemoryForReplyAsync(groupId, GROUP_MEMORY_USER_ID, {
        userMessage: ctx.input.text,
        alwaysIncludeScopes: ['instruction', 'rule'],
        minRelevanceScore: 0.7,
      });

      // User memory: 0–N speakers depending on source.
      // - bilibili-danmaku-batch: fan out across `meta.senders` (distinct
      //   viewers this 3s window).
      // - livemode / any single-sender source: one speaker from `input.sender.uid`.
      // - avatar-cmd: no sender → empty array → no per-user lookups.
      const candidates = this.collectMemoryCandidates(ctx);

      // Filesystem pre-filter: don't fire Qdrant for uids that have no
      // memory on disk (dominant case in live streams — most viewers are
      // strangers). One `existsSync` per uid, cheap compared to RAG.
      const withMemory = candidates.filter((c) => memoryService.hasUserMemory(groupId, c.uid));

      const userLookups = withMemory.map(async (c) => {
        const result = await memoryService.getFilteredMemoryForReplyAsync(groupId, c.uid, {
          userMessage: c.queryText,
          alwaysIncludeScopes: ['instruction', 'rule'],
          minRelevanceScore: 0.7,
        });
        return { uid: c.uid, nick: c.nick, memoryText: result.userMemoryText } satisfies MemorySpeakerSection;
      });

      const [groupResult, userSections] = await Promise.all([groupLookup, Promise.all(userLookups)]);

      const rendered = formatMemoryMarkdown({
        groupMemoryText: groupResult.groupMemoryText,
        userSections,
      });
      return rendered.length > 0 ? rendered : undefined;
    } catch (err) {
      logger.debug('[Live2D/prompt-assembly] memory resolve skipped (non-fatal):', err);
      return undefined;
    }
  }

  /**
   * Flatten the candidate speaker list from whichever source populated it.
   * `meta.senders` (bilibili batches) takes precedence over the single-
   * valued `input.sender` so a caller that forwards both doesn't double-
   * count a uid. Per-user `queryText` is that speaker's own utterance if
   * available, else the batch-wide text — so RAG ranks a viewer's memory
   * by *what they said*, not by the aggregate noise of the batch.
   */
  private collectMemoryCandidates(ctx: Live2DContext): Array<{ uid: string; nick: string; queryText: string }> {
    const senders = this.readSendersMeta(ctx);
    if (senders && senders.length > 0) {
      return senders
        .filter((s) => s.uid)
        .map((s) => ({
          uid: s.uid,
          nick: s.name,
          queryText: s.text?.trim() ? s.text : ctx.input.text,
        }));
    }
    const singleUid = ctx.input.sender?.uid;
    if (!singleUid) return [];
    return [
      {
        uid: singleUid,
        nick: ctx.input.sender?.name ?? '',
        queryText: ctx.input.text,
      },
    ];
  }

  private readSendersMeta(ctx: Live2DContext): AvatarBatchSender[] | undefined {
    const raw = ctx.input.meta?.senders;
    if (!Array.isArray(raw)) return undefined;
    const out: AvatarBatchSender[] = [];
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue;
      const uid = (item as { uid?: unknown }).uid;
      const name = (item as { name?: unknown }).name;
      const text = (item as { text?: unknown }).text;
      if (typeof uid !== 'string' || !uid) continue;
      out.push({
        uid,
        name: typeof name === 'string' ? name : '',
        text: typeof text === 'string' ? text : undefined,
      });
    }
    return out;
  }

  /**
   * Recover the groupId the session service used for this thread. We don't
   * persist it on the ctx to avoid leaking implementation details, but
   * memory lookups need a consistent scope key. The session's thread's
   * owning group is the right key.
   */
  private groupIdFromThread(ctx: Live2DContext): string {
    // Session service scopes by `live2d:<source>[:<scope>]`. Reuse the same
    // convention here (matches Live2DSessionService.resolveGroupId).
    const source = ctx.input.source;
    const scope = this.resolveScope(ctx);
    if (source === 'avatar-cmd') return 'live2d:avatar-cmd:global';
    if (source === 'bilibili-danmaku-batch') {
      return scope ? `live2d:bilibili-live:${scope}` : 'live2d:bilibili-live';
    }
    return scope ? `live2d:${source}:${scope}` : `live2d:${source}`;
  }
}
