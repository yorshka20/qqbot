---
name: feedback_commit_current_branch
description: Always commit on the current branch — never auto-create a branch unless explicitly asked
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 54b0ab0d-4d9a-4b45-97fa-a027077d08bd
---

When the user asks to commit, commit directly on the **current branch** (including `master`/default). Do NOT create a feature branch first, even on the default branch.

**Why:** This is a single-dev trunk-based repo; auto-branching adds friction and disrupts the user's restart/test workflow. The user explicitly overrode the generic "branch first on default branch" harness default for this project.

**How to apply:** `git add` + `git commit` on whatever branch is checked out. Only create/switch branches when the user explicitly requests it. Commit message trailer convention still applies (Co-Authored-By line). Related: [[feedback_local_planning_artifacts]].
