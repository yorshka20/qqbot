# Prompt Templates Directory

This directory contains prompt templates used by the AI service. Templates are organized by capability/namespace.

## Reply and proactive flows (split structure)

The main LLM reply flows use a **split** structure instead of a single monolithic prompt:

1. **Base** (`base.system.txt`) – First system message: global identity, role-based message layout, and strict rules.
2. **Scene system** – Second system message:
   - Normal reply: `llm/reply.system.txt` (参考信息说明 for structured blocks + 对话历史 rule + rules).
   - Proactive reply: `llm/proactive.system.txt` (参考信息说明 + 人设 + 规则).
3. **User messages** – History as user/assistant turns, then one final user message whose content is **assembled in code** (see `PromptMessageAssembler.buildFinalUserContent`) with fixed tags: `<memory_context>`, `<rag_context>`, `<search_results>`, `<task_results>`, `<current_query>`. The `<current_query>` body is rendered from `llm/reply.user_frame.txt` or `llm/proactive.user_frame.txt`.

The “参考信息说明” (what each block means) and behavior rules live in the **scene system** templates (`llm.reply.system`, `llm.proactive.system`), not in the block content templates.

**Legacy (reference only, not used by active flow):**

- `llm/reply.txt` – Legacy monolithic normal-reply template.
- `llm/proactive_reply.txt` – Legacy monolithic proactive-reply template.

## Directory Structure

```
prompts/
├── base.system.txt   # Base system prompt (global behavior).
├── base.txt          # Base prompt (optional); see config.
├── llm/              # Language Model prompts
│   ├── reply.txt            # Legacy monolithic (reference only)
│   ├── reply.system.txt     # Normal-reply scene system (参考信息说明 + rules)
│   ├── reply.user_frame.txt # Normal-reply current-query frame
│   ├── proactive_reply.txt   # Legacy monolithic (reference only)
│   ├── proactive.system.txt # Proactive-reply scene system
│   ├── proactive.user_frame.txt
│   └── ...
├── vision/
├── text2img/
└── img2img/
```

## Template Format

Templates use `{{variableName}}` syntax for variable substitution.

### Example

```text
You are a helpful assistant.

{{conversationHistory}}

User: {{userMessage}}

Please respond.
```

## Supported File Extensions

- `.txt` - Plain text templates
- `.md` - Markdown templates
- `.prompt` - Prompt-specific templates

## Template Naming

- File name (without extension) becomes the template name
- Directory structure forms the namespace
- Example: `llm/reply.txt` → template name: `llm.reply`

## Variables

Common variables used in templates:

- `{{userMessage}}` - The user's message content
- `{{conversationHistory}}` - Formatted conversation history
- `{{description}}` - Image generation description
- `{{style}}` - Image style preference
- `{{quality}}` - Image quality setting
- `{{instructions}}` - Transformation instructions
- `{{originalDescription}}` - Original image description

## Base Prompt

A template named **base** (file: `prompts/base.txt`) is rendered via `promptManager.renderBasePrompt()` and should be passed to model calls as `systemPrompt`.

## Usage in Code

Normal and proactive replies are built via `PromptMessageAssembler` (see `ReplyGenerationService.buildReplyMessages`, `AIService.generateProactiveReply`): base system + scene system (`llm.reply.system` or `llm.proactive.system`) + history entries + one user message with assembled blocks. The current-query segment is rendered from `llm.reply.user_frame` or `llm.proactive.user_frame`.

```typescript
// Example: render scene system and user frame
const sceneSystem = promptManager.render('llm.reply.system', {});
const currentQuery = promptManager.render('llm.reply.user_frame', { userMessage: '...' });
const baseSystem = promptManager.renderBasePrompt();
```

## Configuration

Set the prompt directory in `config.jsonc`:

```jsonc
{
  "prompts": {
    "directory": "prompts", // Relative to project root or absolute path
  },
}
```
