---
name: feedback_prompts_live_in_prompt_files
description: Never assemble prompt prose in TypeScript; every sentence a model reads lives in a prompts/ template file and code only loads it and fills {{TOKENS}}
metadata:
  type: feedback
---

Prompt text is never written in code. Any sentence a model will read — a role preamble, a
workspace note, a planner's confirmation question, an instruction appended to a task — lives in a
template file (`prompts/cluster/*.md` for the cluster, `prompts/` for the bot). Code loads the file
(`packages/agent-cluster/src/cluster/prompts.ts` for the cluster) and fills `{{TOKENS}}` with facts;
it may concatenate loaded templates, never literal prose. A string in a `.ts` file that ends up in
a model's context is a bug, even if it is one line.

**Why:** the owner has corrected this repeatedly ("我说了无数遍不能在代码里拼接prompt"). Prompts are
edited and reviewed as text, overridden per project (`<projectPath>/prompts/cluster/` wins), and
read by people who do not read TypeScript; prose in code escapes all of that and drifts.

**How to apply:** when a feature needs to tell a worker something, add or extend a file under
`prompts/cluster/`, add a token for each fact, and render it through `loadClusterPrompt` +
`renderPrompt`. Review your diff for Chinese or English sentences inside string literals before
committing. See [[feedback_console_ia_and_dispatch]].
