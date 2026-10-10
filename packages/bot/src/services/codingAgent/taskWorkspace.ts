/**
 * Workspace task directories and the record kept inside them.
 *
 * A workspace task runs in a throwaway directory, but the directory outlives the
 * task: it holds whatever the agent produced and a `TASK.md` saying what was asked
 * and how it ended. So the directory name carries the date and a slug of the
 * request — a listing of the workspace root stays readable months later, which a
 * bare task id would not.
 */

import type { AgentTask } from './types';

/** Longest slug kept in a directory name; long enough to recognize, short enough to list. */
const MAX_SLUG_CHARS = 40;

/** Characters that cannot appear in a path segment on the platforms this runs on, plus whitespace runs to fold. */
const UNSAFE_RUN = /[\s/\\:*?"<>|\p{Cc}]+/gu;

export const TASK_RECORD_FILE = 'TASK.md';

/**
 * Directory name for a workspace task: `<YYYY-MM-DD>-<slug>`, or `<YYYY-MM-DD>-<task id>`
 * when the request has no usable slug. The caller resolves collisions by appending a
 * counter, the same way ticket ids do.
 */
export function workspaceDirectoryName(prompt: string, taskId: string, createdAt: Date): string {
  const slug = slugify(prompt) || taskId.slice(0, 8);
  return `${localDate(createdAt)}-${slug}`;
}

/** Fold a request into one path-safe segment: first line only, unsafe runs collapsed, capped. */
function slugify(prompt: string): string {
  const firstLine = prompt.split('\n', 1)[0] ?? '';
  const folded = firstLine
    .toLowerCase()
    .replace(UNSAFE_RUN, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  // Slice by code point: a cut through a surrogate pair would leave a lone half in the name.
  return [...folded]
    .slice(0, MAX_SLUG_CHARS)
    .join('')
    .replace(/[-.]+$/g, '');
}

function localDate(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function localClock(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${localDate(date)} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/**
 * The `TASK.md` a workspace task starts with: who asked for what, and an empty record
 * section that {@link taskRecordLine} appends to as the task runs.
 */
export function renderTaskRecord(task: AgentTask): string {
  const requester = task.requestedBy;
  const who =
    requester.type === 'group'
      ? `群 ${requester.id}${requester.userId ? `（用户 ${requester.userId}）` : ''}`
      : `用户 ${requester.id}`;
  const effort = task.effort ? `（强度 ${task.effort}）` : '';

  return [
    `# 工作区任务 ${task.id.slice(0, 8)}`,
    '',
    `- 任务 ID: ${task.id}`,
    `- 类型: ${task.taskType ?? 'workspace'}`,
    `- 执行者: ${task.executor}`,
    `- 模型: ${task.model}${effort}`,
    `- 请求者: ${who}`,
    `- 创建时间: ${localClock(task.createdAt)}`,
    '',
    '## 任务要求',
    '',
    task.prompt,
    '',
    '## 记录',
    '',
    taskRecordLine(task.createdAt, '任务创建，等待执行'),
    '',
  ].join('\n');
}

/** One timestamped line for the record section. */
export function taskRecordLine(at: Date, message: string): string {
  return `- ${localClock(at)} ${message}`;
}

/** The final state appended once a task stops running. */
export function renderTaskOutcome(task: AgentTask, at: Date): string {
  if (task.status === 'completed') {
    return ['', taskRecordLine(at, '执行完成'), '', '## 结果', '', task.result || '（无输出）', ''].join('\n');
  }
  return ['', taskRecordLine(at, '执行失败'), '', '## 错误', '', task.error || '（未知错误）', ''].join('\n');
}
