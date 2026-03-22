// Reply generation pipeline types

import type { ReplyPipelineContext } from './ReplyPipelineContext';

/** A single stage in the reply generation pipeline. */
export interface ReplyStage {
  readonly name: string;
  execute(ctx: ReplyPipelineContext): Promise<void>;
}
