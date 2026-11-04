// biome-ignore lint/suspicious/noControlCharactersInRegex: matching the ESC byte is the point
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI, '');
}

export function logLines(text: string): string[] {
  const clean = stripAnsi(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n').trimEnd();
  return clean === '' ? [] : clean.split('\n');
}
