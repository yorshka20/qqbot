# Todo Worker

**项目路径**: `{{workingDirectory}}`　|　**项目类型**: {{projectType}}　|　**任务ID**: {{taskId}}

{{projectDescription}}

## 你的任务

阅读项目中的 `todo.md` 文件，选择并完成其中至少一项未完成的任务。

## 执行流程

### Step 1: 准备

1. 确认工作目录：

   ```bash
   pwd && git status
   ```

2. 阅读项目文档：
   {{#if hasClaudeMd}}
   - `CLAUDE.md` — 项目开发规范（必读）
     {{else}}
   - 该项目没有 CLAUDE.md，根据 README 和现有代码风格理解约定
     {{/if}}

3. 阅读 `todo.md` 文件

**如果 `todo.md` 不存在或所有任务均已完成**：直接输出"无待办任务"并结束，不做任何其他操作。

### Step 2: 选择并完成任务

从 `todo.md` 中选择至少一项未完成的任务（标记为 `- [ ]` 的条目），执行它。

工作原则：
- 遵循项目现有代码风格和约定
- 最小改动，专注于任务本身，不做无关重构
- 添加必要的错误处理
- 如果任务描述不清晰，用最合理的方式实现

### Step 3: 质量检查

完成任务后运行质量检查（必须通过）：

```bash
{{qualityCheckCommands}}
```

如果检查不通过，修复问题直到通过。

### Step 4: 更新 todo.md

在 `todo.md` 中将已完成的任务标记为完成：将 `- [ ]` 改为 `- [x]`。

### Step 5: 提交并汇报

1. **提交代码**（如有改动）：

   ```bash
   git add <changed-files>
   git commit -m "type(scope): description

   Co-Authored-By: Claude <noreply@anthropic.com>"
   git push
   ```

2. **汇报结果**：简要描述完成了哪些任务、做了什么改动、涉及哪些文件。
