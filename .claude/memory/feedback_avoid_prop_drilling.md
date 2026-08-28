---
name: feedback-avoid-prop-drilling
description: "Don't reflexively thread values through params/constructors (透传/prop-drilling); read from a held dependency or the existing flowing context — but adding a NEW context/metadata field needs justification, ask if unsure"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 7b399697-625d-4720-8989-db04c2a99510
---

Stop defaulting to pass-through (透传 / prop-drilling): adding a parameter / constructor option and forwarding a value down through intermediate layers that don't care about it.

**Decision order when a consumer needs a value:**
1. **Does the consumer already hold a dependency that reaches the value?** → read it there. (e.g. `ReflectionEngine` already held `personaService` and already read `getConfig().reflection` for `toolEquipped`; threading `pinnedProvider` from `PersonaCompletionHookPlugin` through `options` was redundant — the fix was `this.personaService.getConfig().reflection?.provider` right where the rest of the config is read.)
2. **Is it request-scoped and crosses pipeline stages?** → put it on the existing flowing carrier (`HookContext.metadata` typed map, `ReplyPipelineContext` ctx fields). (e.g. `recentActionsText` on ctx was correct.)
3. **Pure function where explicitness aids testability?** → then explicit params are fine (e.g. `buildPromptPatchAsync` opts).

**But don't over-correct into bloating the carrier.** Adding a NEW field to `metadata` / a context object is itself a decision with a bar: confirm it's genuinely necessary (can't a consumer reach it via an existing dep? is it really cross-stage request state, not a junk-drawer dump?). **If you can't decide whether the new field is warranted, ask the user — don't guess.**

**Why:** prop-drilling causes signature churn, redundant plumbing, and couples intermediate layers to values they don't use. The codebase deliberately provides shared carriers (typed `HookContext.metadata`, ctx objects, services-hold-config) so values don't need threading. But a metadata/context bag that accretes fields carelessly becomes a junk drawer with implicit coupling — so new fields need real justification.

**How to apply:** Before adding a param/option to thread a value, check decision order above. Before adding a metadata/context field, justify necessity; if unsure, ask. Related: [[feedback_no_defensive_optionals]].
