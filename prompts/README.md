# Prompt Templates Directory

This directory contains prompt templates used by the AI service. Templates are organized by capability/namespace.

## Directory Structure

```
prompts/
├── base.txt          # Base prompt (optional). Injected at the start of every rendered prompt to define global AI behavior (style, accuracy, timeliness, etc.). Omit or leave empty to disable.
├── llm/              # Language Model prompts
│   └── reply.txt     # Main reply template
├── vision/           # Vision/Multimodal prompts
│   └── image-description.txt
├── text2img/         # Text-to-Image prompts
│   └── generate.txt
└── img2img/          # Image-to-Image prompts
    └── transform.txt
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

A template named **base** (file: `prompts/base.txt`) is treated as the **base prompt**. By default it is **not** prepended; pass `{ injectBase: true }` only where a flow needs global context (typically once per flow):

```typescript
promptManager.render('llm.reply', vars, { injectBase: true });
```

## Usage in Code

```typescript
// Render a template (no base by default)
const prompt = promptManager.render('llm.reply', {
  userMessage: 'Hello',
  conversationHistory: 'Previous messages...',
}, { injectBase: true });
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
