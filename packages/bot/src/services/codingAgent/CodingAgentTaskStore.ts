/**
 * Coding-agent task records on disk.
 *
 * The task manager keeps live tasks in memory; this keeps them after the process is gone,
 * so the WebUI can show what ran, how it went and what the CLI printed. One directory per
 * task (see `taskWorkspace.ts` for the layout), written synchronously — the manager's
 * lifecycle hooks are synchronous, and an append-only record that a floating promise can
 * reorder is worse than no record at all.
 *
 * Files rather than database rows, on the same reasoning as tickets: the volume is a
 * handful of tasks a day, the access pattern is "newest first" and "by id" with no joins,
 * and an operator can read the whole thing in Finder. It also behaves identically under
 * either configured database backend.
 */

import { appendFileSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '@/utils/logger';
import {
  renderTaskOutcome,
  renderTaskRecord,
  renderTaskState,
  TASK_EVENTS_FILE,
  TASK_OUTPUT_FILES,
  TASK_RECORD_FILE,
  TASK_STATE_FILE,
  type TaskOutputStream,
  type TaskRecordEvent,
  type TaskRecordState,
  taskDirectoryName,
  taskRecordLine,
} from './taskWorkspace';
import type { AgentTask } from './types';

/** Bounded only to turn a pathological name collision into a loud failure instead of a spin. */
const MAX_DIRECTORY_NAME_ATTEMPTS = 50;

/** How many task records `list()` returns at most. */
const DEFAULT_LIST_LIMIT = 200;

export interface TaskRecordListing extends TaskRecordState {
  /** Directory the record lives in — also the task's working directory for a workspace task. */
  directory: string;
}

export class CodingAgentTaskStore {
  constructor(private readonly root: string) {}

  /**
   * Create the task's record directory and its initial files. Returns that directory,
   * which for a workspace task also becomes the task's working directory.
   */
  create(task: AgentTask, directory: string): void {
    this.writeState(directory, task);
    writeFileSync(join(directory, TASK_RECORD_FILE), renderTaskRecord(task));
    this.appendEvent(directory, { kind: 'created', at: task.createdAt.getTime(), message: '任务创建，等待执行' });
  }

  /**
   * Claim a directory name for a task under the store's root. Created non-recursively in a
   * loop rather than after an existence check: two tasks created in the same second would
   * otherwise race their way into the same name.
   */
  claimDirectory(task: AgentTask): string {
    mkdirSync(this.root, { recursive: true });
    const base = taskDirectoryName(task.prompt, task.id, task.createdAt);

    for (let attempt = 1; attempt <= MAX_DIRECTORY_NAME_ATTEMPTS; attempt++) {
      const directory = join(this.root, attempt === 1 ? base : `${base}-${attempt}`);
      try {
        mkdirSync(directory);
        return directory;
      } catch (error) {
        if (!isAlreadyExists(error)) {
          throw error;
        }
      }
    }

    throw new Error(
      `[CodingAgentTaskStore] Could not create a task directory for ${task.id}: ` +
        `${MAX_DIRECTORY_NAME_ATTEMPTS} directories named ${base}* already exist under ${this.root}`,
    );
  }

  /** Record one lifecycle or progress event, keeping `task.json` in step with the task. */
  record(task: AgentTask, event: TaskRecordEvent): void {
    const directory = task.recordDirectory;
    if (!directory) {
      return;
    }
    try {
      this.writeState(directory, task);
      const line =
        event.kind === 'completed' || event.kind === 'failed'
          ? renderTaskOutcome(task, new Date(event.at))
          : `${taskRecordLine(new Date(event.at), event.message ?? '')}\n`;
      appendFileSync(join(directory, TASK_RECORD_FILE), line);
      this.appendEvent(directory, event);
    } catch (error) {
      logger.warn(`[CodingAgentTaskStore] Could not record ${event.kind} for task ${task.id}:`, error);
    }
  }

  /** Append raw CLI output, so a running task's transcript can be followed live. */
  appendOutput(task: AgentTask, stream: TaskOutputStream, chunk: string): void {
    const directory = task.recordDirectory;
    if (!chunk || !directory) {
      return;
    }
    try {
      appendFileSync(join(directory, TASK_OUTPUT_FILES[stream]), chunk);
    } catch (error) {
      logger.warn(`[CodingAgentTaskStore] Could not append ${stream} for task ${task.id}:`, error);
    }
  }

  /**
   * Task records, newest first. Discovery walks directory names, which start with the date,
   * so the page is drawn from the newest days; the page itself is then ordered by creation
   * time. A directory without a readable `task.json` is not a task record and is skipped.
   */
  list(limit: number = DEFAULT_LIST_LIMIT): TaskRecordListing[] {
    let names: string[];
    try {
      names = readdirSync(this.root).sort().reverse();
    } catch {
      return [];
    }

    const listings: TaskRecordListing[] = [];
    for (const name of names) {
      if (listings.length >= limit) {
        break;
      }
      const directory = join(this.root, name);
      const state = this.readState(directory);
      if (state) {
        listings.push({ ...state, directory });
      }
    }

    return listings.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** One task's record, found by its id. */
  get(taskId: string): TaskRecordListing | null {
    for (const listing of this.list(Number.MAX_SAFE_INTEGER)) {
      if (listing.id === taskId) {
        return listing;
      }
    }
    return null;
  }

  /**
   * Close records a previous process left mid-flight. Nothing survives a restart to finish
   * them, so a `running` record would otherwise claim forever that a task is still working.
   */
  closeInterruptedTasks(reason: string): number {
    let closed = 0;
    for (const listing of this.list()) {
      if (listing.status !== 'running') {
        continue;
      }
      const at = new Date();
      listing.status = 'failed';
      listing.error = reason;
      listing.finishedAt = at.toISOString();

      try {
        writeFileSync(join(listing.directory, TASK_STATE_FILE), `${JSON.stringify(listing, null, 2)}\n`);
        appendFileSync(join(listing.directory, TASK_RECORD_FILE), renderTaskOutcome(listing, at));
        this.appendEvent(listing.directory, { kind: 'failed', at: at.getTime(), message: reason });
        closed++;
      } catch (error) {
        logger.warn(`[CodingAgentTaskStore] Could not close interrupted task ${listing.id}:`, error);
      }
    }
    return closed;
  }

  /** A task's timeline, oldest first. */
  readEvents(directory: string): TaskRecordEvent[] {
    const events: TaskRecordEvent[] = [];
    for (const line of this.readText(join(directory, TASK_EVENTS_FILE)).split('\n')) {
      if (!line.trim()) {
        continue;
      }
      try {
        events.push(JSON.parse(line) as TaskRecordEvent);
      } catch {
        // A half-written trailing line after a crash; the rest of the timeline is still good.
      }
    }
    return events;
  }

  /** A task's raw transcript, both streams. */
  readOutput(directory: string): { stdout: string; stderr: string } {
    return {
      stdout: this.readText(join(directory, TASK_OUTPUT_FILES.stdout)),
      stderr: this.readText(join(directory, TASK_OUTPUT_FILES.stderr)),
    };
  }

  private writeState(directory: string, task: AgentTask): void {
    writeFileSync(join(directory, TASK_STATE_FILE), `${JSON.stringify(renderTaskState(task), null, 2)}\n`);
  }

  private appendEvent(directory: string, event: TaskRecordEvent): void {
    appendFileSync(join(directory, TASK_EVENTS_FILE), `${JSON.stringify(event)}\n`);
  }

  private readState(directory: string): TaskRecordState | null {
    try {
      if (!statSync(directory).isDirectory()) {
        return null;
      }
      return JSON.parse(this.readText(join(directory, TASK_STATE_FILE))) as TaskRecordState;
    } catch {
      return null;
    }
  }

  private readText(file: string): string {
    try {
      return readFileSync(file, 'utf8');
    } catch {
      return '';
    }
  }
}

function isAlreadyExists(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'EEXIST';
}
