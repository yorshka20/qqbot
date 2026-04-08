/**
 * QueueSource — manual task queue for the cluster.
 *
 * Tasks are submitted via QQ commands or WebUI.
 */

import type { TaskCandidate } from '../types';
import type { ProjectInfo, TaskSource } from './TaskSource';

export class QueueSource implements TaskSource {
  name = 'queue';
  private queue: TaskCandidate[] = [];

  async poll(_project: ProjectInfo): Promise<TaskCandidate[]> {
    const items = this.queue.splice(0);
    return items;
  }

  /**
   * Add a task to the queue.
   */
  enqueue(candidate: TaskCandidate): void {
    this.queue.push(candidate);
  }

  /**
   * Get current queue length.
   */
  getLength(): number {
    return this.queue.length;
  }
}
