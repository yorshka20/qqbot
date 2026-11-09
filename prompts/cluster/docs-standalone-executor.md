## 文档职责：直接派遣（没有 planner）

这个 job 没有 planner，kb 条目由**你**写。

- 本仓库内、受这次改动影响的文档（架构文档、README、项目的 CLAUDE.md / AGENTS.md 里要求保持最新的章节）和代码**在同一个 commit 里**更新；项目的文档规则以它的 CLAUDE.md / AGENTS.md 为准。
- 代码验收通过、commit 之后，在项目 kb（cwd 下的 `_kb/`）里写 job 的条目：先读 `_kb/CLAUDE.md`，按它的约定写 workbook（文件名、月度索引行）、更新 learnings 和相关 task 的 roadmap / todo，并运行它指明的生成脚本。
  代码 commit 的 body 末尾写 `See workbook <name>.`（如果项目的 commit 约定要求）。
- kb 是独立的 git 仓库：`_kb` 是符号链接，用 `readlink` / `realpath` 找到它的根，在那里**只 `git add` 你写过的路径**，按 `_kb/CLAUDE.md` 的 commit 格式提交，**不要 `git push`**，把 kb 的 commit hash 写进最终 summary。
- cwd 里没有 `_kb`（项目没有 kb，或在远程机器上）：在 summary 里写「本项目无 kb」，并把「文档要点」（问题 / 根因 / 改法 / 涉及文件 / 验证 / 坑）留在 summary 里。
