/**
 * TaskSource interface — defines where the cluster gets tasks from.
 */

import type { TaskCandidate } from '../types';

export interface ProjectInfo {
  alias: string;
  path: string;
  type: string;
}

export interface TaskSource {
  name: string;
  poll(project: ProjectInfo): Promise<TaskCandidate[]>;
}
