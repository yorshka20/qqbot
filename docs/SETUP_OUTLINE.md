# Setup Guide — Outline

> **Status: OUTLINE ONLY.** Each section below is intentionally a skeleton; prose will be fleshed out in a follow-up pass. The shape is captured separately so we can review structure before committing to writing.

## Strategic Context

These decisions shape the guide and affect future work beyond it (README framing, prompt translation, protocol examples). Captured here, in a repo-tracked doc, so they persist across machines and contributors.

- **Audience**: Non-developer end users in overseas markets, working alongside an AI assistant.
- **Primary protocol in examples**: **Discord**. QQ via LLBot is kept as an "alternative protocol" path. The repository is historically named `qqbot` for legacy reasons, but user-facing docs now lead with Discord.
- **Language**: **English**. The bot's prompt templates (`prompts/`) are currently Chinese and will be translated and tested in English later. New user-facing docs (this SETUP guide, future onboarding pages) are written in English from the start to avoid retranslation cost.

These decisions are not final policy. When overseas positioning hardens further, we may revisit the main README's QQ-first framing and consider renaming the repo.

---

## Outline (to be fleshed out)

### §0 — What you'll have at the end

- One-paragraph success picture: three concrete capabilities the user will have working
  - bot replies when @-mentioned
  - bot remembers facts the user tells it
  - long replies render as images
- A note that this guide assumes the reader is working with an AI assistant (Claude / ChatGPT / etc.) and that pasting sections to it is the expected workflow.

### §1 — Before you start

- 1.1 A machine — macOS / Linux preferred; Windows via WSL
- 1.2 Bun runtime — link + one-liner install
- 1.3 A protocol account (choose one):
  - **Discord (recommended)** — bot in Developer Portal, token, intents
  - **QQ via LLBot (alternative)** — link upstream; defer details to AI assistant
- 1.4 An LLM provider API key — non-prescriptive list (OpenAI / Anthropic / DeepSeek / Gemini / OpenRouter / Ollama for local)
- 1.5 *(Optional, deferred to §5)* System Chromium for card rendering

### §2 — Get the code

- `git clone` / `bun install` / `bun run typecheck`
- **Acceptance:** typecheck exits 0
- Failure path: paste error to the AI assistant

### §3 — Configure the minimum fields

- 3.1 Pick a config layout — single-file `config.jsonc` vs `config.d/` directory
- 3.2 The five fields that matter:
  - (a) `protocols[0]` — Discord token / intents (default example); collapsible "If you chose QQ instead" subsection
  - (b) `bot.owner` — your Discord/QQ user ID
  - (c) `database` — sqlite default + path
  - (d) `ai.defaultProviders.llm` — which provider name you'll use
  - (e) `ai.providers.<name>` — apiKey / baseUrl / model
- 3.3 "Hand this section to your AI assistant" — ready-to-copy prompt template
- 3.4 What to ignore for now — explicit list of optional sections (`mcp`, `cluster`, `avatar`, `contextMemory`, …)

### §4 — First start: smoke-test → dev → first reply

- 4.1 `bun run smoke-test` — MANDATORY gate. **Acceptance:** exit 0. Failure → paste last 50 lines to AI assistant
- 4.2 `bun run dev` — should connect to your protocol within ~5s. **Acceptance:** log line indicating `connected to <protocol>`
- 4.3 Talk to the bot — @-mention in a server/group, say "hello". **Acceptance:** bot replies in <10s with LLM-generated text
- 4.4 Failure matrix: no reply / error in log / wrong account replied / etc.

### §5 — Turn on common features

Each sub-section follows the pattern **Why / Config / Verify**.

- 5.1 **Whitelist** — keep strangers from burning your LLM quota
- 5.2 **Memory** — bot remembers facts (`memory` + `memoryTrigger` plugins)
- 5.3 **Card rendering** — long replies become images
  - Includes Chromium detection + OS-specific install hint (delegate to AI assistant for the exact command)

### §6 — Keep it running

- 6.1 PM2 via the included `ecosystem.config.cjs`
- 6.2 Where logs live (`logs/`), how to tail, rotation
- 6.3 Restart / upgrade safely

### §7 — When something goes wrong

- A symptom matrix: 4–6 common failure modes × (where to look, what to grab, what to paste to AI assistant)
- Emphasize: smoke-test stack traces are unusually informative — always run smoke-test first when debugging

### §8 — What's next (optional)

One line + link each:

- WebUI admin → `packages/webui/README.md`
- Live2D avatar → `packages/avatar/README.md`
- Agent cluster → `docs/AGENT_CLUSTER_DESIGN.md`
- Agenda (proactive scheduled tasks)
- Custom plugins (PluginBase reference in main README)
- Switching protocols / connecting multiple at once

---

## Cross-section writing conventions

When fleshing out the outline, two conventions apply across all sections:

1. **Every section ends with an explicit `Acceptance:` line.** Spells out the success condition so the user's AI assistant can verify before moving on.
2. **Every "ask your AI assistant" moment is a fenced *"Ask your AI assistant"* prompt block.** Templated, so the user can copy-paste without thinking.

---

## Follow-ups deferred from this outline

- **README rewrite** to be protocol-neutral (currently QQ-first) — defer until overseas positioning hardens.
- **Repo rename** away from `qqbot` — same condition.
- **English translation of `prompts/`** templates — separate effort, not part of this guide.
- **A short companion doc for the user's AI assistant** (think `AGENT_SETUP_HELPER.md`) that codifies what the AI should do at each step — only worth writing if SETUP.md alone proves insufficient in practice.
