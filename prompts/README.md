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

A template named **base** (file: `prompts/base.txt`) is treated as the **base prompt**. Its content is prepended to every `render()` result, so you can define global behavior (tone, accuracy, timeliness, scope) in one place. To skip base injection for a specific call (e.g. image or task prompts), pass `{ skipBase: true }`:

```typescript
promptManager.render('text2img.generate', vars, { skipBase: true });
```

## Usage in Code

```typescript
// Render a template (base prompt is prepended if prompts/base.txt exists)
const prompt = promptManager.render('llm.reply', {
  userMessage: 'Hello',
  conversationHistory: 'Previous messages...',
});
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
