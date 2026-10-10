/**
 * The per-task record directory and the files in it.
 *
 * Every coding-agent task gets one directory, named `<YYYY-MM-DD>-<request slug>` so a
 * listing of the root still says what each one was. Inside it:
 *
 *   TASK.md       what was asked and a running record of how it went — for a person
 *   task.json     the same task's current state — for the WebUI's list and detail views
 *   events.jsonl  one line per lifecycle / progress event — the WebUI's timeline
 *   stdout.log    the CLI's raw stdout
 *   stderr.log    the CLI's raw stderr
 *
 * For a **workspace** task this directory is also the agent's working directory, so the
 * agent's own output lands beside the record and no separate archiving is needed. For a
 * dev task the directory holds only the record — the agent works in the project, and
 * writing logs into someone's repository is not an option.
 *
 * Everything here is pure formatting; `CodingAgentTaskStore` owns the filesystem.
 */

import type { AgentTask } from './types';

/** Longest slug kept in a directory name; long enough to recognize, short enough to list. */
const MAX_SLUG_CHARS = 40;

/** Characters that cannot appear in a path segment on the platforms this runs on, plus whitespace runs to fold. */
const UNSAFE_RUN = /[\s/\\:*?"<>|\p{Cc}]+/gu;

export const TASK_RECORD_FILE = 'TASK.md';
export const TASK_STATE_FILE = 'task.json';
export const TASK_EVENTS_FILE = 'events.jsonl';
export const TASK_STDOUT_FILE = 'stdout.log';
export const TASK_STDERR_FILE = 'stderr.log';

export type TaskOutputStream = 'stdout' | 'stderr';

export const TASK_OUTPUT_FILES: Record<TaskOutputStream, string> = {
  stdout: TASK_STDOUT_FILE,
  stderr: TASK_STDERR_FILE,
};

/** What the WebUI needs to list and show a task, without its transcript. */
export interface TaskRecordState {
  id: string;
  executor: string;
  model: string;
  effort?: string;
  taskType: string;
  projectAlias?: string;
  workingDirectory: string;
  prompt: string;
  requestedBy: AgentTask['requestedBy'];
  status: AgentTask['status'];
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  result?: string;
  error?: string;
}

export type TaskRecordEventKind = 'created' | 'running' | 'progress' | 'completed' | 'failed';

export interface TaskRecordEvent {
  kind: TaskRecordEventKind;
  at: number;
  /** Human-readable line, also what the record section of TASK.md gets. */
  message?: string;
  progress?: number;
}

/**
 * Directory name for a task: `<YYYY-MM-DD>-<slug>`, or `<YYYY-MM-DD>-<task id>` when the
 * request has no usable slug. The caller resolves collisions by appending a counter, the
 * same way ticket ids do.
 */
export function taskDirectoryName(prompt: string, taskId: string, createdAt: Date): string {
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
 * The `TASK.md` a task starts with: who asked for what, and an empty record section that
 * {@link taskRecordLine} appends to as the task runs.
 */
export function renderTaskRecord(task: AgentTask): string {
  const requester = task.requestedBy;
  const who =
    requester.type === 'group'
      ? `群 ${requester.id}${requester.userId ? `（用户 ${requester.userId}）` : ''}`
      : `用户 ${requester.id}`;
  const effort = task.effort ? `（强度 ${task.effort}）` : '';

  return [
    `# 任务 ${task.id.slice(0, 8)}`,
    '',
    `- 任务 ID: ${task.id}`,
    `- 类型: ${task.taskType ?? 'dev'}`,
    `- 执行者: ${task.executor}`,
    `- 模型: ${task.model}${effort}`,
    `- 请求者: ${who}`,
    `- 工作目录: ${task.workingDirectory}`,
    `- 创建时间: ${localClock(task.createdAt)}`,
    '',
    '## 任务要求',
    '',
    task.prompt,
    '',
    '## 记录',
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

/** The `task.json` body: everything the WebUI lists, minus the transcript. */
export function renderTaskState(task: AgentTask): TaskRecordState {
  return {
    id: task.id,
    executor: task.executor,
    model: task.model,
    ...(task.effort ? { effort: task.effort } : {}),
    taskType: task.taskType ?? 'dev',
    ...(task.projectContext ? { projectAlias: task.projectContext.alias } : {}),
    workingDirectory: task.workingDirectory || '',
    prompt: task.prompt,
    requestedBy: task.requestedBy,
    status: task.status,
    createdAt: task.createdAt.toISOString(),
    ...(task.startedAt ? { startedAt: task.startedAt.toISOString() } : {}),
    ...(task.finishedAt ? { finishedAt: task.finishedAt.toISOString() } : {}),
    ...(task.result !== undefined ? { result: task.result } : {}),
    ...(task.error !== undefined ? { error: task.error } : {}),
  };
}
