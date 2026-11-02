/**
 * Text-based tool call stripping (`<tool_call>` / `<tool_result>` XML blocks).
 *
 * When a model doesn't use the structured tool-use API but sees tool instructions in the
 * system prompt, it may emit text-based tool calls and hallucinated tool results. These must
 * be stripped before sending to the user. Provider-specific markup (DeepSeek's DSML) is
 * handled inside that provider and never reaches here.
 */

const TEXT_TOOL_CALL_RE = /<tool_call>[\s\S]*?<\/tool_call>/g;
const TEXT_TOOL_RESULT_RE = /<tool_result>[\s\S]*?<\/tool_result>/g;
/** Unclosed trailing blocks (model stopped mid-generation) */
const TEXT_TOOL_CALL_UNCLOSED_RE = /<tool_call>[\s\S]*$/;
const TEXT_TOOL_RESULT_UNCLOSED_RE = /<tool_result>[\s\S]*$/;

/**
 * Check whether text contains text-based tool call or tool result blocks.
 */
export function containsTextToolCalls(text: string): boolean {
  return text.includes('<tool_call>') || text.includes('<tool_result>');
}

/**
 * Strip all `<tool_call>...</tool_call>` and `<tool_result>...</tool_result>` blocks
 * from text, including unclosed trailing blocks. Returns cleaned text.
 */
export function stripTextToolCalls(text: string): string {
  let result = text
    .replace(TEXT_TOOL_CALL_RE, '')
    .replace(TEXT_TOOL_RESULT_RE, '')
    .replace(TEXT_TOOL_CALL_UNCLOSED_RE, '')
    .replace(TEXT_TOOL_RESULT_UNCLOSED_RE, '');

  // Collapse multiple blank lines left by removal
  result = result.replace(/\n{3,}/g, '\n\n').trim();
  return result;
}

/**
 * Strip the text-based `<tool_call>` / `<tool_result>` blocks a model can leak into text
 * meant for the chat. Returns the input unchanged when it carries none.
 */
export function stripLeakedToolCalls(text: string): string {
  return containsTextToolCalls(text) ? stripTextToolCalls(text) : text;
}
