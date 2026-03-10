## Learned User Preferences

- Do not add non-provider modules inside the provider directory; keep provider-specific state (e.g. key mode) inside the provider class.
- Reuse shared utilities instead of reimplementing (e.g. image-to-base64 + mime); migrate common logic to a shared module.
- Unify duplicate code paths: prefer a single entry point (e.g. handleCardReply) over separate methods that duplicate logic.
- In tests, when template files exist on disk, use loadTemplatesFromDirectory() so templates are loaded as in production; avoid manual registerTemplate when the file is already there.
- Type definitions: make required fields non-optional when the value is always set (e.g. metadata, protocol types).
- Do not hardcode lists or order when the value can come from the module (e.g. capabilities from ProviderRegistry, sort order use alphabetical unless there is a clear reason).
- Prefer a single representation over boolean + enum (e.g. use replyTriggerType only instead of triggeredByAtBot + triggeredByWakeWord + replyTriggerType).
- Prefer one format for single/multi variants (e.g. card deck always as array; single card is [one card]).
- Use English comments in code; do not delete comments when editing.
- Always use curly braces for if/else; use ESM import only, no inline require.

## Learned Workspace Facts

- QQ bot project with plugin pipeline (MessageTriggerPlugin, WhitelistPlugin, ProactiveConversation, etc.), AI providers (Gemini, Doubao, etc.), and HookContext/metadata flow.
- Card rendering: convert_to_card output is a JSON array of cards; single card is [one card]; comparison card uses leftHeader/rightHeader from data, not fixed labels.
- Reply trigger is centralized in MessageTriggerPlugin; trigger type is stored as replyTriggerType (at | reaction | wakeWordConfig | wakeWordPreference | providerName).
