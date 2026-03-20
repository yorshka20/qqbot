/**
 * DSML (DeepSeek Markup Language) text-based function call parser.
 *
 * Some DeepSeek-based models (including doubao-seed which uses DeepSeek internally)
 * emit tool calls as DSML text in the content field instead of structured tool_calls,
 * especially when the API doesn't pass tools or the model ignores the tool calling format.
 *
 * Format:
 *   <｜DSML｜function_calls>
 *   <｜DSML｜invoke name="tool_name">
 *   <｜DSML｜parameter name="key" string="true">value</｜DSML｜parameter>
 *   </｜DSML｜invoke>
 *   </｜DSML｜function_calls>
 */

/** Full-width bar ｜ (U+FF5C) used in DSML tags */
const FW_BAR = '\uFF5C';
const DSML_TAG_OPEN = `<${FW_BAR}DSML${FW_BAR}`;
const DSML_TAG_CLOSE_PREFIX = `</${FW_BAR}DSML${FW_BAR}`;
const DSML_FC_OPEN = `${DSML_TAG_OPEN}function_calls>`;
const DSML_FC_CLOSE = `${DSML_TAG_CLOSE_PREFIX}function_calls>`;

export interface DSMLFunctionCall {
  name: string;
  arguments: Record<string, unknown>;
}

/**
 * Check whether text contains a DSML function call block.
 */
export function containsDSML(text: string): boolean {
  return text.includes(DSML_FC_OPEN);
}

/**
 * Parse the first DSML function call from text.
 * Returns null if no valid DSML function call is found.
 */
export function parseDSMLFunctionCall(text: string): DSMLFunctionCall | null {
  const fcStart = text.indexOf(DSML_FC_OPEN);
  if (fcStart === -1) return null;

  const fcEnd = text.indexOf(DSML_FC_CLOSE, fcStart);
  const block =
    fcEnd === -1 ? text.slice(fcStart + DSML_FC_OPEN.length) : text.slice(fcStart + DSML_FC_OPEN.length, fcEnd);

  // Extract invoke name
  const invokeRe = new RegExp(`${DSML_TAG_OPEN}invoke\\s+name="([^"]+)">`);
  const invokeMatch = block.match(invokeRe);
  if (!invokeMatch) return null;

  const fnName = invokeMatch[1];

  // Extract parameters
  const paramRe = new RegExp(
    `${DSML_TAG_OPEN}parameter\\s+name="([^"]+)"\\s+string="(true|false)">(.*?)${DSML_TAG_CLOSE_PREFIX}parameter>`,
    'gs',
  );
  const args: Record<string, unknown> = {};
  for (const m of block.matchAll(paramRe)) {
    const [, paramName, isString, rawValue] = m;
    if (isString === 'true') {
      args[paramName] = rawValue;
    } else {
      const trimmed = rawValue.trim();
      if (trimmed === 'true') args[paramName] = true;
      else if (trimmed === 'false') args[paramName] = false;
      else if (trimmed === 'null') args[paramName] = null;
      else {
        const num = Number(trimmed);
        args[paramName] = Number.isNaN(num) ? trimmed : num;
      }
    }
  }

  return { name: fnName, arguments: args };
}

/**
 * Strip DSML function call block(s) from text, returning the remaining content.
 */
export function stripDSML(text: string): string {
  const fcStart = text.indexOf(DSML_FC_OPEN);
  if (fcStart === -1) return text;

  const fcEnd = text.indexOf(DSML_FC_CLOSE, fcStart);
  const endPos = fcEnd === -1 ? text.length : fcEnd + DSML_FC_CLOSE.length;
  return (text.slice(0, fcStart) + text.slice(endPos)).trim();
}

// ---------------------------------------------------------------------------
// Text-based tool call stripping (e.g. <tool_call> / <tool_result> XML blocks)
//
// When a model doesn't use structured tool-use API but sees tool instructions
// in the system prompt, it may emit text-based tool calls and hallucinated
// tool results. These must be stripped before sending to the user.
// ---------------------------------------------------------------------------

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
