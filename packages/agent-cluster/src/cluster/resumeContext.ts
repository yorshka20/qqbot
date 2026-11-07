import type { TaskRecord, WorkspaceCatchUp } from './types';

const SHORT_SHA = 7;
const DESCRIPTION_CLIP = 80;
const SUMMARY_CLIP = 200;

/** How the task ended the last time, taken before the scheduler reopens it. */
export interface PreviousRun {
  status: TaskRecord['status'];
  error?: string;
  diffSummary?: string;
}

export interface ResumeChild {
  id: string;
  workerTemplate?: string;
  status: TaskRecord['status'];
  merged: boolean;
  resumable: boolean;
  description: string;
  diffSummary?: string;
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function firstLine(text: string): string {
  return (
    text
      .split('\n')
      .find((line) => line.trim())
      ?.trim() ?? ''
  );
}

/** The workspace section of the resume prompt; empty when there is nothing to tell. */
export function renderWorkspaceChanges(
  catchUp: WorkspaceCatchUp | undefined,
  integrationBranch: string | undefined,
  previous: PreviousRun | undefined,
): string {
  if (!catchUp) {
    return '';
  }
  const lines: string[] = [];
  if (catchUp.advanced) {
    lines.push(
      `你的分支已快进到 \`${integrationBranch}@${catchUp.head.slice(0, SHORT_SHA)}\`，下面的提交和改动现在都在你的工作区里。`,
    );
  } else if (catchUp.reason) {
    lines.push(
      `你的分支没有移动：${catchUp.reason}。继续之前先自己执行 \`git merge $CLUSTER_INTEGRATION_BRANCH\` 并解决冲突。`,
    );
  }
  if (catchUp.commits.length > 0) {
    lines.push('', '集成分支上新增的提交：');
    for (const commit of catchUp.commits) {
      lines.push(`- ${commit.sha.slice(0, SHORT_SHA)} ${commit.subject}`);
    }
  }
  if (catchUp.changedFiles.length > 0) {
    lines.push('', '改动的文件：');
    for (const file of catchUp.changedFiles) {
      lines.push(`- ${file}`);
    }
  }
  if (lines.length === 0 && !previous) {
    return '';
  }
  if (previous) {
    lines.push('', `你上次结束时的状态：${previous.status}`);
    if (previous.error) {
      lines.push(`错误：${previous.error}`);
    }
    if (previous.diffSummary) {
      lines.push('', '你上次的汇报：', previous.diffSummary);
    }
  }
  return ['## 你上次结束以来，工作区的变化', '', ...lines].join('\n');
}

/** The planner's children as one line each, with the hint to continue rather than respawn. */
export function renderChildren(children: ResumeChild[]): string {
  if (children.length === 0) {
    return '';
  }
  const lines = children.map((child) => {
    const parts = [
      child.id,
      child.workerTemplate ?? '-',
      child.status,
      child.merged ? '已合入' : '未合入',
      child.resumable ? '可续用' : '不可续用',
      clip(firstLine(child.description), DESCRIPTION_CLIP),
    ];
    const summary = child.diffSummary ? ` — ${clip(child.diffSummary.replace(/\s+/g, ' ').trim(), SUMMARY_CLIP)}` : '';
    return `- ${parts.join(' | ')}${summary}`;
  });
  return [
    '## 你已有的子任务',
    '',
    ...lines,
    '',
    '与某个子任务做过的事相关的后续工作，对它用 `hub_continue`，不要新建 executor。',
  ].join('\n');
}
