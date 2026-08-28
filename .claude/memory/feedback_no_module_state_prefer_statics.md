---
name: No module-level state; prefer statics on the owning class
description: Don't hold state in module-level mutable variables when something already owns it authoritatively, and expose such accessors as class statics rather than standalone module functions
type: feedback
---
Two corrections given in the same review pass, both about **where behavior and state belong**:

1. **Don't introduce module-level mutable state** (`let active = false` + setter/getter in a module) when an existing component already holds that state authoritatively. The user's words: 「谁让你用模块变量来做这个？重做！」
2. **Prefer a `static` method on the class that owns the concern** over a standalone exported module function. The user's words: 「能不能做成 static 方法？为什么选择模块存函数？」

**Why:** A module-level flag written by one component and read by another is a second copy of a truth someone else already owns — it drifts, and it matches the "last-emitted memo" patch smell that CLAUDE.md explicitly calls out. Reading the authoritative holder instead means there is nothing to keep in sync. And when the accessor is *about* a specific class, hanging it off that class keeps the association visible at every call site; a free function in a helper module hides who the concern belongs to.

**How to apply:**
- Before adding a module `let`, ask who already knows this. Usually a manager/registry/service does — add a small public sync accessor there and read it. (Concrete case: plugin enablement lives in `PluginManager.enabledPlugins`; the fix was `PluginManager.isPluginEnabled(name)` + `WeChatIngestPlugin.isEnabled()` static, not a `wechat/availability.ts` flag.)
- Put the accessor on the concrete class that owns the concern, reading its own constant.
- **Do not** reach for a generic `static` on a base class that depends on polymorphic `this` — bun's transpiler inlines `this` in a static body to the *declaring* class, so subclass calls silently read the base class. Typecheck stays green. See `.claude-learnings/monorepo.md`.
- Related: [[feedback_no_defensive_optionals]], [[feedback_avoid_prop_drilling]] — same family of "don't add a layer that pretends to own something it doesn't".
