// Ids derived from the memory job that produces them.
//
// Applying a job's answer can be repeated (a crash after the facts are written but before the
// job is marked done), so whatever it creates is keyed by the job: the second pass finds the
// fact or the child job already there instead of creating a duplicate.

import { v5 as uuidv5 } from 'uuid';

const OPERATION_FACT_NAMESPACE = '7da1aaa4-4f2c-4826-a0e7-18e5ef1ce5be';
const CHILD_JOB_NAMESPACE = 'a2d00808-de83-4b13-8a8c-bba635fddc7c';

/** The fact added by the `index`-th operation of job `jobId`. */
export function operationFactId(jobId: string, index: number): string {
  return uuidv5(`${jobId}\n${index}`, OPERATION_FACT_NAMESPACE);
}

/** The consolidation job an extract job `jobId` spawns for one slot. */
export function childJobId(jobId: string, slotUserId: string): string {
  return uuidv5(`${jobId}\n${slotUserId}`, CHILD_JOB_NAMESPACE);
}
