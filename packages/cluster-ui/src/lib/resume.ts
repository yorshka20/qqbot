function shellQuote(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

const RESUME_ARGS: Record<string, (sessionId: string) => string> = {
  'claude-cli': (sessionId) => `claude --resume ${shellQuote(sessionId)}`,
  'codex-cli': (sessionId) => `codex exec resume ${shellQuote(sessionId)}`,
};

/** A shell line that reopens the worker's own CLI session; null for a backend with no resume. */
export function resumeCommand(
  templateType: string | undefined,
  sessionId: string | undefined,
  projectPath?: string,
): string | null {
  if (!templateType || !sessionId) {
    return null;
  }
  const resume = RESUME_ARGS[templateType];
  if (!resume) {
    return null;
  }
  return projectPath ? `cd ${shellQuote(projectPath)} && ${resume(sessionId)}` : resume(sessionId);
}
