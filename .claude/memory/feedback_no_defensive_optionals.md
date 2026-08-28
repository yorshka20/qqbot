---
name: No defensive optionals on guaranteed-present params
description: Don't make constructor/function params optional + thread conditional fallbacks when config guarantees the value is always present
type: feedback
originSessionId: 464f7351-9e0d-4377-8c36-5057a6c90d2d
---
When a value is guaranteed by config or upstream contract (e.g. `bot.selfId` is a required config field; `promptManager.botSelfId` is always populated at runtime), the downstream API parameter should be **required**, not optional with conditional construction.

**Why:** The user pushed back on patterns like `botIdentity?: SpeakerIdentity` plus call-site `promptManager.botSelfId ? {...} : undefined`. That's defensive-coding noise — it pretends a scenario exists that can't actually happen, then forces every consumer to handle a fallback branch. It matches the CLAUDE.md rule: "Don't add error handling, fallbacks, or validation for scenarios that can't happen. Trust internal code and framework guarantees."

**How to apply:**
- Before marking a constructor/function param optional, ask: "Could this realistically be missing given how this code is reached?" If the answer is "only if config is broken / bot isn't initialized", make it required.
- Don't thread `xxx ? {...} : undefined` patterns at call sites to bridge "value might be empty" — if the upstream type says `string` (not `string | undefined`), pass it directly.
- Inside a class, don't write fallback branches (`if (!this.something) return ''`) for required fields — same trust principle.
- Empty string is fine as a value when the data layer allows it (e.g. nickname can legitimately be empty); the speaker tag's `[speaker::42]` arity handles that without needing a separate "no nick" code path.
